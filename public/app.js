'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Date.now().toString(36) + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
const isTouch = matchMedia('(pointer: coarse)').matches;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const state = {
  me: null, // { id, username, role }
  settings: { providers: [] },
  chats: [], // meta list
  chat: null, // currently open full chat (null = new, unsaved chat)
  streams: new Map(), // chatId -> chat object being streamed in this tab
  attachments: [], // { key, url, file|null }
  editing: null,
  opts: lsGet('oc_opts', { webSearch: false, effort: 'off' }),
};

const els = {
  app: $('#app'), list: $('#chatList'), search: $('#search'), messages: $('#messages'), input: $('#input'),
  send: $('#sendBtn'), model: $('#modelSelect'), title: $('#chatTitle'), att: $('#attachments'),
  exportChat: $('#exportChat'), searchT: $('#searchToggle'), thinkT: $('#thinkSelect'), file: $('#fileInput'), editingBar: $('#editingBar'),
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
  if (r.status === 401 && (j.needLogin || url === '/api/me')) { showLogin(); throw new Error('需要登录'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------------- models ----------------
const selKey = (pid, model) => `${pid}::${model}`;
const parseSel = (v) => { const i = v.indexOf('::'); return i < 0 ? null : { providerId: v.slice(0, i), model: v.slice(i + 2) }; };
const isAdmin = () => state.me?.role === 'admin';
const provById = (id) => state.settings.providers.find((p) => p.id === id);
const provLabel = (p) => p.displayName || p.name || '';
const usable = (p) => !p.disabled && p.models?.length;
// Flat "username / key / model" labels; disabled providers never appear.
function modelOptions(selected, extraFirst) {
  let html = extraFirst || '';
  let found = !selected;
  for (const p of state.settings.providers) {
    if (!usable(p)) continue;
    for (const m of p.models) {
      const k = selKey(p.id, m);
      if (k === selected) found = true;
      html += `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(`${provLabel(p)} / ${m}`)}</option>`;
    }
  }
  if (!found && selected) {
    const s = parseSel(selected); const p = s && provById(s.providerId);
    html = `<option value="${esc(selected)}" selected>${esc(`${p ? provLabel(p) + ' / ' : ''}${s?.model}`)}（${p?.disabled ? '已停用' : '已移除'}）</option>${html}`;
  }
  return html;
}
function currentSel() {
  const c = state.chat;
  if (c?.providerId && c.model) return { providerId: c.providerId, model: c.model };
  const d = state.settings.defaultModel;
  const p = d && provById(d.providerId);
  if (p && !p.disabled && p.models.includes(d.model)) return d;
  const first = state.settings.providers.find(usable);
  return first ? { providerId: first.id, model: first.models[0] } : null;
}
function renderModelSelect() {
  const s = currentSel();
  els.model.innerHTML = modelOptions(s && selKey(s.providerId, s.model)) || '<option value="">请先在设置中添加模型</option>';
  const so = els.model.selectedOptions[0]; els.model.title = so ? so.textContent : '模型';
}
els.model.onchange = async () => {
  const s = parseSel(els.model.value);
  if (!s) return;
  if (state.chat) { Object.assign(state.chat, s); api('PATCH', `/api/chats/${state.chat.id}`, s).catch(alertErr); }
  state.settings.defaultModel = s;
  renderToggles();
  api('PUT', '/api/settings', { defaultModel: s }).catch(() => {});
};

// ---------------- toggles ----------------
// Effort levels depend on the model: the server sends the same rules (state.settings.effortRules).
const LEVEL_LABEL = { off: '关', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
function effortLevels(model) {
  const r = (state.settings.effortRules || []).find((x) => new RegExp(x.match, x.flags).test(model || ''));
  return r ? r.levels : ['off', 'low', 'medium', 'high'];
}
function renderToggles() {
  const src = state.chat || state.opts;
  els.searchT.classList.toggle('on', !!src.webSearch);
  const levels = effortLevels(currentSel()?.model);
  const raw = src.effort ?? (src.thinking ? 'high' : 'off');
  const eff = levels.includes(raw) ? raw : 'off'; // unsupported by this model -> off
  const key = levels.join();
  if (els.thinkT.dataset.levels !== key) {
    els.thinkT.innerHTML = levels.map((l) => `<option value="${l}">💡 思考：${LEVEL_LABEL[l]}</option>`).join('');
    els.thinkT.dataset.levels = key;
  }
  els.thinkT.value = eff;
  els.thinkT.classList.toggle('on', eff !== 'off');
}
els.thinkT.onchange = () => {
  const v = els.thinkT.value;
  state.opts.effort = v; lsSet('oc_opts', state.opts);
  if (state.chat) { state.chat.effort = v; api('PATCH', `/api/chats/${state.chat.id}`, { effort: v }).catch(alertErr); }
  renderToggles();
};
for (const [btn, key] of [[els.searchT, 'webSearch']]) {
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
function renderExportLink() {
  const id = state.chat?.id;
  els.exportChat.hidden = !id;
  if (id) { els.exportChat.href = `/api/chats/${encodeURIComponent(id)}/export`; els.exportChat.setAttribute('download', ''); }
}
function renderAll(scrollBottom) {
  renderExportLink(); renderModelSelect(); renderToggles(); renderChatList(); renderMessages(scrollBottom !== false); renderSendBtn();
}

// ---------------- messages ----------------
function renderMessages(scrollBottom = true) {
  const c = state.chat;
  if (!c || !c.messages.length) {
    els.messages.innerHTML = `<div class="empty"><h1>OnlyChat</h1><p>${state.settings.providers.some(usable) ? '有什么可以帮你？' : '先去 <a href="#" id="goSettings">设置</a> 添加一个 API 供应商吧'}</p></div>`;
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
  const su = !streaming ? usageStats(m.usage) : null;
  if (su) extra.push(`缓存命中 ${su.hit.toLocaleString()}`, `缓存未命中 ${su.miss.toLocaleString()}`, `输出 ${su.out.toLocaleString()} tokens`);
  const mp = m.providerId && provById(m.providerId);
  el.innerHTML = `<div class="meta">${esc(`${mp ? provLabel(mp) + ' / ' : ''}${m.model || ''}`)}${extra.length ? ` · ${extra.join(' · ')}` : ''}</div>
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
// Normalize upstream usage into { hit, miss, out } (cache hit / cache miss / output tokens).
// Anthropic: input_tokens excludes cache reads, so miss = input + cache writes.
// OpenAI Chat / Responses: prompt (input) tokens include cached ones; miss = input - cached.
// DeepSeek-style gateways report prompt_cache_hit/miss_tokens directly.
function usageStats(u) {
  if (!u) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  let hit, miss;
  if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    hit = n(u.cache_read_input_tokens);
    miss = n(u.input_tokens) + n(u.cache_creation_input_tokens);
  } else if (u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined) {
    hit = n(u.prompt_cache_hit_tokens);
    miss = n(u.prompt_cache_miss_tokens);
  } else {
    hit = n(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
    miss = Math.max(0, n(u.prompt_tokens ?? u.input_tokens) - hit);
  }
  return { hit, miss, out: n(u.output_tokens ?? u.completion_tokens) };
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
    try { chat = await api('POST', '/api/chats', { ...sel, webSearch: !!state.opts.webSearch, effort: state.opts.effort || 'off' }); } catch (e) { return alertErr(e); }
    state.chat = chat; upsertMeta(chat); setHash(chat.id); renderExportLink();
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
function setDisabledUI(node, disabled) {
  node.dataset.disabled = disabled ? '1' : '';
  node.classList.toggle('is-disabled', !!disabled);
  $('.p-toggle', node).textContent = disabled ? '恢复' : '停用';
  updateBadge(node);
}
function updateBadge(node) {
  const isNew = node.dataset.saved !== '1';
  const shared = isNew ? $('.p-shared', node).value === '1' : node.dataset.shared === '1';
  const parts = [shared ? '共享' : '私有'];
  if (node.dataset.disabled) parts.push('已停用');
  if (isNew) parts.push('未保存');
  const b = $('.p-badge', node);
  b.textContent = parts.join(' · ');
  b.classList.toggle('shared', shared);
}
function providerCard(p, isNew) {
  const node = $('#providerTpl').content.firstElementChild.cloneNode(true);
  node.dataset.id = p.id;
  node.dataset.saved = isNew ? '' : '1';
  node.dataset.shared = p.shared ? '1' : '';
  $('.p-name', node).value = p.name || '';
  $('.p-type', node).value = p.type;
  $('.p-base', node).value = p.baseURL || '';
  $('.p-key', node).placeholder = p.keyHint ? `API Key（已保存 ${p.keyHint}，留空不修改）` : 'API Key';
  $('.p-models', node).value = (p.models || []).join('\n');
  $('.p-extra', node).value = p.extraBody ? JSON.stringify(p.extraBody) : '';
  $('.p-search', node).value = p.searchBody ? JSON.stringify(p.searchBody) : '';
  // sharing is chosen once at creation; saved cards only display it
  $('.p-share-pick', node).hidden = !isNew;
  $('.p-share-note', node).hidden = !isNew;
  $('.p-shared', node).onchange = () => updateBadge(node);
  // saved providers can only be stopped / restored; unsaved ones can simply be dropped
  $('.p-del', node).hidden = !isNew;
  $('.p-toggle', node).hidden = !!isNew;
  $('.p-reveal', node).hidden = !!isNew;
  setDisabledUI(node, !!p.disabled);
  $('.p-toggle', node).onclick = () => setDisabledUI(node, !node.dataset.disabled);
  const hint = () => { $('.p-hint', node).textContent = SEARCH_HINT[$('.p-type', node).value]; };
  hint();
  $('.p-type', node).onchange = () => {
    const base = $('.p-base', node);
    if (!base.value || Object.values(DEFAULT_BASE).includes(base.value)) base.value = DEFAULT_BASE[$('.p-type', node).value];
    hint();
  };
  $('.p-del', node).onclick = () => { if (confirm('移除这个尚未保存的供应商？')) node.remove(); };
  const hideSecret = () => { clearTimeout(node._secretT); $('.p-secret', node).value = ''; $('.p-secret-row', node).hidden = true; $('.p-reveal', node).textContent = '显示 Key'; };
  $('.p-secret-hide', node).onclick = hideSecret;
  $('.p-reveal', node).onclick = async (e) => {
    const btn = e.target;
    if (!$('.p-secret-row', node).hidden) return hideSecret();
    btn.disabled = true;
    try {
      const { apiKey } = await api('GET', `/api/providers/${encodeURIComponent(node.dataset.id)}/secret`);
      $('.p-secret', node).value = apiKey || '';
      $('.p-secret-row', node).hidden = false; btn.textContent = '隐藏 Key';
      $('.p-secret', node).select();
      node._secretT = setTimeout(hideSecret, 30000);
    } catch (err) { alertErr(err); }
    btn.disabled = false;
  };
  $('.p-fetch', node).onclick = async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '拉取中…';
    try {
      const body = { type: $('.p-type', node).value, baseURL: $('.p-base', node).value, apiKey: $('.p-key', node).value };
      if (node.dataset.saved === '1') body.id = node.dataset.id; // saved key is used by id when the field is left blank
      const { models } = await api('POST', '/api/models', body);
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
const isOwn = (p) => p.ownerId === state.me?.id;
function openSettings() {
  const s = state.settings;
  const list = $('#providerList'); list.innerHTML = '';
  for (const p of s.providers) if (isOwn(p)) list.append(providerCard(p, false));
  // other users' shared keys: read only, never submitted
  const others = s.providers.filter((p) => !isOwn(p));
  $('#sharedSec').hidden = !others.length;
  $('#sharedList').innerHTML = others.map((p) => `<div class="shared-item${p.disabled ? ' is-disabled' : ''}">
    <div class="si-name">${esc(provLabel(p))}${p.disabled ? ' <span class="badge">已停用</span>' : ''}</div>
    <div class="muted small">${esc(p.type || '')} · ${(p.models || []).length} 个模型${p.models?.length ? '：' + esc(p.models.slice(0, 6).join('、')) + (p.models.length > 6 ? '…' : '') : ''}</div></div>`).join('');
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
    const card = providerCard({ id: rid(), name: type === 'anthropic' ? 'Anthropic' : 'OpenAI', type, baseURL: DEFAULT_BASE[type], models: [] }, true);
    $('#providerList').append(card); $('.p-name', card).focus();
  };
}
// never leave a revealed key in the DOM after the dialog closes
dlg.addEventListener('close', () => { for (const n of $('#providerList').children) { clearTimeout(n._secretT); $('.p-secret', n).value = ''; } });
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
    // Only the user's own cards are sent; other users' shared providers are never submitted.
    const providers = [...$('#providerList').children].map((n) => {
      const name = $('.p-name', n).value.trim() || '未命名';
      const p = {
        id: n.dataset.id, name, type: $('.p-type', n).value, baseURL: $('.p-base', n).value.trim(),
        models: $('.p-models', n).value.split('\n').map((x) => x.trim()).filter(Boolean),
        extraBody: parseObj($('.p-extra', n).value, `${name} 的附加请求体`),
        searchBody: parseObj($('.p-search', n).value, `${name} 的联网请求体`),
        disabled: !!n.dataset.disabled,
      };
      if (n.dataset.saved !== '1') p.shared = $('.p-shared', n).value === '1'; // immutable: only sent for new cards
      const key = $('.p-key', n).value.trim();
      if (key) p.apiKey = key;
      return p;
    });
    const newShared = providers.filter((p) => p.shared);
    if (newShared.length && !confirm(`将共享 ${newShared.map((p) => `「${p.name}」`).join('、')}：其他用户可使用该 Key 调用模型，用量会计入排行，且创建后无法改为私有。确定？`)) return;
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

// ---------------- account ----------------
const acc = $('#accountDlg');
const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();
function renderMe() {
  const u = state.me; if (!u) return;
  $('#meName').textContent = u.username; $('#meAvatar').textContent = initial(u.username);
  $('#accName').textContent = u.username; $('#accAvatar').textContent = initial(u.username);
  $('#accRole').textContent = u.role === 'admin' ? '管理员' : '普通用户';
}
function clearBrowserState() {
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  history.replaceState(null, '', location.pathname);
}
async function logout() {
  try { await api('POST', '/api/logout'); } catch (e) { if (e.message !== '需要登录') return alertErr(e); }
  clearBrowserState(); location.reload();
}
function openAccount() {
  for (const id of ['pwCur', 'pwNew', 'pwNew2', 'nuName', 'nuPw']) $('#' + id).value = '';
  for (const id of ['pwMsg', 'dataMsg', 'adminMsg']) flash($('#' + id), '');
  $('#nuResult').hidden = true; $('#nuResult').innerHTML = '';
  renderMe();
  $('#adminSec').hidden = !isAdmin();
  closeSide(); acc.showModal();
  if (isAdmin()) loadUsers();
}
function flash(el, text, bad) { el.textContent = text; el.classList.toggle('err', !!bad); el.classList.toggle('ok', !!text && !bad); }
$('#openAccount').onclick = openAccount;
$('#accClose').onclick = () => acc.close();
acc.addEventListener('close', () => { $('#nuResult').innerHTML = ''; $('#nuResult').hidden = true; }); // one-time generated password
$('#logoutBtn').onclick = logout;
$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#pwMsg');
  if ($('#pwNew').value !== $('#pwNew2').value) return flash(msg, '两次输入的新密码不一致', true);
  try {
    await api('POST', '/api/password', { currentPassword: $('#pwCur').value, password: $('#pwNew').value });
    for (const id of ['pwCur', 'pwNew', 'pwNew2']) $('#' + id).value = '';
    clearBrowserState(); location.reload();
  } catch (err) { flash(msg, err.message, true); }
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const msg = $('#dataMsg');
  try {
    let data; try { data = JSON.parse(await f.text()); } catch { throw new Error('不是合法的 JSON 文件'); }
    if (!confirm(`导入「${f.name}」中的会话到你的账户？`)) return;
    flash(msg, '导入中…');
    const r = await api('POST', '/api/import', data);
    state.chats = await api('GET', '/api/chats'); renderChatList();
    const n = r.imported ?? r.chats ?? r.count;
    flash(msg, `导入完成${Number.isFinite(n) ? `（${n} 个会话）` : ''}`);
  } catch (err) { flash(msg, err.message, true); }
};
async function loadUsers() {
  const box = $('#userList');
  try {
    const r = await api('GET', '/api/users');
    const users = Array.isArray(r) ? r : r.users || [];
    box.innerHTML = users.map((u) => `<div class="user-row" data-id="${esc(u.id)}"><span class="avatar">${esc(initial(u.username))}</span><span class="un"><span class="uname">${esc(u.username)}</span>${u.id === state.me.id ? ' <span class="muted small">（你）</span>' : ''}</span><span class="badge${u.role === 'admin' ? ' shared' : ''}">${u.role === 'admin' ? '管理员' : '用户'}</span>${u.role === 'admin' ? '' : '<button type="button" class="btn small-btn" data-promote="1">设为管理员</button>'}</div>`).join('');
  } catch (err) { box.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}
$('#userList').onclick = async (e) => {
  const row = e.target.closest('.user-row');
  if (!row || !e.target.dataset.promote) return;
  const name = $('.uname', row).textContent;
  if (!confirm(`将「${name}」设为管理员？此操作不能撤销（无法降级）。`)) return;
  try { await api('POST', `/api/users/${encodeURIComponent(row.dataset.id)}/promote`); flash($('#adminMsg'), `${name} 已设为管理员`); loadUsers(); } catch (err) { flash($('#adminMsg'), err.message, true); }
};
$('#newUserForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = { username: $('#nuName').value.trim() };
  const pw = $('#nuPw').value;
  if (pw) body.password = pw;
  const res = $('#nuResult');
  try {
    const r = await api('POST', '/api/users', body);
    $('#nuName').value = ''; $('#nuPw').value = '';
    res.hidden = false;
    res.innerHTML = `<div>已创建用户 <b>${esc(r.user?.username || body.username)}</b>。${pw ? '' : '随机密码仅显示这一次，请转交给对方：'}</div>${pw ? '' : `<div class="nu-pw"><code>${esc(r.password)}</code><button type="button" class="btn small-btn">复制</button></div>`}`;
    $('button', res)?.addEventListener('click', (ev) => copyText(r.password, ev.target));
    flash($('#adminMsg'), '');
    loadUsers();
  } catch (err) { res.hidden = true; flash($('#adminMsg'), err.message, true); }
};

// ---------------- usage leaderboard ----------------
const usageDlg = $('#usageDlg');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// compact k / m for the cell; the exact value goes in the title tooltip
function fmtTok(v) {
  const n = num(v);
  const trim = (x, d) => x.toFixed(d).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  if (n < 1000) return String(n);
  if (n < 1e6) { const k = trim(n / 1e3, n < 1e5 ? 1 : 0); return k === '1000' ? '1m' : `${k}k`; }
  return `${trim(n / 1e6, n < 1e7 ? 2 : 1)}m`;
}
const tokCell = (v, label) => `<td class="n" title="${esc(`${label}：${num(v).toLocaleString()} tokens`)}">${fmtTok(v)}</td>`;
function cacheCell(r) {
  const unknown = r.unknownCache === true || num(r.unknownCache) > 0;
  const exact = num(r.cachedInput).toLocaleString();
  const tip = unknown
    ? `缓存命中：${exact} tokens；${typeof r.unknownCache === 'number' ? `${r.unknownCache.toLocaleString()} 次` : '部分'}请求未返回缓存信息，此数值为下限`
    : `缓存命中：${exact} tokens`;
  return `<td class="n${unknown ? ' unk' : ''}" title="${esc(tip)}">${unknown ? '≥' : ''}${fmtTok(r.cachedInput)}${unknown ? '<sup>?</sup>' : ''}</td>`;
}
const byTotal = (a, b) => num(b.total) - num(a.total);
const usageCells = (r) => `${cacheCell(r)}${tokCell(r.input, '输入')}${tokCell(r.output, '输出')}${tokCell(r.total, '合计')}`;
function renderUsage(rows) {
  const body = $('#usageBody');
  if (!rows.length) { body.innerHTML = '<p class="muted">暂无共享密钥的用量数据。</p>'; return; }
  rows = [...rows].sort(byTotal);
  let html = '<div class="table-wrap"><table class="usage"><thead><tr><th class="rk">#</th><th>共享密钥</th><th class="n">缓存命中</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr></thead>';
  rows.forEach((r, i) => {
    const users = [...(r.users || [])].sort(byTotal);
    html += `<tbody><tr class="key-row${users.length ? ' has-users' : ''}"${users.length ? ' tabindex="0" role="button" aria-expanded="false"' : ''}>`
      + `<td class="rk">${i + 1}</td><td class="nm">${users.length ? '<span class="caret">▸</span>' : ''}${esc(r.displayName || r.name || r.id)}${r.disabled ? ' <span class="badge">已停用</span>' : ''}${users.length ? ` <span class="muted small">${users.length} 人</span>` : ''}</td>${usageCells(r)}</tr>`;
    for (const u of users) html += `<tr class="user-row-u" hidden><td></td><td class="nm sub">${esc(u.username)}</td>${usageCells(u)}</tr>`;
    html += '</tbody>';
  });
  html += '</table></div><p class="muted small">按总 tokens 从高到低排序；数值已缩写（k=千，m=百万），悬停可见精确值。带「≥ ?」表示部分请求未返回缓存信息，缓存命中数为下限。点击密钥行可展开各用户明细。</p>';
  body.innerHTML = html;
}
function toggleUsageRow(row) {
  if (!row || !row.classList.contains('has-users')) return;
  const open = row.getAttribute('aria-expanded') !== 'true';
  row.setAttribute('aria-expanded', String(open));
  $('.caret', row).textContent = open ? '▾' : '▸';
  for (const t of row.parentElement.querySelectorAll('.user-row-u')) t.hidden = !open;
}
$('#usageBody').onclick = (e) => toggleUsageRow(e.target.closest('.key-row'));
$('#usageBody').onkeydown = (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const r = e.target.closest?.('.key-row');
  if (r) { e.preventDefault(); toggleUsageRow(r); }
};
async function openUsage() {
  closeSide();
  $('#usageBody').innerHTML = '<p class="muted">加载中…</p>';
  usageDlg.showModal();
  try {
    const r = await api('GET', '/api/usage');
    renderUsage(Array.isArray(r) ? r : r.usage || []);
  } catch (err) { $('#usageBody').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}
$('#openUsage').onclick = openUsage;
$('#usageClose').onclick = () => usageDlg.close();

// ---------------- login ----------------
function showLogin() { const d = $('#loginDlg'); if (!d.open) d.showModal(); $('#loginUser').focus(); }
$('#loginDlg').addEventListener('cancel', (e) => e.preventDefault());
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { username: $('#loginUser').value.trim(), password: $('#password').value });
    // drop any state from a previous account (options, hash of someone else's chat) and reload cleanly
    $('#password').value = ''; clearBrowserState(); location.reload();
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
    state.me = (await api('GET', '/api/me')).user;
    renderMe();
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
// Service worker is required for Chrome (Android) to offer a standalone install.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
