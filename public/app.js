'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Date.now().toString(36) + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
const isTouch = matchMedia('(pointer: coarse)').matches;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const state = {
  settings: { providers: [] },
  chats: [], // meta list
  chat: null, // currently open full chat (null = new, unsaved chat)
  streams: new Map(), // chatId -> chat object being streamed in this tab
  attachments: [], // { key, url, file|null }
  editing: null,
  opts: lsGet('oc_opts', { webSearch: false, thinking: false }),
};

const els = {
  app: $('#app'), list: $('#chatList'), search: $('#search'), messages: $('#messages'), input: $('#input'),
  send: $('#sendBtn'), model: $('#modelSelect'), title: $('#chatTitle'), att: $('#attachments'),
  searchT: $('#searchToggle'), thinkT: $('#thinkToggle'), file: $('#fileInput'), editingBar: $('#editingBar'),
};

// ---------------- markdown ----------------
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});
function renderMarkdown(el, text, final) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  for (const code of el.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const lang = (/language-([\w+#.-]+)/.exec(code.className) || [])[1];
    if (final) {
      try {
        if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
        else if (code.textContent.length < 20000) { code.innerHTML = hljs.highlightAuto(code.textContent).value; code.classList.add('hljs'); }
      } catch {}
    }
    const btn = document.createElement('button');
    btn.className = 'copy'; btn.textContent = '复制';
    btn.onclick = () => copyText(code.textContent, btn);
    pre.append(btn);
    if (lang) { const l = document.createElement('span'); l.className = 'lang'; l.textContent = lang; pre.append(l); }
  }
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1200); }
}

// ---------------- api ----------------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.needLogin) { showLogin(); throw new Error('需要登录'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------------- models ----------------
const selKey = (pid, model) => `${pid}::${model}`;
const parseSel = (v) => { const i = v.indexOf('::'); return i < 0 ? null : { providerId: v.slice(0, i), model: v.slice(i + 2) }; };
function modelOptions(selected, extraFirst) {
  let html = extraFirst || '';
  let found = !selected;
  for (const p of state.settings.providers) {
    if (!p.models.length) continue;
    html += `<optgroup label="${esc(p.name)}">`;
    for (const m of p.models) {
      const k = selKey(p.id, m);
      if (k === selected) found = true;
      html += `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(m)}</option>`;
    }
    html += '</optgroup>';
  }
  if (!found && selected) { const s = parseSel(selected); html = `<option value="${esc(selected)}" selected>${esc(s?.model)}（已移除）</option>${html}`; }
  return html;
}
function currentSel() {
  const c = state.chat;
  if (c?.providerId && c.model) return { providerId: c.providerId, model: c.model };
  const d = state.settings.defaultModel;
  const p = d && state.settings.providers.find((x) => x.id === d.providerId);
  if (p && p.models.includes(d.model)) return d;
  const first = state.settings.providers.find((x) => x.models.length);
  return first ? { providerId: first.id, model: first.models[0] } : null;
}
function renderModelSelect() {
  const s = currentSel();
  els.model.innerHTML = modelOptions(s && selKey(s.providerId, s.model)) || '<option value="">请先在设置中添加模型</option>';
}
els.model.onchange = async () => {
  const s = parseSel(els.model.value);
  if (!s) return;
  if (state.chat) { Object.assign(state.chat, s); api('PATCH', `/api/chats/${state.chat.id}`, s).catch(alertErr); }
  state.settings.defaultModel = s;
  api('PUT', '/api/settings', { defaultModel: s }).catch(() => {});
};

// ---------------- toggles ----------------
function renderToggles() {
  const src = state.chat || state.opts;
  els.searchT.classList.toggle('on', !!src.webSearch);
  els.thinkT.classList.toggle('on', !!src.thinking);
}
for (const [btn, key] of [[els.searchT, 'webSearch'], [els.thinkT, 'thinking']]) {
  btn.onclick = () => {
    const v = !(state.chat || state.opts)[key];
    state.opts[key] = v; lsSet('oc_opts', state.opts);
    if (state.chat) { state.chat[key] = v; api('PATCH', `/api/chats/${state.chat.id}`, { [key]: v }).catch(alertErr); }
    renderToggles();
  };
}

// ---------------- chat list ----------------
function renderChatList() {
  const q = els.search.value.trim().toLowerCase();
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groupOf = (c) => (c.pinned ? '置顶' : c.updatedAt >= today ? '今天' : c.updatedAt >= today - 864e5 ? '昨天' : c.updatedAt >= today - 7 * 864e5 ? '7 天内' : c.updatedAt >= today - 30 * 864e5 ? '30 天内' : '更早');
  let html = ''; let last = '';
  for (const c of state.chats) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    const g = groupOf(c);
    if (g !== last) { html += `<div class="group-label">${g}</div>`; last = g; }
    const gen = c.generating || state.streams.has(c.id);
    html += `<div class="chat-item${state.chat?.id === c.id ? ' active' : ''}" data-id="${c.id}">
      ${gen ? '<span class="dot"></span>' : ''}<span class="t" title="${esc(c.title)}">${esc(c.title)}</span>
      <span class="ops"><button data-op="pin" title="${c.pinned ? '取消置顶' : '置顶'}">${c.pinned ? '📌' : '⇡'}</button><button data-op="rename" title="重命名">✎</button><button data-op="del" title="删除">✕</button></span></div>`;
  }
  els.list.innerHTML = html || `<div class="group-label">${q ? '无匹配会话' : '暂无会话'}</div>`;
}
els.search.oninput = renderChatList;
els.list.onclick = async (e) => {
  const item = e.target.closest('.chat-item');
  if (!item) return;
  const id = item.dataset.id;
  const meta = state.chats.find((c) => c.id === id);
  const op = e.target.closest('button')?.dataset.op;
  if (op === 'del') {
    if (!confirm(`删除会话「${meta.title}」？`)) return;
    await api('DELETE', `/api/chats/${id}`).catch(alertErr);
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.chat?.id === id) newChat(); else renderChatList();
  } else if (op === 'rename') {
    const t = prompt('重命名会话', meta.title);
    if (!t?.trim()) return;
    await api('PATCH', `/api/chats/${id}`, { title: t.trim() }).catch(alertErr);
    setTitle(id, t.trim());
  } else if (op === 'pin') {
    meta.pinned = !meta.pinned;
    await api('PATCH', `/api/chats/${id}`, { pinned: meta.pinned }).catch(alertErr);
    sortChats(); renderChatList();
  } else openChat(id);
};
const sortChats = () => state.chats.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
function upsertMeta(chat) {
  const m = { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, pinned: !!chat.pinned, generating: !!chat.generating };
  const i = state.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) state.chats[i] = m; else state.chats.push(m);
  sortChats(); renderChatList();
}
function setTitle(id, title) {
  const meta = state.chats.find((c) => c.id === id);
  if (meta) meta.title = title;
  const s = state.streams.get(id); if (s) s.title = title;
  if (state.chat?.id === id) { state.chat.title = title; els.title.textContent = title; document.title = `${title} · OnlyChat`; }
  renderChatList();
}

// ---------------- open / new ----------------
let pollTimer = null;
function closeSide() { els.app.classList.remove('side-open'); }
function setHash(id) { if (location.hash.slice(1) !== id) history.replaceState(null, '', id ? `#${id}` : location.pathname); }
function newChat() {
  state.chat = null; clearEditing(); setHash('');
  els.title.textContent = ''; document.title = 'OnlyChat';
  renderAll(); closeSide(); els.input.focus();
}
async function openChat(id) {
  clearTimeout(pollTimer); clearEditing();
  closeSide();
  let chat = state.streams.get(id);
  if (!chat) {
    try { chat = await api('GET', `/api/chats/${id}`); } catch (e) { return alertErr(e); }
  }
  state.chat = chat; setHash(id);
  els.title.textContent = chat.title; document.title = `${chat.title} · OnlyChat`;
  renderAll(true);
  if (chat.generating && !state.streams.has(id)) poll(id); // generating in another tab / device
}
function poll(id) {
  pollTimer = setTimeout(async () => {
    if (state.chat?.id !== id || state.streams.has(id)) return;
    try {
      const chat = await api('GET', `/api/chats/${id}`);
      if (state.chat?.id !== id) return;
      state.chat = chat; renderMessages(false);
      if (chat.generating) poll(id); else upsertMeta(chat);
    } catch {}
  }, 1200);
}
function renderAll(scrollBottom) {
  renderModelSelect(); renderToggles(); renderChatList(); renderMessages(scrollBottom !== false); renderSendBtn();
}

// ---------------- messages ----------------
function renderMessages(scrollBottom = true) {
  const c = state.chat;
  if (!c || !c.messages.length) {
    els.messages.innerHTML = `<div class="empty"><h1>OnlyChat</h1><p>${state.settings.providers.some((p) => p.models.length) ? '有什么可以帮你？' : '先去 <a href="#" id="goSettings">设置</a> 添加一个 API 供应商吧'}</p></div>`;
    $('#goSettings')?.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
    return;
  }
  const keep = els.messages.scrollTop;
  els.messages.innerHTML = '';
  c.messages.forEach((m, i) => els.messages.append(msgEl(m, i === c.messages.length - 1 && c.generating)));
  if (scrollBottom) els.messages.scrollTop = els.messages.scrollHeight; else els.messages.scrollTop = keep;
}
function msgEl(m, streaming) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.dataset.id = m.id;
  fillMsg(el, m, streaming);
  return el;
}
function fillMsg(el, m, streaming) {
  const c = state.chat;
  const isLast = c && c.messages[c.messages.length - 1]?.id === m.id;
  if (m.role === 'user') {
    const imgs = (m.images || []).map((f) => `<img src="/api/files/${esc(f)}" loading="lazy" alt="">`).join('');
    el.innerHTML = `${imgs ? `<div class="imgs">${imgs}</div>` : ''}${m.text ? `<div class="bubble"></div>` : ''}<div class="actions"><button data-a="copy">复制</button><button data-a="edit">编辑</button><button data-a="del">删除</button></div>`;
    if (m.text) el.querySelector('.bubble').textContent = m.text;
    return;
  }
  const prevDetails = el.querySelector('details.reasoning');
  const open = prevDetails ? prevDetails.open : !!(streaming && !m.text);
  const status = streaming ? (m.status || (m.text ? '' : m.reasoning ? '思考中…' : '等待响应…')) : '';
  const extra = [];
  if (m.duration && !streaming) extra.push(`${(m.duration / 1000).toFixed(1)}s`);
  const u = m.usage; if (u && !streaming) {
    const out = u.output_tokens ?? u.completion_tokens; if (out) extra.push(`${out} tokens`);
  }
  el.innerHTML = `<div class="meta">${esc(m.model || '')}${extra.length ? ` · ${extra.join(' · ')}` : ''}</div>
    <div class="bubble">
      ${m.reasoning ? `<details class="reasoning"${open ? ' open' : ''}><summary>${streaming && !m.text ? '思考中…' : '思考过程'}</summary><div class="r-body"></div></details>` : ''}
      ${status ? `<div class="status busy">${esc(status)}</div>` : ''}
      <div class="md${streaming ? ' cursor' : ''}"></div>
      ${m.stopped ? '<div class="status">（已停止）</div>' : ''}
      ${m.error ? `<div class="err-box">${esc(m.error)}</div>` : ''}
      ${m.sources?.length ? `<div class="sources">${m.sources.slice(0, 30).map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">${i + 1}. ${esc(s.title || hostOf(s.url))}</a>`).join('')}</div>` : ''}
    </div>
    ${streaming ? '' : `<div class="actions"><button data-a="copy">复制</button>${isLast ? '<button data-a="regen">重新生成</button>' : ''}<button data-a="del">删除</button></div>`}`;
  if (m.reasoning) el.querySelector('.r-body').textContent = m.reasoning;
  renderMarkdown(el.querySelector('.md'), m.text, !streaming);
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

let rafPending = new Set();
function scheduleUpdate(chatId, msg) {
  if (state.chat?.id !== chatId) return;
  rafPending.add(msg);
  if (rafPending.size > 1) return;
  requestAnimationFrame(() => {
    const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
    for (const m of rafPending) {
      const el = els.messages.querySelector(`.msg[data-id="${m.id}"]`);
      if (el) fillMsg(el, m, !!state.chat?.generating);
    }
    rafPending.clear();
    if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
  });
}

els.messages.onclick = async (e) => {
  const img = e.target.closest('.imgs img');
  if (img) return lightbox(img.src);
  const a = e.target.closest('.actions button')?.dataset.a;
  if (!a) return;
  const id = e.target.closest('.msg').dataset.id;
  const c = state.chat;
  const m = c.messages.find((x) => x.id === id);
  if (a === 'copy') copyText(m.text, e.target);
  else if (a === 'regen') { if (!c.generating) runStream(c, { regenerate: true }); }
  else if (a === 'edit') {
    if (c.generating) return;
    state.editing = id;
    els.input.value = m.text; autoGrow();
    state.attachments = (m.images || []).map((f) => ({ key: rid(), url: `/api/files/${f}`, file: f }));
    renderAttachments(); els.editingBar.hidden = false; els.input.focus();
  } else if (a === 'del') {
    if (c.generating || !confirm('删除这条消息？')) return;
    await api('PATCH', `/api/chats/${c.id}`, { deleteMessage: id }).catch(alertErr);
    c.messages = c.messages.filter((x) => x.id !== id);
    renderMessages(false);
  }
};
function clearEditing() { state.editing = null; els.editingBar.hidden = true; }
$('#cancelEdit').onclick = () => { clearEditing(); els.input.value = ''; state.attachments = []; renderAttachments(); autoGrow(); };
function lightbox(src) {
  const d = document.createElement('div'); d.id = 'lightbox'; d.innerHTML = `<img src="${esc(src)}" alt="">`;
  d.onclick = () => d.remove(); document.body.append(d);
}

// ---------------- sending ----------------
function renderSendBtn() {
  const gen = !!state.chat?.generating;
  els.send.textContent = gen ? '停止' : '发送';
  els.send.classList.toggle('danger', gen);
  els.send.classList.toggle('primary', !gen);
}
els.send.onclick = () => (state.chat?.generating ? stop() : send());
async function stop() { if (state.chat) await api('POST', `/api/chats/${state.chat.id}/stop`).catch(alertErr); }

async function send() {
  const text = els.input.value;
  if (state.attachments.some((a) => !a.file)) return alert('图片还在上传中…');
  const images = state.attachments.map((a) => a.file);
  if (!text.trim() && !images.length) return;
  const sel = currentSel();
  if (!sel) return openSettings();
  let chat = state.chat;
  if (!chat) {
    try { chat = await api('POST', '/api/chats', { ...sel, webSearch: !!state.opts.webSearch, thinking: !!state.opts.thinking }); } catch (e) { return alertErr(e); }
    state.chat = chat; upsertMeta(chat); setHash(chat.id);
  }
  if (chat.generating) return;
  const body = { text, images };
  if (state.editing) body.editFrom = state.editing;
  const saved = { text, att: state.attachments };
  els.input.value = ''; state.attachments = []; renderAttachments(); autoGrow(); clearEditing();
  const ok = await runStream(chat, body);
  if (!ok && !els.input.value) { els.input.value = saved.text; state.attachments = saved.att; renderAttachments(); autoGrow(); }
}

async function runStream(chat, body) {
  const chatId = chat.id;
  chat.generating = true; renderSendBtn();
  let res;
  try {
    res = await fetch(`/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
  } catch (e) {
    chat.generating = false; renderSendBtn(); alertErr(e); return false;
  }
  let live = null; let asst = null;
  const handle = (ev) => {
    if (ev.type === 'start') {
      live = ev.chat; asst = live.messages[live.messages.length - 1];
      state.streams.set(chatId, live);
      if (state.chat?.id === chatId) { state.chat = live; renderMessages(true); renderSendBtn(); }
      upsertMeta(live);
      return;
    }
    if (!asst) return;
    switch (ev.type) {
      case 'text': asst.text += ev.delta; break;
      case 'reasoning': asst.reasoning += ev.delta; break;
      case 'status': asst.status = ev.text; break;
      case 'sources': asst.sources = ev.items; break;
      case 'done':
        Object.assign(asst, ev.message); delete asst.status;
        live.generating = false; state.streams.delete(chatId);
        live.updatedAt = Date.now(); upsertMeta(live);
        if (state.chat?.id === chatId) { renderMessages(false); renderSendBtn(); }
        return;
      case 'title': setTitle(chatId, ev.title); return;
    }
    scheduleUpdate(chatId, asst);
  };
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split('\n')) if (line.startsWith('data: ')) { try { handle(JSON.parse(line.slice(6))); } catch (e) { console.error(e); } }
      }
    }
  } catch (e) { console.warn('stream interrupted', e); }
  if (state.streams.has(chatId)) { // connection dropped before "done": fall back to polling the server copy
    state.streams.delete(chatId);
    if (state.chat?.id === chatId) openChat(chatId);
  }
  chat.generating = false;
  if (state.chat?.id === chatId) renderSendBtn();
  return !!live;
}

// ---------------- composer ----------------
function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, innerHeight * 0.4)}px`; }
els.input.oninput = autoGrow;
els.input.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !isTouch) { e.preventDefault(); send(); }
};
els.input.onpaste = (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
};
const box = $('.composer-box');
box.ondragover = (e) => { e.preventDefault(); box.classList.add('drag'); };
box.ondragleave = () => box.classList.remove('drag');
box.ondrop = (e) => { e.preventDefault(); box.classList.remove('drag'); addFiles([...e.dataTransfer.files]); };
$('#attachBtn').onclick = () => els.file.click();
els.file.onchange = () => { addFiles([...els.file.files]); els.file.value = ''; };

function renderAttachments() {
  els.att.innerHTML = state.attachments.map((a) => `<div class="att${a.file ? '' : ' loading'}" data-k="${a.key}"><img src="${esc(a.url)}" alt=""><button title="移除">✕</button></div>`).join('');
}
els.att.onclick = (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  const k = e.target.parentElement.dataset.k;
  state.attachments = state.attachments.filter((a) => a.key !== k); renderAttachments();
};
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
async function compressImage(file) {
  if (file.type === 'image/gif' && file.size < 8e6) return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const max = 2048;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5e6 && OK_TYPES.includes(file.type)) return file;
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg'; // keep alpha for PNGs
  const blob = await new Promise((r) => cv.toBlob(r, type, 0.88));
  return blob && OK_TYPES.includes(blob.type) ? blob : file;
}
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const a = { key: rid(), url: URL.createObjectURL(f), file: null };
    state.attachments.push(a); renderAttachments();
    try {
      const blob = await compressImage(f);
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      a.file = j.file;
    } catch (e) {
      state.attachments = state.attachments.filter((x) => x !== a); alertErr(e);
    }
    renderAttachments();
  }
}

// ---------------- settings ----------------
const dlg = $('#settingsDlg');
const DEFAULT_BASE = { openai: 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
const SEARCH_HINT = {
  openai: '联网默认发送 {"web_search_options":{}}（OpenAI gpt-*-search 系列）。其它兼容服务可改写，如通义 {"enable_search":true}、OpenRouter {"plugins":[{"id":"web"}]}。',
  'openai-responses': '联网默认发送 {"tools":[{"type":"web_search"}]}，即 OpenAI Responses 原生 web_search 工具。',
  anthropic: '联网默认使用服务端 web_search 工具（新模型 web_search_20260209，旧模型自动回退 web_search_20250305）。',
};
function providerCard(p) {
  const node = $('#providerTpl').content.firstElementChild.cloneNode(true);
  node.dataset.id = p.id;
  $('.p-name', node).value = p.name || '';
  $('.p-type', node).value = p.type;
  $('.p-base', node).value = p.baseURL || '';
  $('.p-key', node).placeholder = p.keyHint ? `API Key（已保存 ${p.keyHint}，留空不修改）` : 'API Key';
  $('.p-models', node).value = (p.models || []).join('\n');
  $('.p-extra', node).value = p.extraBody ? JSON.stringify(p.extraBody) : '';
  $('.p-search', node).value = p.searchBody ? JSON.stringify(p.searchBody) : '';
  const hint = () => { $('.p-hint', node).textContent = SEARCH_HINT[$('.p-type', node).value]; };
  hint();
  $('.p-type', node).onchange = () => {
    const base = $('.p-base', node);
    if (!base.value || Object.values(DEFAULT_BASE).includes(base.value)) base.value = DEFAULT_BASE[$('.p-type', node).value];
    hint();
  };
  $('.p-del', node).onclick = () => { if (confirm('删除该供应商？')) node.remove(); };
  $('.p-fetch', node).onclick = async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '拉取中…';
    try {
      const { models } = await api('POST', '/api/models', { id: node.dataset.id, type: $('.p-type', node).value, baseURL: $('.p-base', node).value, apiKey: $('.p-key', node).value });
      const ta = $('.p-models', node);
      const cur = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (cur.length && !confirm(`拉取到 ${models.length} 个模型。确定用完整列表替换当前列表？（取消则只追加新模型）`)) {
        ta.value = [...new Set([...cur, ...models])].join('\n');
      } else ta.value = models.join('\n');
    } catch (err) { alertErr(err); }
    btn.disabled = false; btn.textContent = '拉取模型';
  };
  return node;
}
function openSettings() {
  const s = state.settings;
  const list = $('#providerList'); list.innerHTML = '';
  for (const p of s.providers) list.append(providerCard(p));
  const t = s.titleModel;
  $('#titleModel').innerHTML = modelOptions(t && selKey(t.providerId, t.model), `<option value=""${t ? '' : ' selected'}>跟随当前对话的模型</option>`);
  $('#systemPrompt').value = s.systemPrompt || '';
  $('#maxTokens').value = s.maxTokens || 32000;
  $('#settingsMsg').textContent = '';
  closeSide();
  dlg.showModal();
}
$('#openSettings').onclick = openSettings;
for (const b of dlg.querySelectorAll('[data-add]')) {
  b.onclick = () => {
    const type = b.dataset.add;
    const card = providerCard({ id: rid(), name: type === 'anthropic' ? 'Anthropic' : 'OpenAI', type, baseURL: DEFAULT_BASE[type], models: [] });
    $('#providerList').append(card); $('.p-name', card).focus();
  };
}
$('#settingsForm').onsubmit = async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const msg = $('#settingsMsg');
  try {
    const parseObj = (v, label) => {
      if (!v.trim()) return undefined;
      let o; try { o = JSON.parse(v); } catch { throw new Error(`${label} 不是合法 JSON`); }
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${label} 必须是 JSON 对象`);
      return o;
    };
    const providers = [...$('#providerList').children].map((n) => {
      const name = $('.p-name', n).value.trim() || '未命名';
      const p = {
        id: n.dataset.id, name, type: $('.p-type', n).value, baseURL: $('.p-base', n).value.trim(),
        models: $('.p-models', n).value.split('\n').map((x) => x.trim()).filter(Boolean),
        extraBody: parseObj($('.p-extra', n).value, `${name} 的附加请求体`),
        searchBody: parseObj($('.p-search', n).value, `${name} 的联网请求体`),
      };
      const key = $('.p-key', n).value.trim();
      if (key) p.apiKey = key;
      return p;
    });
    msg.textContent = '保存中…';
    state.settings = await api('PUT', '/api/settings', {
      providers,
      titleModel: parseSel($('#titleModel').value),
      systemPrompt: $('#systemPrompt').value,
      maxTokens: Number($('#maxTokens').value) || 32000,
    });
    dlg.close();
    if (!state.chat) renderMessages();
    renderModelSelect();
  } catch (err) { msg.textContent = err.message; }
};

// ---------------- login ----------------
function showLogin() { const d = $('#loginDlg'); if (!d.open) d.showModal(); $('#password').focus(); }
$('#loginDlg').addEventListener('cancel', (e) => e.preventDefault());
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { password: $('#password').value });
    $('#loginDlg').close(); init();
  } catch (err) { $('#loginMsg').textContent = err.message; }
};

// ---------------- misc ----------------
function alertErr(e) { console.error(e); if (e?.message !== '需要登录') alert(e?.message || String(e)); }
$('#newChat').onclick = newChat;
$('#toggleSide').onclick = () => els.app.classList.toggle('side-open');
$('#scrim').onclick = closeSide;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
});

async function init() {
  try {
    await api('GET', '/api/me');
    [state.settings, state.chats] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/chats')]);
  } catch (e) { if (e.message !== '需要登录') els.messages.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  const id = location.hash.slice(1);
  if (id && state.chats.some((c) => c.id === id)) openChat(id); else renderAll();
  if (!state.settings.providers.length) openSettings();
}
addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id === (state.chat?.id || '')) return;
  if (id && state.chats.some((c) => c.id === id)) openChat(id); else newChat();
});
init();
