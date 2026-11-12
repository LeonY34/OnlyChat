#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { streamChat, listModels } = require('./lib/providers');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.ONLYCHAT_PASSWORD || '';
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
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
const saveSettings = () => writeJSON(SETTINGS_FILE, settings);

function publicSettings() {
  return {
    ...settings,
    providers: settings.providers.map(({ apiKey, ...p }) => ({ ...p, keyHint: apiKey ? `••••${apiKey.slice(-4)}` : '' })),
  };
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
const index = new Map(); // id -> meta
const live = new Map(); // id -> { chat, ac } while generating

const metaOf = (c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, pinned: !!c.pinned });
for (const f of fs.readdirSync(CHAT_DIR)) {
  if (!f.endsWith('.json')) continue;
  try { const c = JSON.parse(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8')); index.set(c.id, metaOf(c)); } catch (e) { console.warn('skip broken chat', f, e.message); }
}

async function loadChat(id) {
  if (!ID_RE.test(id) || !index.has(id)) return null;
  if (live.has(id)) return live.get(id).chat;
  return JSON.parse(await fsp.readFile(path.join(CHAT_DIR, `${id}.json`), 'utf8'));
}
async function saveChat(chat) {
  index.set(chat.id, metaOf(chat));
  await writeJSON(path.join(CHAT_DIR, `${chat.id}.json`), chat);
}

const findProvider = (id) => settings.providers.find((p) => p.id === id);

async function toUpstreamMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && !m.text) continue; // failed / empty replies
    const images = [];
    for (const f of m.images || []) {
      if (!FILE_RE.test(f)) continue;
      try {
        const data = (await fsp.readFile(path.join(UPLOAD_DIR, f))).toString('base64');
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
  const target = settings.titleModel?.providerId && findProvider(settings.titleModel.providerId)
    ? settings.titleModel : { providerId: chat.providerId, model: chat.model };
  const provider = findProvider(target.providerId);
  if (!provider || !target.model) return null;
  const user = chat.messages.find((m) => m.role === 'user');
  const asst = chat.messages.find((m) => m.role === 'assistant' && m.text);
  const convo = `用户：${(user?.text || '[图片]').slice(0, 1500)}\n\n助手：${(asst?.text || '').slice(0, 1500)}`;
  let text = '';
  await streamChat({
    provider,
    model: target.model,
    maxTokens: 2048,
    messages: [{
      role: 'user',
      images: [],
      text: `为下面这段对话起一个简短的标题（不超过 15 个字或 8 个英文单词），使用对话所用的语言。只输出标题本身，不要加引号、标点或任何解释。\n\n<conversation>\n${convo}\n</conversation>`,
    }],
    signal: AbortSignal.timeout(60000),
    emit: (ev) => { if (ev.type === 'text') text += ev.delta; },
  });
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

const authToken = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('onlychat-session').digest('hex') : '';
function isAuthed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)oc_session=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && m[1].length === authToken.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(authToken));
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

  const asst = { id: uid(), role: 'assistant', text: '', reasoning: '', sources: [], model: chat.model, createdAt: Date.now() };
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
      system: settings.systemPrompt,
      messages: await toUpstreamMessages(history),
      webSearch: !!chat.webSearch,
      thinking: !!chat.thinking,
      maxTokens: settings.maxTokens,
      signal: ac.signal,
      emit: (ev) => {
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

// ---------------- router ----------------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') return sendJSON(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, p);
  }

  if (p === '/api/login' && m === 'POST') {
    const { password } = await readJSON(req);
    if (PASSWORD && password !== PASSWORD) return sendJSON(res, 401, { error: '密码错误' });
    res.setHeader('set-cookie', `oc_session=${authToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return sendJSON(res, 200, { ok: true });
  }
  if (!isAuthed(req)) return sendJSON(res, 401, { error: 'unauthorized', needLogin: true });
  if (p === '/api/me') return sendJSON(res, 200, { ok: true, auth: !!PASSWORD });

  // settings
  if (p === '/api/settings' && m === 'GET') return sendJSON(res, 200, publicSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readJSON(req);
    if (Array.isArray(b.providers)) {
      settings.providers = b.providers.map((np) => cleanProvider(np, findProvider(np.id)));
    }
    for (const k of ['defaultModel', 'titleModel']) if (k in b) settings[k] = b[k] && b[k].providerId ? { providerId: String(b[k].providerId), model: String(b[k].model || '') } : null;
    if (typeof b.systemPrompt === 'string') settings.systemPrompt = b.systemPrompt;
    if (b.maxTokens !== undefined) settings.maxTokens = Math.max(256, Math.min(200000, Number(b.maxTokens) || 32000));
    await saveSettings();
    return sendJSON(res, 200, publicSettings());
  }
  if (p === '/api/models' && m === 'POST') { // fetch model list for a (possibly unsaved) provider
    const b = await readJSON(req);
    const old = findProvider(b.id);
    const prov = { type: b.type, baseURL: b.baseURL, apiKey: typeof b.apiKey === 'string' && b.apiKey ? b.apiKey : old?.apiKey || '' };
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
    await fsp.writeFile(path.join(UPLOAD_DIR, name), Buffer.concat(chunks));
    return sendJSON(res, 200, { file: name });
  }
  let mm;
  if ((mm = /^\/api\/files\/([^/]+)$/.exec(p)) && m === 'GET') {
    if (!FILE_RE.test(mm[1])) return sendJSON(res, 404, { error: 'not found' });
    const file = path.join(UPLOAD_DIR, mm[1]);
    try {
      const st = await fsp.stat(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'content-length': st.size, 'cache-control': 'private, max-age=31536000, immutable' });
      return fs.createReadStream(file).pipe(res);
    } catch { return sendJSON(res, 404, { error: 'not found' }); }
  }

  // chats
  if (p === '/api/chats' && m === 'GET') {
    const list = [...index.values()].map((c) => ({ ...c, generating: live.has(c.id) }))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    return sendJSON(res, 200, list);
  }
  if (p === '/api/chats' && m === 'POST') {
    const b = await readJSON(req);
    const now = Date.now();
    const chat = {
      id: uid(), title: '新对话', titleGenerated: false, createdAt: now, updatedAt: now,
      providerId: String(b.providerId || ''), model: String(b.model || ''),
      webSearch: !!b.webSearch, thinking: !!b.thinking, messages: [],
    };
    await saveChat(chat);
    return sendJSON(res, 200, chat);
  }
  if ((mm = /^\/api\/chats\/([^/]+)(\/[a-z]+)?$/.exec(p))) {
    const chat = await loadChat(mm[1]);
    if (!chat) return sendJSON(res, 404, { error: '会话不存在' });
    const sub = mm[2] || '';
    if (!sub && m === 'GET') return sendJSON(res, 200, { ...chat, generating: live.has(chat.id) });
    if (!sub && m === 'PATCH') {
      const b = await readJSON(req);
      if (typeof b.title === 'string' && b.title.trim()) { chat.title = b.title.trim().slice(0, 80); chat.titleGenerated = true; }
      if (typeof b.providerId === 'string') chat.providerId = b.providerId;
      if (typeof b.model === 'string') chat.model = b.model;
      if (typeof b.webSearch === 'boolean') chat.webSearch = b.webSearch;
      if (typeof b.thinking === 'boolean') chat.thinking = b.thinking;
      if (typeof b.pinned === 'boolean') chat.pinned = b.pinned;
      if (typeof b.deleteMessage === 'string' && !live.has(chat.id)) chat.messages = chat.messages.filter((x) => x.id !== b.deleteMessage);
      await saveChat(chat);
      return sendJSON(res, 200, metaOf(chat));
    }
    if (!sub && m === 'DELETE') {
      live.get(chat.id)?.ac.abort();
      index.delete(chat.id);
      await fsp.rm(path.join(CHAT_DIR, `${chat.id}.json`), { force: true });
      for (const msg of chat.messages) for (const f of msg.images || []) {
        if (FILE_RE.test(f)) await fsp.rm(path.join(UPLOAD_DIR, f), { force: true });
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === '/messages' && m === 'POST') return handleSend(req, res, chat, await readJSON(req));
    if (sub === '/stop' && m === 'POST') { live.get(chat.id)?.ac.abort(); return sendJSON(res, 200, { ok: true }); }
  }
  return sendJSON(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
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
