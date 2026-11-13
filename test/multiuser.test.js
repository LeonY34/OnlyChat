'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { normalizeUsage } = require('../lib/accounts');

test('normalizes cache tokens without double counting', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }, 'openai'), { cachedInput: 40, input: 60, output: 20, total: 120, unknownCache: false });
  assert.equal(normalizeUsage({ input_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 5 }, 'anthropic').total, 75);
  assert.equal(normalizeUsage({ input_tokens: 20, output_tokens: 5 }, 'openai-responses').unknownCache, true);
});

test('migration, authentication, permissions, shared usage and portable chats', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onlychat-test-'));
  const oldId = 'legacychat123456', image = 'legacyimage12345.png';
  await fs.mkdir(path.join(dir, 'chats')); await fs.mkdir(path.join(dir, 'uploads'));
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ providers: [{ id: 'legacyprovider123', name: 'legacy', type: 'openai', apiKey: 'old-secret', models: ['test'], baseURL: 'http://localhost' }] }));
  await fs.writeFile(path.join(dir, 'chats', oldId + '.json'), JSON.stringify({ id: oldId, title: 'old', messages: [{ id: 'msg123456', role: 'user', text: 'old', images: [image] }], createdAt: 1, updatedAt: 1 }));
  await fs.writeFile(path.join(dir, 'uploads', image), 'fake-png');
  let received = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    received++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  let output = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), CANONICAL_URL: '', ONLYCHAT_PASSWORD: 'Initial-Password123!' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  t.after(async () => { child.kill(); upstream.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 10000);
    child.stdout.on('data', () => { if (output.includes('listening')) { clearTimeout(timer); resolve(); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
  const call = async (url, method = 'GET', body, cookie = '') => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await call('/api/chats')).status, 401);
  const login = await call('/api/login', 'POST', { username: 'admin', password: 'Initial-Password123!' }); assert.equal(login.status, 200, output);
  const admin = login.cookie;
  assert.equal((await call('/api/chats', 'GET', undefined, admin)).data.length, 1);
  assert.equal((await call('/api/files/' + image, 'GET', undefined, admin)).status, 200);
  const initial = (await call('/api/settings', 'GET', undefined, admin)).data;
  assert.equal(initial.providers[0].shared, false); assert.equal(initial.providers[0].apiKey, undefined);
  const create = await call('/api/users', 'POST', { username: 'alice' }, admin); assert.equal(create.status, 201); assert.ok(create.data.password.length > 24);
  const aliceId = create.data.user.id;
  const alice = (await call('/api/login', 'POST', { username: 'alice', password: create.data.password })).cookie;
  assert.equal((await call('/api/users', 'GET', undefined, alice)).status, 403);
  assert.equal((await call('/api/chats/' + oldId, 'GET', undefined, alice)).status, 404);
  assert.equal((await call('/api/files/' + image, 'GET', undefined, alice)).status, 404);
  assert.equal((await call('/api/export', 'GET', undefined, alice)).data.chats.length, 0);
  const config = { name: 'shared', shared: true, type: 'openai', apiKey: 'private-api-secret', baseURL: `http://127.0.0.1:${upstream.address().port}`, models: ['test'] };
  const saved = await call('/api/settings', 'PUT', { providers: [config] }, alice); assert.equal(saved.status, 200);
  const key = saved.data.providers[0];
  assert.equal((await call('/api/providers/' + key.id + '/secret', 'GET', undefined, alice)).data.apiKey, config.apiKey);
  assert.equal((await call('/api/providers/' + key.id + '/secret', 'GET', undefined, admin)).status, 404);
  assert.equal((await call('/api/models', 'POST', { id: key.id, baseURL: 'http://localhost' }, admin)).status, 403);
  assert.equal((await call('/api/settings', 'PUT', { providers: [{ ...key, shared: false }] }, alice)).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { providers: [key] }, admin)).status, 403);
  const chat = (await call('/api/chats', 'POST', { providerId: key.id, model: 'test' }, admin)).data;
  assert.equal((await call('/api/chats/' + chat.id + '/messages', 'POST', { text: 'hi' }, admin)).status, 200);
  assert.equal(received, 2); // reply + generated title
  const usage = (await call('/api/usage', 'GET', undefined, alice)).data[0];
  assert.equal(usage.total, 240); assert.equal(usage.cachedInput, 80); assert.equal(usage.input, 120); assert.equal(usage.output, 40); assert.equal(usage.users[0].username, 'admin');
  assert.equal((await call('/api/settings', 'PUT', { providers: [{ ...key, disabled: true }] }, alice)).status, 200);
  assert.equal((await call('/api/chats/' + chat.id + '/messages', 'POST', { text: 'blocked' }, admin)).status, 400);
  assert.equal((await call('/api/usage', 'GET', undefined, admin)).data[0].total, 240);
  assert.equal((await call('/api/settings', 'PUT', { providers: [{ ...key, disabled: false, apiKey: 'new-secret' }] }, alice)).status, 200);
  const backup = (await call('/api/export', 'GET', undefined, admin)).data;
  assert.equal(backup.chats.length, 2); assert.ok(backup.files[image]); assert.ok(!JSON.stringify(backup).includes('private-api-secret'));
  const imported = await call('/api/import', 'POST', backup, alice); assert.equal(imported.status, 200); assert.equal(imported.data.imported, 2);
  const ownChats = (await call('/api/chats', 'GET', undefined, alice)).data; assert.equal(ownChats.length, 2); assert.ok(!ownChats.some(c => c.id === oldId));
  const ownChat = (await call('/api/chats/' + ownChats.find(c => c.title === 'old').id, 'GET', undefined, alice)).data;
  assert.notEqual(ownChat.messages[0].images[0], image);
  assert.equal((await call('/api/files/' + ownChat.messages[0].images[0], 'GET', undefined, alice)).status, 200);
  const bad = structuredClone(backup); bad.chats[0].messages[0].images = [image, 'unowned123456.png'];
  assert.equal((await call('/api/import', 'POST', bad, alice)).status, 400);
  assert.equal((await call('/api/users/' + aliceId + '/promote', 'POST', {}, admin)).status, 200);
  assert.equal((await call('/api/users/' + aliceId + '/demote', 'POST', {}, admin)).status, 404);
  const stored = await fs.readFile(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!stored.includes('new-secret')); assert.ok(!stored.includes('old-secret')); assert.ok(!stored.includes('Initial-Password123!'));
  await assert.rejects(fs.access(path.join(dir, 'settings.json')));
  assert.equal((await call('/api/logout', 'POST', {}, alice)).status, 200);
  assert.equal((await call('/api/chats', 'GET', undefined, alice)).status, 401);
});
