'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const id = () => crypto.randomBytes(16).toString('hex');
const randomPassword = () => crypto.randomBytes(24).toString('base64url') + '!aA7';
async function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verify(password, stored) {
  const [salt, value] = stored.split(':');
  const actual = await scrypt(String(password), salt, 64);
  return value?.length === actual.length * 2 && crypto.timingSafeEqual(actual, Buffer.from(value, 'hex'));
}
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 14 || p.length > 256) fail('密码长度须为 14–256 个字符');
  if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(p)).length < 3) fail('密码须包含大小写字母、数字、符号中至少三类');
}
function normalizeUsage(u, type) {
  if (!u) return null;
  const n = x => Number.isFinite(x) && x >= 0 ? x : 0;
  let cachedInput, input, unknownCache = false;
  if (type === 'anthropic' || 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    unknownCache = !('cache_read_input_tokens' in u);
    cachedInput = n(u.cache_read_input_tokens); input = n(u.input_tokens) + n(u.cache_creation_input_tokens);
  } else if ('prompt_cache_hit_tokens' in u || 'prompt_cache_miss_tokens' in u) {
    cachedInput = n(u.prompt_cache_hit_tokens); input = n(u.prompt_cache_miss_tokens ?? Math.max(0, n(u.prompt_tokens) - cachedInput));
  } else {
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens;
    unknownCache = cached === undefined;
    cachedInput = n(cached); input = Math.max(0, n(u.prompt_tokens ?? u.input_tokens) - cachedInput);
  }
  const output = n(u.output_tokens ?? u.completion_tokens);
  return { cachedInput, input, output, total: cachedInput + input + output, unknownCache };
}
class Accounts {
  constructor(dir, defaults) {
    this.dir = dir; this.defaults = defaults; this.file = path.join(dir, 'accounts.json');
    const keyFile = path.join(dir, 'encryption.key');
    try { this.key = fs.readFileSync(keyFile); } catch (e) {
      if (e.code !== 'ENOENT' || fs.existsSync(this.file)) throw e;
      this.key = crypto.randomBytes(32); fs.writeFileSync(keyFile, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('Invalid encryption key');
    if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    else this.data = { users: [], providers: [], sessions: [], usage: [], migrated: false };
    this.attempts = new Map();
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  encrypt(text) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    return [iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()].map(x => x.toString('base64')).join('.');
  }
  decrypt(value) {
    const [iv, data, final, tag] = value.split('.').map(x => Buffer.from(x, 'base64'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.concat([data, final])), cipher.final()]).toString('utf8');
  }
  publicUser(u) { return { id: u.id, username: u.username, role: u.role }; }
  async create(username, password, role = 'user', legacy = false) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{2,40}$/.test(username)) fail('用户名须为 2–40 位字母、数字、下划线或连字符');
    if (!password) password = randomPassword();
    if (!legacy) validatePassword(password);
    const passwordHash = await hash(password);
    if (this.data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) fail('用户名已存在', 409);
    const user = { id: id(), username, passwordHash, role, settings: { ...this.defaults } };
    this.data.users.push(user); this.save(); return { user: this.publicUser(user), password };
  }
  async bootstrap(old, password) {
    if (!this.data.users.length) {
      const created = await this.create('admin', password, 'admin', !!password);
      if (!password) console.log(`Initial administrator admin password: ${created.password}`);
    }
    // Existing installations retain their original account and data ownership.
    const owner = this.data.users.find(u => u.role === 'admin');
    if (!this.data.migrated) {
      const { providers = [], ...prefs } = old;
      owner.settings = { ...this.defaults, ...prefs };
      this.data.providers = providers.map(p => { const { apiKey = '', ...rest } = p; return { ...rest, ownerId: owner.id, shared: false, disabled: false, secret: this.encrypt(apiKey) }; });
      this.data.migrated = true; this.save();
    }
    return owner.id;
  }
  user(req) {
    const token = /(?:^|;\s*)oc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const session = this.data.sessions.find(s => s.hash === digest && s.expires > Date.now());
    return session && this.data.users.find(u => u.id === session.userId);
  }
  cookie(req, token, age) {
    const secure = !!req.socket.encrypted || process.env.CANONICAL_URL?.startsWith('https:');
    return `oc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  async login(req, username, password) {
    const addr = req.socket.remoteAddress || 'local';
    const now = Date.now();
    for (const [k, v] of this.attempts) if (now - v.start > 900000) this.attempts.delete(k);
    const bucket = this.attempts.get(addr) || { count: 0, start: now };
    this.attempts.set(addr, bucket);
    if (++bucket.count > 30) fail('登录尝试过多，请 15 分钟后重试', 429);
    const user = this.data.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
    if (!user || !await verify(String(password || ''), user.passwordHash)) fail('用户名或密码错误', 401);
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions = this.data.sessions.filter(s => s.expires > now);
    this.data.sessions.push({ hash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, expires: now + 30 * 864e5 });
    this.save(); return { token, user: this.publicUser(user) };
  }
  logout(req) {
    const token = /(?:^|;\s*)oc_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (token) this.data.sessions = this.data.sessions.filter(s => s.hash !== crypto.createHash('sha256').update(token).digest('hex'));
    this.save();
  }
  async changePassword(user, current, password) {
    if (!await verify(String(current || ''), user.passwordHash)) fail('当前密码错误', 403);
    validatePassword(password); const passwordHash = await hash(password);
    user.passwordHash = passwordHash; this.data.sessions = this.data.sessions.filter(s => s.userId !== user.id); this.save();
  }
  provider(user, providerId) {
    const p = this.data.providers.find(p => p.id === providerId && !p.disabled && (p.ownerId === user.id || p.shared));
    return p ? { ...p, apiKey: this.decrypt(p.secret) } : null;
  }
  visible(user) {
    return this.data.providers.filter(p => p.ownerId === user.id || (p.shared && !p.disabled)).map(p => {
      const own = p.ownerId === user.id, ownerName = this.data.users.find(u => u.id === p.ownerId)?.username || 'unknown';
      const out = { id: p.id, name: p.name, type: p.type, models: p.models, ownerId: p.ownerId, ownerName, displayName: `${ownerName} / ${p.name}`, shared: p.shared, disabled: p.disabled };
      if (own) Object.assign(out, { baseURL: p.baseURL, extraBody: p.extraBody, searchBody: p.searchBody, keyHint: '已加密保存' });
      return out;
    });
  }
  record(user, provider, usage) {
    const stats = normalizeUsage(usage, provider.type); if (!stats) return;
    const row = this.data.usage.find(r => r.userId === user.id && r.providerId === provider.id);
    if (row) {
      for (const k of ['cachedInput', 'input', 'output', 'total']) row[k] += stats[k];
      row.unknownCache ||= stats.unknownCache;
    } else this.data.usage.push({ userId: user.id, providerId: provider.id, ...stats });
    this.save();
  }
  leaderboard() {
    const sum = rows => rows.reduce((a, r) => ({ cachedInput: a.cachedInput + r.cachedInput, input: a.input + r.input, output: a.output + r.output, total: a.total + r.total, unknownCache: a.unknownCache || r.unknownCache }), { cachedInput: 0, input: 0, output: 0, total: 0, unknownCache: false });
    return this.data.providers.filter(p => p.shared).map(p => {
      const rows = this.data.usage.filter(r => r.providerId === p.id);
      const ownerName = this.data.users.find(u => u.id === p.ownerId)?.username;
      const users = this.data.users.map(u => ({ username: u.username, ...sum(rows.filter(r => r.userId === u.id)) })).filter(u => u.total > 0).sort((a, b) => b.total - a.total);
      return { id: p.id, name: p.name, ownerName, displayName: `${ownerName} / ${p.name}`, disabled: p.disabled, ...sum(rows), users };
    }).sort((a, b) => b.total - a.total);
  }
}
module.exports = { Accounts, normalizeUsage, validatePassword };
