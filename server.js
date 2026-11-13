#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { streamChat, listModels } = require('./lib/providers');
const { levelsFor, ALL_EFFORTS, effortRulesForClient } = require('./lib/efforts');
const { Accounts } = require('./lib/accounts');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.ONLYCHAT_PASSWORD || '';
const CANONICAL_URL = (process.env.CANONICAL_URL || '').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHAT_DIR = path.join(DATA_DIR, 'chats');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MAX_UPLOAD = 20 * 1024 * 1024;

fs.mkdirSync(CHAT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uid = () => Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
const ID_RE = /^[a-z0-9]{8,40}$/;
const FILE_RE = /^[a-z0-9]{8,40}\.(png|jpg|webp|gif)$/;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

async function writeJSON(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

// ---------------- settings ----------------
const DEFAULT_SETTINGS = {
  providers: [], // { id, name, type: openai|openai-responses|anthropic, baseURL, apiKey, models: [], extraBody?, searchBody? }
  defaultModel: null, // { providerId, model }
  titleModel: null, // { providerId, model } or null = same as chat
  systemPrompt: '',
  maxTokens: 32000,
};
let legacySettings = { ...DEFAULT_SETTINGS };
if (fs.existsSync(SETTINGS_FILE)) legacySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
const accounts = new Accounts(DATA_DIR, { ...DEFAULT_SETTINGS, providers: undefined });
const currentUser = () => context.getStore();
const userSettings = () => currentUser().settings;
const ready = accounts.bootstrap(legacySettings, PASSWORD).then(async (ownerId) => {
  for (const f of fs.readdirSync(CHAT_DIR)) {
    if (!/^[a-z0-9]{8,40}\.json$/.test(f)) continue;
    const file = path.join(CHAT_DIR, f), chat = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!chat.ownerId) { chat.ownerId = ownerId; await writeJSON(file, chat); }
    index.set(chat.id, metaOf(chat));
  }
  // Move legacy uploads into the initial owner's namespace before removing plaintext userSettings().
  const dir = path.join(UPLOAD_DIR, ownerId); await fsp.mkdir(dir, { recursive: true });
  for (const f of await fsp.readdir(UPLOAD_DIR)) if (FILE_RE.test(f)) await fsp.rename(path.join(UPLOAD_DIR, f), path.join(dir, f));
  await fsp.rm(SETTINGS_FILE, { force: true });
});
const uploadDir = () => path.join(UPLOAD_DIR, currentUser().id);
function publicSettings() {
  return { ...userSettings(), effortRules: effortRulesForClient(), providers: accounts.visible(currentUser()) };
}

function cleanProvider(p, old) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
  return {
    id: ID_RE.test(p.id || '') ? p.id : uid(),
    name: String(p.name || '未命名').slice(0, 60),
    type: ['openai', 'openai-responses', 'anthropic'].includes(p.type) ? p.type : 'openai',
    baseURL: String(p.baseURL || '').trim(),
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : old?.apiKey || '',
    models: [...new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m).trim()).filter(Boolean))],
    extraBody: obj(p.extraBody),
    searchBody: obj(p.searchBody),
  };
}

// ---------------- chats ----------------
const EFFORTS = ALL_EFFORTS;
// Effort must be one the chat's model supports, otherwise it falls back to off.
const resolveEffort = (model, e) => (levelsFor(model).includes(e) ? e : 'off');
// Old chats only have the boolean `thinking`; true meant on, and high exists on every model.
const chatEffort = (c) => resolveEffort(c.model, c.effort ?? (c.thinking ? 'high' : 'off'));
const index = new Map(); // id -> meta
const live = new Map(); // id -> { chat, ac } while generating

const metaOf = (c) => ({ id: c.id, ownerId: c.ownerId, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, pinned: !!c.pinned });

async function loadChat(id) {
  if (!ID_RE.test(id) || index.get(id)?.ownerId !== currentUser().id) return null;
  if (live.has(id)) return live.get(id).chat;
  return JSON.parse(await fsp.readFile(path.join(CHAT_DIR, `${id}.json`), 'utf8'));
}
async function saveChat(chat) {
  index.set(chat.id, metaOf(chat));
  await writeJSON(path.join(CHAT_DIR, `${chat.id}.json`), chat);
}

const findProvider = (id) => accounts.provider(currentUser(), id);

async function toUpstreamMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && !m.text) continue; // failed / empty replies
    const images = [];
    for (const f of m.images || []) {
      if (!FILE_RE.test(f)) continue;
      try {
        const data = (await fsp.readFile(path.join(uploadDir(), f))).toString('base64');
        images.push({ mime: MIME[path.extname(f)], data });
      } catch {}
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) { // keep strict user/assistant alternation
      prev.text = [prev.text, m.text].filter(Boolean).join('\n\n');
      prev.images.push(...images);
    } else out.push({ role: m.role, text: m.text || '', images });
  }
  return out;
}

function mergeSources(list, items) {
  for (const it of items || []) {
    if (!it?.url) continue;
    const ex = list.find((s) => s.url === it.url);
    if (ex) { if (!ex.title && it.title) ex.title = it.title; } else list.push({ url: it.url, title: it.title || '' });
  }
}

function cleanTitle(s) {
  s = String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^(标题|title)\s*[:：]\s*/i, '').replace(/^[#*\s"'“”‘’「」《》]+|[*\s"'“”‘’「」《》。.!！]+$/g, '');
  return s.slice(0, 40);
}

async function generateTitle(chat) {
  const target = userSettings().titleModel?.providerId && findProvider(userSettings().titleModel.providerId)
    ? userSettings().titleModel : { providerId: chat.providerId, model: chat.model };
  const provider = findProvider(target.providerId);
  if (!provider || !target.model) return null;
  const user = chat.messages.find((m) => m.role === 'user');
  const asst = chat.messages.find((m) => m.role === 'assistant' && m.text);
  const convo = `用户：${(user?.text || '[图片]').slice(0, 1500)}\n\n助手：${(asst?.text || '').slice(0, 1500)}`;
  let text = '', titleUsage;
  try { await streamChat({
    provider,
    model: target.model,
    maxTokens: 2048,
    messages: [{
      role: 'user',
      images: [],
      text: `为下面这段对话起一个简短的标题（不超过 15 个字或 8 个英文单词），使用对话所用的语言。只输出标题本身，不要加引号、标点或任何解释。\n\n<conversation>\n${convo}\n</conversation>`,
    }],
    signal: AbortSignal.timeout(60000),
    emit: (ev) => { if (ev.type === 'text') text += ev.delta; else if (ev.type === 'usage') titleUsage = ev.usage; },
  }).then(result => { titleUsage = result?.usage || titleUsage; }); }
  finally { accounts.record(currentUser(), provider, titleUsage); }
  return cleanTitle(text);
}

// ---------------- http helpers ----------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
async function readJSON(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
}


async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    sendJSON(res, 404, { error: 'not found' });
  }
}

// ---------------- generation ----------------
async function handleSend(req, res, chat, body) {
  if (live.has(chat.id)) return sendJSON(res, 409, { error: '该会话正在生成中' });
  const provider = findProvider(chat.providerId);
  if (!provider || !chat.model) return sendJSON(res, 400, { error: '请先选择模型' });

  if (body.regenerate) {
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
  } else {
    if (body.editFrom) {
      const i = chat.messages.findIndex((m) => m.id === body.editFrom);
      if (i >= 0) chat.messages.splice(i);
    }
    const text = String(body.text || '');
    const images = (Array.isArray(body.images) ? body.images : []).filter((f) => FILE_RE.test(f)).slice(0, 10);
    if (!text.trim() && !images.length) return sendJSON(res, 400, { error: '消息为空' });
    chat.messages.push({ id: uid(), role: 'user', text, images, createdAt: Date.now() });
    if (!chat.titleGenerated && chat.messages.length === 1) chat.title = text.trim().slice(0, 30) || '图片对话';
  }
  if (chat.messages[chat.messages.length - 1]?.role !== 'user') return sendJSON(res, 400, { error: '没有可回复的消息' });

  const asst = { id: uid(), role: 'assistant', text: '', reasoning: '', sources: [], providerId: provider.id, model: chat.model, createdAt: Date.now() };
  const history = chat.messages.slice();
  chat.messages.push(asst);
  chat.updatedAt = Date.now();
  const ac = new AbortController();
  live.set(chat.id, { chat, ac });
  await saveChat(chat);

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  send({ type: 'start', chat: { ...chat, generating: true } });
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  // Generation keeps running if the browser disconnects; it's saved either way. Stop via /stop.

  const t0 = Date.now();
  try {
    const result = await streamChat({
      provider,
      model: chat.model,
      system: userSettings().systemPrompt,
      messages: await toUpstreamMessages(history),
      webSearch: !!chat.webSearch,
      effort: chatEffort(chat),
      maxTokens: userSettings().maxTokens,
      signal: ac.signal,
      emit: (ev) => {
        if (ev.type === 'usage') { asst.usage = ev.usage; return; }
        if (ev.type === 'text') asst.text += ev.delta;
        else if (ev.type === 'reasoning') asst.reasoning += ev.delta;
        else if (ev.type === 'status') asst.status = ev.text;
        else if (ev.type === 'sources') { mergeSources(asst.sources, ev.items); ev = { type: 'sources', items: asst.sources }; }
        send(ev);
      },
    });
    if (result?.usage) asst.usage = result.usage;
  } catch (e) {
    if (ac.signal.aborted) asst.stopped = true;
    else { asst.error = e.message || String(e); console.warn(`[chat ${chat.id}]`, asst.error); }
  }
  accounts.record(currentUser(), provider, asst.usage);
  clearInterval(ping);
  delete asst.status;
  asst.reasoning = asst.reasoning.trim();
  asst.duration = Date.now() - t0;
  chat.updatedAt = Date.now();
  live.delete(chat.id);
  await saveChat(chat).catch((e) => console.error('save failed', e));
  send({ type: 'done', message: asst });

  if (!chat.titleGenerated && asst.text && !asst.error) {
    chat.titleGenerated = true;
    try {
      const title = await generateTitle(chat);
      if (title) {
        const fresh = await loadChat(chat.id); // may have changed meanwhile
        if (fresh) { fresh.title = title; fresh.titleGenerated = true; await saveChat(fresh); }
        send({ type: 'title', title });
      }
    } catch (e) { console.warn('title generation failed:', e.message); }
  }
  res.end();
}

async function exportChats(res, ids) {
  const chats = [], files = {};
  for (const id of ids) {
    const chat = await loadChat(id); if (!chat) continue;
    const { ownerId, ...portable } = chat; chats.push(portable);
    for (const msg of chat.messages) for (const name of msg.images || []) {
      if (FILE_RE.test(name) && !files[name]) {
        try { files[name] = (await fsp.readFile(path.join(uploadDir(), name))).toString('base64'); } catch {}
      }
    }
  }
  res.setHeader('content-disposition', 'attachment; filename="onlychat-chats.json"');
  return sendJSON(res, 200, { format: 'onlychat', version: 1, chats, files });
}
async function importChats(req, res) {
  const b = await readJSON(req, 100 * 1024 * 1024);
  if (b.format !== 'onlychat' || b.version !== 1 || !Array.isArray(b.chats) || b.chats.length > 10000 || !b.files || typeof b.files !== 'object' || Array.isArray(b.files)) return sendJSON(res, 400, { error: '无效的 OnlyChat 导出文件（最大 100MB）' });
  const user = currentUser(), files = new Map(), pending = [], chats = [];
  for (const [name, data] of Object.entries(b.files)) {
    if (!FILE_RE.test(name) || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Object.assign(new Error('附件格式错误'), { status: 400 });
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_UPLOAD) throw Object.assign(new Error('单个附件不能超过 20MB'), { status: 413 });
    const fresh = uid() + path.extname(name); files.set(name, fresh); pending.push([fresh, buffer]);
  }
  for (const c of b.chats) {
    if (!c || !Array.isArray(c.messages) || c.messages.length > 100000) throw Object.assign(new Error('会话格式错误'), { status: 400 });
    const now = Date.now();
    const chat = { id: uid(), ownerId: user.id, title: String(c.title || '导入的对话').slice(0, 80), titleGenerated: true,
      createdAt: Number.isFinite(c.createdAt) ? c.createdAt : now, updatedAt: now, pinned: !!c.pinned,
      providerId: findProvider(c.providerId)?.id || '', model: String(c.model || ''), webSearch: !!c.webSearch, effort: EFFORTS.includes(c.effort) ? c.effort : 'off', messages: [] };
    for (const m of c.messages) {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') throw Object.assign(new Error('消息格式错误'), { status: 400 });
      const images = (Array.isArray(m.images) ? m.images : []).map(name => {
        if (!files.has(name)) throw Object.assign(new Error('导入文件缺少图片附件'), { status: 400 });
        return files.get(name);
      });
      const usage = {};
      for (const k of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'total_tokens']) {
        if (Number.isFinite(m.usage?.[k]) && m.usage[k] >= 0) usage[k] = m.usage[k];
      }
      for (const k of ['prompt_tokens_details', 'input_tokens_details']) if (Number.isFinite(m.usage?.[k]?.cached_tokens) && m.usage[k].cached_tokens >= 0) usage[k] = { cached_tokens: m.usage[k].cached_tokens };
      chat.messages.push({ id: uid(), role: m.role, text: m.text, reasoning: typeof m.reasoning === 'string' ? m.reasoning : '', images, usage: Object.keys(usage).length ? usage : undefined,
        duration: Number.isFinite(m.duration) && m.duration >= 0 ? m.duration : undefined, stopped: !!m.stopped, error: typeof m.error === 'string' ? m.error : undefined,
        createdAt: Number.isFinite(m.createdAt) ? m.createdAt : now, model: String(m.model || ''),
        sources: (Array.isArray(m.sources) ? m.sources : []).filter(s => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)).map(s => ({ url: s.url, title: String(s.title || '') })) });
    }
    chats.push(chat);
  }
  await fsp.mkdir(uploadDir(), { recursive: true });
  for (const [name, buffer] of pending) await fsp.writeFile(path.join(uploadDir(), name), buffer);
  for (const chat of chats) await saveChat(chat);
  return sendJSON(res, 200, { ok: true, imported: chats.length });
}

// ---------------- router ----------------
async function route(req, res) {
  // Short-name access (e.g. http://myhost via MagicDNS) → redirect to the canonical HTTPS URL.
  if (CANONICAL_URL) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host && !host.includes('.') && !host.includes(':') && host !== 'localhost') {
      res.writeHead(301, { location: CANONICAL_URL + req.url });
      return res.end();
    }
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') return sendJSON(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, p);
  }

  if (!['GET', 'HEAD'].includes(m) && req.headers.origin) {
    const origin = new URL(req.headers.origin);
    if (origin.host !== req.headers.host && origin.origin !== CANONICAL_URL) return sendJSON(res, 403, { error: '跨站请求被拒绝' });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJSON(req);
    const result = await accounts.login(req, b.username, b.password);
    res.setHeader('set-cookie', accounts.cookie(req, result.token, 30 * 86400));
    return sendJSON(res, 200, { user: result.user });
  }
  const user = accounts.user(req);
  if (!user) return sendJSON(res, 401, { error: 'unauthorized', needLogin: true });
  return context.run(user, () => authenticated(req, res, p, m));
}

async function authenticated(req, res, p, m) {
  const user = currentUser();
  if (p === '/api/me') return sendJSON(res, 200, { user: accounts.publicUser(user) });
  if (p === '/api/logout' && m === 'POST') {
    accounts.logout(req); res.setHeader('set-cookie', accounts.cookie(req, '', 0));
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/password' && m === 'POST') {
    const b = await readJSON(req); await accounts.changePassword(user, b.currentPassword, b.password);
    res.setHeader('set-cookie', accounts.cookie(req, '', 0)); return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/usage' && m === 'GET') return sendJSON(res, 200, accounts.leaderboard());
  if (p === '/api/users' || /^\/api\/users\/[^/]+\/promote$/.test(p)) {
    if (user.role !== 'admin') return sendJSON(res, 403, { error: '仅管理员可操作' });
    if (p === '/api/users' && m === 'GET') return sendJSON(res, 200, accounts.data.users.map(u => accounts.publicUser(u)));
    if (p === '/api/users' && m === 'POST') {
      const b = await readJSON(req); return sendJSON(res, 201, await accounts.create(b.username, b.password));
    }
    if (m === 'POST' && p.endsWith('/promote')) {
      const target = accounts.data.users.find(u => u.id === p.split('/')[3]);
      if (!target) return sendJSON(res, 404, { error: '用户不存在' });
      target.role = 'admin'; accounts.save(); return sendJSON(res, 200, { user: accounts.publicUser(target) });
    }
  }
  const secretMatch = /^\/api\/providers\/([^/]+)\/secret$/.exec(p);
  if (secretMatch && m === 'GET') {
    const provider = accounts.data.providers.find(x => x.id === secretMatch[1] && x.ownerId === user.id);
    if (!provider) return sendJSON(res, 404, { error: 'Key 不存在' });
    return sendJSON(res, 200, { apiKey: accounts.decrypt(provider.secret) });
  }
  if (p === '/api/export' && m === 'GET') return exportChats(res, [...index.values()].filter(c => c.ownerId === user.id).map(c => c.id));
  if (p === '/api/import' && m === 'POST') return importChats(req, res);

  // settings
  if (p === '/api/settings' && m === 'GET') return sendJSON(res, 200, publicSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readJSON(req);
    if (Array.isArray(b.providers)) {
      const seen = new Set();
      const updated = b.providers.map(np => {
        if (!np || typeof np !== 'object') throw Object.assign(new Error('Key 格式错误'), { status: 400 });
        const old = accounts.data.providers.find(p => p.id === np.id);
        if (old && old.ownerId !== user.id) throw Object.assign(new Error('不能修改他人的 Key'), { status: 403 });
        if (seen.has(np.id)) throw Object.assign(new Error('重复的 Key'), { status: 400 });
        seen.add(np.id);
        if (old && 'shared' in np && !!np.shared !== old.shared) throw Object.assign(new Error('共享属性创建后不可修改'), { status: 400 });
        const clean = cleanProvider(np, old ? { apiKey: accounts.decrypt(old.secret) } : null);
        delete clean.apiKey;
        return { ...clean, id: old?.id || uid(), ownerId: user.id, shared: old ? old.shared : !!np.shared, disabled: !!np.disabled,
          secret: accounts.encrypt(typeof np.apiKey === 'string' && np.apiKey.trim() ? np.apiKey.trim() : old ? accounts.decrypt(old.secret) : '') };
      });
      accounts.data.providers = accounts.data.providers.map(p => p.ownerId === user.id ? (updated.find(x => x.id === p.id) || { ...p, disabled: true }) : p);
      accounts.data.providers.push(...updated.filter(p => !accounts.data.providers.some(x => x.id === p.id)));
    }
    for (const k of ['defaultModel', 'titleModel']) if (k in b) userSettings()[k] = b[k] && b[k].providerId ? { providerId: String(b[k].providerId), model: String(b[k].model || '') } : null;
    if (typeof b.systemPrompt === 'string') userSettings().systemPrompt = b.systemPrompt;
    if (b.maxTokens !== undefined) userSettings().maxTokens = Math.max(256, Math.min(200000, Number(b.maxTokens) || 32000));
    accounts.save();
    return sendJSON(res, 200, publicSettings());
  }
  if (p === '/api/models' && m === 'POST') { // fetch model list for a (possibly unsaved) provider
    const b = await readJSON(req);
    const old = accounts.data.providers.find(p => p.id === b.id);
    if (old && old.ownerId !== user.id) return sendJSON(res, 403, { error: '只能管理自己的 Key' });
    const prov = { type: b.type || old?.type, baseURL: b.baseURL || old?.baseURL, apiKey: typeof b.apiKey === 'string' && b.apiKey ? b.apiKey : old ? accounts.decrypt(old.secret) : '' };
    try { return sendJSON(res, 200, { models: await listModels(prov) }); } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  // uploads
  if (p === '/api/upload' && m === 'POST') {
    const ext = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) return sendJSON(res, 415, { error: '仅支持 png/jpeg/webp/gif 图片' });
    const name = `${uid()}.${ext}`;
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) return sendJSON(res, 413, { error: '图片不能超过 20MB' });
      chunks.push(c);
    }
    await fsp.mkdir(uploadDir(), { recursive: true });
    await fsp.writeFile(path.join(uploadDir(), name), Buffer.concat(chunks));
    return sendJSON(res, 200, { file: name });
  }
  let mm;
  if ((mm = /^\/api\/files\/([^/]+)$/.exec(p)) && m === 'GET') {
    if (!FILE_RE.test(mm[1])) return sendJSON(res, 404, { error: 'not found' });
    const file = path.join(uploadDir(), mm[1]);
    try {
      const st = await fsp.stat(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'content-length': st.size, 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    } catch { return sendJSON(res, 404, { error: 'not found' }); }
  }

  // chats
  if (p === '/api/chats' && m === 'GET') {
    const list = [...index.values()].filter(c => c.ownerId === user.id).map((c) => ({ ...c, generating: live.has(c.id) }))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    return sendJSON(res, 200, list);
  }
  if (p === '/api/chats' && m === 'POST') {
    const b = await readJSON(req);
    const now = Date.now();
    const chat = {
      id: uid(), ownerId: user.id, title: '新对话', titleGenerated: false, createdAt: now, updatedAt: now,
      providerId: String(b.providerId || ''), model: String(b.model || ''),
      webSearch: !!b.webSearch, effort: EFFORTS.includes(b.effort) ? b.effort : 'off', messages: [],
    };
    await saveChat(chat);
    return sendJSON(res, 200, chat);
  }
  if ((mm = /^\/api\/chats\/([^/]+)(\/[a-z]+)?$/.exec(p))) {
    const chat = await loadChat(mm[1]);
    if (!chat) return sendJSON(res, 404, { error: '会话不存在' });
    const sub = mm[2] || '';
    if (sub === '/export' && m === 'GET') return exportChats(res, [chat.id]);
    if (!sub && m === 'GET') return sendJSON(res, 200, { ...chat, generating: live.has(chat.id) });
    if (!sub && m === 'PATCH') {
      const b = await readJSON(req);
      if (typeof b.title === 'string' && b.title.trim()) { chat.title = b.title.trim().slice(0, 80); chat.titleGenerated = true; }
      if (typeof b.providerId === 'string') chat.providerId = b.providerId;
      if (typeof b.model === 'string') chat.model = b.model;
      if (typeof b.webSearch === 'boolean') chat.webSearch = b.webSearch;
      if (EFFORTS.includes(b.effort)) chat.effort = b.effort;
      if (typeof b.pinned === 'boolean') chat.pinned = b.pinned;
      if (typeof b.deleteMessage === 'string' && !live.has(chat.id)) chat.messages = chat.messages.filter((x) => x.id !== b.deleteMessage);
      await saveChat(chat);
      return sendJSON(res, 200, metaOf(chat));
    }
    if (!sub && m === 'DELETE') {
      if (live.has(chat.id)) return sendJSON(res, 409, { error: '请先停止生成，再删除会话' });
      index.delete(chat.id);
      await fsp.rm(path.join(CHAT_DIR, `${chat.id}.json`), { force: true });
      for (const msg of chat.messages) for (const f of msg.images || []) {
        if (FILE_RE.test(f)) await fsp.rm(path.join(uploadDir(), f), { force: true });
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === '/messages' && m === 'POST') return handleSend(req, res, chat, await readJSON(req));
    if (sub === '/stop' && m === 'POST') { live.get(chat.id)?.ac.abort(); return sendJSON(res, 200, { ok: true }); }
  }
  return sendJSON(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  ready.then(() => route(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: e.message || 'internal error' });
    else res.end();
  });
});
server.requestTimeout = 0; // long streams
server.listen(PORT, HOST, () => console.log(`OnlyChat listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`));

const shutdown = () => {
  for (const { ac } of live.values()) ac.abort();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
