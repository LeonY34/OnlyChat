'use strict';
// Upstream API adapters. Every adapter takes normalized messages
// ({ role, text, images: [{ mime, data(base64) }] }) and reports progress via emit():
//   { type: 'text', delta } | { type: 'reasoning', delta } | { type: 'sources', items: [{url,title}] } | { type: 'status', text }

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');
const dataURL = (im) => `data:${im.mime};base64,${im.data}`;

class UpstreamError extends Error {
  constructor(status, body) {
    let msg = body;
    try { const j = JSON.parse(body); msg = j.error?.message || j.message || j.error || body; } catch {}
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    super(`上游返回 HTTP ${status}: ${String(msg).slice(0, 800)}`);
    this.status = status;
    this.body = body;
  }
}

async function post(url, headers, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ''));
  return res;
}

// Minimal SSE parser over a fetch Response body.
async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    let event = 'message';
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val[0] === ' ') val = val.slice(1);
      if (field === 'event') event = val;
      else if (field === 'data') data.push(val);
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  for await (const chunk of res.body) {
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n?/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = parse(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (ev) yield ev;
    }
  }
  const ev = parse(buf.trim());
  if (ev) yield ev;
}

async function* jsonEvents(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    // Some gateways ignore stream:true and return a single JSON body.
    yield { event: 'json', data: await res.text(), whole: true };
    return;
  }
  yield* sse(res);
}

const tryJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------------- OpenAI Chat Completions ----------------
async function openaiChat({ provider, model, system, messages, webSearch, effort, signal, emit }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user' && m.images.length) {
      msgs.push({
        role: 'user',
        content: [
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...m.images.map((im) => ({ type: 'image_url', image_url: { url: dataURL(im) } })),
        ],
      });
    } else msgs.push({ role: m.role, content: m.text });
  }
  const body = { model, messages: msgs, stream: true, stream_options: { include_usage: true }, ...(provider.extraBody || {}) };
  if (effort !== 'off') body.reasoning_effort = effort;
  if (webSearch) Object.assign(body, provider.searchBody || { web_search_options: {} });

  const res = await post(`${trimBase(provider.baseURL)}/chat/completions`,
    { authorization: `Bearer ${provider.apiKey}` }, body, signal);

  let usage;
  for await (const ev of jsonEvents(res)) {
    if (ev.data === '[DONE]') break;
    const j = tryJSON(ev.data);
    if (!j) continue;
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const choice = j.choices?.[0];
    const d = ev.whole ? choice?.message : choice?.delta;
    if (d) {
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) emit({ type: 'reasoning', delta: r });
      if (d.content) emit({ type: 'text', delta: d.content });
      if (Array.isArray(d.annotations)) {
        const items = d.annotations.filter((a) => a.type === 'url_citation')
          .map((a) => ({ url: a.url_citation?.url || a.url, title: a.url_citation?.title || a.title }));
        if (items.length) emit({ type: 'sources', items });
      }
    }
    // Perplexity-style / some gateways put citations at the top level.
    if (Array.isArray(j.citations) && j.citations.length) {
      emit({ type: 'sources', items: j.citations.map((c) => (typeof c === 'string' ? { url: c } : { url: c.url, title: c.title })) });
    }
    if (j.usage) { usage = j.usage; emit({ type: 'usage', usage }); }
  }
  return { usage };
}

// ---------------- OpenAI Responses ----------------
async function openaiResponses({ provider, model, system, messages, webSearch, effort, signal, emit }) {
  const input = messages.map((m) => (m.role === 'user'
    ? {
      role: 'user',
      content: [
        ...(m.text ? [{ type: 'input_text', text: m.text }] : []),
        ...m.images.map((im) => ({ type: 'input_image', image_url: dataURL(im) })),
      ],
    }
    : { role: 'assistant', content: m.text }));
  const body = { model, input, stream: true, store: false, ...(provider.extraBody || {}) };
  if (system) body.instructions = system;
  if (effort !== 'off') body.reasoning = { effort, summary: 'auto' };
  if (webSearch) Object.assign(body, provider.searchBody || { tools: [{ type: 'web_search' }] });

  const res = await post(`${trimBase(provider.baseURL)}/responses`,
    { authorization: `Bearer ${provider.apiKey}` }, body, signal);

  let usage;
  const fromAnnotations = (anns) => (anns || []).filter((a) => a.type === 'url_citation').map((a) => ({ url: a.url, title: a.title }));
  for await (const ev of jsonEvents(res)) {
    const j = tryJSON(ev.data);
    if (!j) continue;
    if (ev.whole) { // non-streamed fallback
      for (const item of j.output || []) {
        if (item.type === 'message') for (const c of item.content || []) {
          if (c.type === 'output_text') { emit({ type: 'text', delta: c.text }); emit({ type: 'sources', items: fromAnnotations(c.annotations) }); }
        }
      }
      usage = j.usage;
      if (usage) emit({ type: 'usage', usage });
      break;
    }
    switch (j.type) {
      case 'response.output_text.delta': emit({ type: 'text', delta: j.delta }); break;
      case 'response.reasoning_summary_text.delta': emit({ type: 'reasoning', delta: j.delta }); break;
      case 'response.reasoning_summary_part.added': if (j.summary_index > 0) emit({ type: 'reasoning', delta: '\n\n' }); break;
      case 'response.output_text.annotation.added': emit({ type: 'sources', items: fromAnnotations([j.annotation]) }); break;
      case 'response.output_item.added':
        if (j.item?.type === 'web_search_call') emit({ type: 'status', text: '正在联网搜索…' });
        break;
      case 'response.output_item.done':
        if (j.item?.type === 'web_search_call' && j.item.action?.query) emit({ type: 'status', text: `已搜索：${j.item.action.query}` });
        if (j.item?.type === 'message') for (const c of j.item.content || []) emit({ type: 'sources', items: fromAnnotations(c.annotations) });
        break;
      case 'response.completed': usage = j.response?.usage; if (usage) emit({ type: 'usage', usage }); break;
      case 'response.incomplete': usage = j.response?.usage; if (usage) emit({ type: 'usage', usage }); break;
      case 'response.failed': throw new Error(j.response?.error?.message || '响应失败');
      case 'error': throw new Error(j.message || j.error?.message || JSON.stringify(j));
    }
  }
  return { usage };
}

// ---------------- Anthropic Messages ----------------
const anthropicURL = (base) => (/\/v1$/.test(trimBase(base)) ? `${trimBase(base)}/messages` : `${trimBase(base)}/v1/messages`);
const anthropicHeaders = (p) => ({ 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' });
// Dynamic-filtering web search exists on newer models; older ones only accept the basic variant.
const anthropicSearchType = (model) => (/(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6)/i.test(model) ? 'web_search_20260209' : 'web_search_20250305');

async function anthropic({ provider, model, system, messages, webSearch, effort, maxTokens, signal, emit }) {
  const msgs = messages.map((m) => ({
    role: m.role,
    content: m.role === 'user'
      ? [
        ...m.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
      ]
      : m.text,
  }));
  let searchType = anthropicSearchType(model);
  const makeBody = () => {
    const body = { model, max_tokens: maxTokens || 32000, stream: true, messages: msgs, ...(provider.extraBody || {}) };
    if (system) body.system = system;
    if (effort !== 'off') {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort };
    }
    if (webSearch) Object.assign(body, provider.searchBody || { tools: [{ type: searchType, name: 'web_search', max_uses: 5 }] });
    return body;
  };

  const usage = {};
  const accumulated = {};
  const publishUsage = () => {
    const total = { ...accumulated };
    for (const [k, v] of Object.entries(usage)) if (typeof v === 'number') total[k] = (total[k] || 0) + v;
    emit({ type: 'usage', usage: total });
    return total;
  };
  for (let round = 0; round < 6; round++) {
    if (round) { Object.assign(accumulated, publishUsage()); for (const k of Object.keys(usage)) delete usage[k]; }
    let res;
    try {
      res = await post(anthropicURL(provider.baseURL), anthropicHeaders(provider), makeBody(), signal);
    } catch (e) {
      // Older model / gateway that doesn't know the new search tool: fall back once.
      if (e.status === 400 && webSearch && !provider.searchBody && searchType === 'web_search_20260209') {
        searchType = 'web_search_20250305';
        round--;
        continue;
      }
      throw e;
    }

    const blocks = [];
    let stopReason = null;
    for await (const ev of jsonEvents(res)) {
      const j = tryJSON(ev.data);
      if (!j) continue;
      if (ev.whole) { // non-streamed fallback
        for (const b of j.content || []) if (b.type === 'text') emit({ type: 'text', delta: b.text });
        stopReason = j.stop_reason;
        Object.assign(usage, j.usage); publishUsage();
        break;
      }
      switch (j.type) {
        case 'message_start': Object.assign(usage, j.message?.usage); publishUsage(); break;
        case 'content_block_start': {
          const b = { ...j.content_block };
          blocks[j.index] = b;
          if (b.type === 'text') { b.text = b.text || ''; }
          else if (b.type === 'thinking') { b.thinking = b.thinking || ''; }
          else if (b.type === 'server_tool_use' || b.type === 'tool_use') { b._json = ''; if (b.name === 'web_search') emit({ type: 'status', text: '正在联网搜索…' }); }
          else if (b.type === 'web_search_tool_result') {
            if (Array.isArray(b.content)) emit({ type: 'sources', items: b.content.filter((r) => r.url).map((r) => ({ url: r.url, title: r.title })) });
            else if (b.content?.error_code) emit({ type: 'status', text: `搜索出错：${b.content.error_code}` });
          }
          break;
        }
        case 'content_block_delta': {
          const b = blocks[j.index];
          const d = j.delta || {};
          if (!b) break;
          if (d.type === 'text_delta') { b.text += d.text; emit({ type: 'text', delta: d.text }); }
          else if (d.type === 'thinking_delta') { b.thinking += d.thinking; emit({ type: 'reasoning', delta: d.thinking }); }
          else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
          else if (d.type === 'input_json_delta') b._json += d.partial_json;
          else if (d.type === 'citations_delta') {
            (b.citations ||= []).push(d.citation);
            if (d.citation?.url) emit({ type: 'sources', items: [{ url: d.citation.url, title: d.citation.title }] });
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[j.index];
          if (b && '_json' in b) {
            b.input = tryJSON(b._json || '{}') || {};
            delete b._json;
            if (b.name === 'web_search' && b.input.query) emit({ type: 'status', text: `已搜索：${b.input.query}` });
          }
          if (b?.type === 'thinking' && b.thinking) emit({ type: 'reasoning', delta: '\n\n' });
          break;
        }
        case 'message_delta':
          if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
          Object.assign(usage, j.usage); publishUsage();
          break;
        case 'error': throw new Error(j.error?.message || JSON.stringify(j));
      }
    }
    if (stopReason === 'refusal') throw new Error('模型拒绝回答该请求（stop_reason: refusal）');
    // Server tools (web search) can pause a long turn; resend the partial turn to continue.
    if (stopReason !== 'pause_turn') break;
    msgs.push({ role: 'assistant', content: blocks.filter(Boolean) });
  }
  return { usage: publishUsage() };
}

const ADAPTERS = { openai: openaiChat, 'openai-responses': openaiResponses, anthropic };

async function streamChat(opts) {
  const fn = ADAPTERS[opts.provider.type];
  if (!fn) throw new Error(`未知的接口类型：${opts.provider.type}`);
  if (!opts.provider.baseURL) throw new Error('该供应商未配置 Base URL');
  return fn(opts);
}

async function listModels(provider) {
  const base = trimBase(provider.baseURL);
  let url, headers;
  if (provider.type === 'anthropic') {
    url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/models?limit=1000`;
    headers = anthropicHeaders(provider);
  } else {
    url = `${base}/models`;
    headers = { authorization: `Bearer ${provider.apiKey}` };
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return [...new Set(list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean))].sort();
}

module.exports = { streamChat, listModels };
