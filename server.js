'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 加载本地 .env（若存在），仅用于开发环境；生产环境用平台环境变量
const ENV_FILE = path.join(__dirname, '.env');
try {
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* 无 .env 文件，忽略 */ }

const Rules = require('./shared/rules.js');
const Go = require('./shared/go.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 3000);

const SIZE = 15;
const CELLS = SIZE * SIZE;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// 默认模型选择：OpenRouter 免费层频繁轮换（原 MiniMax/Gemma 免费版已于 2026-10-22 关停）。
// 选 laguna-s 作为首选（实测稳定、偶尔 429 限流），下面列表里的每一个 fallback 都是经过
// chat completions 实测能正常返回 JSON 的免费模型。
const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free';

// 前端设置面板显示的候选模型（实测存活）
const FALLBACK_MODELS = [
  { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1 (free)' },
  { id: 'poolside/laguna-xs-2.1:free', name: 'Laguna XS 2.1 (free)' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (free)' },
  { id: 'recursive/flint-v1.0:free', name: 'Flint v1.0 (free)' },
  { id: 'cohere/north-mini-code:free', name: 'North Mini Code (free)' },
  { id: 'openrouter/free', name: 'OpenRouter 聚合免费路由' }
];

// askLLM 内部失败时自动循环尝试的模型顺序。
// 实测响应耗时（稳定返回 OK 的前提下）：
//   flint 1.5s → nemotron 1.5s → openrouter/free 2.8s → laguna-s 2.9s → laguna-xs 3.5s → cohere 3.1s → liquid 7.7s
// 按速度从快到慢排列，遇到 HTTP 错误码（404/400/429/5xx）立即跳过，不等待超时。
const ASK_FALLBACK = [
  'recursive/flint-v1.0:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'liquid/lfm-2.5-2.6b:free'
];

// 多模型供应商。每个 provider 都遵循 OpenAI 兼容的 chat/completions 接口。
const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: DEFAULT_MODEL,
    models: FALLBACK_MODELS,
    keyPlaceholder: 'sk-or-v1-…',
    // OpenRouter 有专门的 /key 接口检测密钥
    testPath: '/key'
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat（V3）' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
    ],
    keyPlaceholder: 'sk-xxxxxxxx'
  },
  zhipu: {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: [
      { id: 'glm-4-flash', name: 'GLM-4 Flash（免费）' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus' },
      { id: 'glm-4.5', name: 'GLM-4.5' },
      { id: 'glm-4-air', name: 'GLM-4 Air' },
      { id: 'glm-4-long', name: 'GLM-4 Long' }
    ],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  },
  qwen: {
    name: '通义千问（阿里云）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }
    ],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  },
  baidu: {
    name: '文心一言（百度千帆）',
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-turbo-8k',
    models: [
      { id: 'ernie-4.0-turbo-8k', name: '文心 4.0 Turbo' },
      { id: 'ernie-4.5', name: '文心 4.5' },
      { id: 'ernie-lite-8k', name: '文心 Lite' },
      { id: 'deepseek-v3-8k', name: 'DeepSeek V3（千帆）' }
    ],
    keyPlaceholder: '应用 API Key'
  },
  custom: {
    name: '自定义（OpenAI 兼容）',
    baseURL: '',
    defaultModel: '',
    models: [],
    keyPlaceholder: 'Bearer token'
  }
};

function defaultProviderConfig(id) {
  const p = PROVIDERS[id];
  return { apiKey: '', baseURL: p.baseURL, model: p.defaultModel };
}

// ---------------------------------------------------------------- 配置

let config = {
  provider: 'openrouter',
  providers: {
    openrouter: defaultProviderConfig('openrouter'),
    deepseek: defaultProviderConfig('deepseek'),
    zhipu: defaultProviderConfig('zhipu'),
    qwen: defaultProviderConfig('qwen'),
    baidu: defaultProviderConfig('baidu'),
    custom: defaultProviderConfig('custom')
  }
};

function providerConfig() {
  return config.providers[config.provider] || config.providers.openrouter;
}
function providerMeta() {
  return PROVIDERS[config.provider] || PROVIDERS.openrouter;
}
function providerBaseURL() {
  const c = providerConfig();
  return (c.baseURL && c.baseURL.trim()) || providerMeta().baseURL;
}
function providerApiKey() {
  return (providerConfig().apiKey || '').trim();
}
function providerModel() {
  const m = (providerConfig().model || '').trim();
  return m || providerMeta().defaultModel;
}

// 兼容老配置：{ apiKey, model } → 迁移到 providers.openrouter
function migrateOldConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.providers && typeof parsed.providers === 'object') {
    // 已经是新结构，合并默认值
    for (const id of Object.keys(PROVIDERS)) {
      const cur = parsed.providers[id];
      if (!cur) { config.providers[id] = defaultProviderConfig(id); continue; }
      config.providers[id] = {
        apiKey: typeof cur.apiKey === 'string' ? cur.apiKey : '',
        baseURL: typeof cur.baseURL === 'string' && cur.baseURL.trim() ? cur.baseURL : PROVIDERS[id].baseURL,
        model: typeof cur.model === 'string' ? cur.model : PROVIDERS[id].defaultModel
      };
    }
    if (typeof parsed.provider === 'string' && config.providers[parsed.provider]) {
      config.provider = parsed.provider;
    }
    return;
  }
  // 老结构
  if (typeof parsed.apiKey === 'string') config.providers.openrouter.apiKey = parsed.apiKey;
  let model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL;
  const dead = DEAD_FREE_PREFIXES.some((p) => model.startsWith(p));
  if (dead) {
    console.log(`[config] 模型 ${model} 已被 OpenRouter 关停，自动切换为 ${DEFAULT_MODEL}`);
    model = DEFAULT_MODEL;
  }
  config.providers.openrouter.model = model;
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    migrateOldConfig(parsed);
  } catch {
    /* 首次启动，无配置文件 */
  }
  if (!providerApiKey() && process.env.OPENROUTER_API_KEY) {
    config.providers.openrouter.apiKey = process.env.OPENROUTER_API_KEY;
  }
  saveConfig();
}

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* 某些平台不支持 chmod */
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------- 用户 / 鉴权

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ADMIN_USERNAME = 'aimin';
const ADMIN_PASSWORD = 'xiaomu';
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天

let users = []; // { id, username, salt, hash, role, avatar, friends, incoming, outgoing, banned, banReason, createdAt }
const sessions = new Map(); // token -> { userId, username, role, isAdmin, expiresAt, banned }
const userClients = new Map(); // userId -> Set<res>  (用户级 SSE，用于好友/私聊/切磋通知)

const DMS_FILE = path.join(DATA_DIR, 'dms.json');
let dms = {}; // pairKey -> [{ from, text, at }]
function pairKey(a, b) { return [a, b].sort().join(':'); }
function loadDms() {
  try { dms = JSON.parse(fs.readFileSync(DMS_FILE, 'utf8')) || {}; }
  catch { dms = {}; }
}
function saveDms() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DMS_FILE, JSON.stringify(dms));
}

// ---------------- 排行榜统计 ----------------
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = {}; // userId -> { total:{game:count}, daily:{date:{game:count}}, ... }
const GAMES = ['gomoku', 'chess', 'go'];
function loadStats() {
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) || {}; }
  catch { stats = {}; }
  // 迁移旧格式（数字 -> {game:count}）
  for (const uid in stats) {
    const s = stats[uid];
    for (const period of ['total', 'daily', 'weekly', 'monthly']) {
      if (!s[period]) { s[period] = {}; continue; }
      if (typeof s[period] === 'number') { s[period] = { gomoku: s[period] }; }
      else if (period !== 'total') {
        for (const k in s[period]) {
          if (typeof s[period][k] === 'number') s[period][k] = { gomoku: s[period][k] };
        }
      }
    }
  }
}
function saveStats() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
}
function periodKeys(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const daily = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  const weekNum = 1 + Math.ceil((firstThursday - target) / 604800000);
  const weekly = `${d.getFullYear()}-W${pad(weekNum)}`;
  const monthly = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return { daily, weekly, monthly };
}
function getWinCount(s, period, key, game) {
  if (!s[period]) return 0;
  if (period === 'total') return (s.total[game] || 0);
  const bucket = s[period][key];
  if (!bucket) return 0;
  return bucket[game] || 0;
}
function recordWin(userId, game) {
  if (!userId || !GAMES.includes(game)) return;
  if (!stats[userId]) stats[userId] = { total: {}, daily: {}, weekly: {}, monthly: {} };
  const s = stats[userId];
  const { daily, weekly, monthly } = periodKeys(Date.now());
  s.total[game] = (s.total[game] || 0) + 1;
  if (!s.daily[daily]) s.daily[daily] = {};
  s.daily[daily][game] = (s.daily[daily][game] || 0) + 1;
  if (!s.weekly[weekly]) s.weekly[weekly] = {};
  s.weekly[weekly][game] = (s.weekly[weekly][game] || 0) + 1;
  if (!s.monthly[monthly]) s.monthly[monthly] = {};
  s.monthly[monthly][game] = (s.monthly[monthly][game] || 0) + 1;
  saveStats();
}
function recordWinIfHuman(room) {
  if (room.winner === 0 || room.draw) return;
  const winner = room.players.find((p) => p.color === room.winner);
  if (winner && !winner.isAI && winner.userId) {
    recordWin(winner.userId, room.game);
  }
}
function leaderboard(period, game) {
  if (!GAMES.includes(game)) return [];
  const { daily, weekly, monthly } = periodKeys(Date.now());
  const key = period === 'daily' ? daily : period === 'weekly' ? weekly : monthly;
  const rows = [];
  for (const uid in stats) {
    const s = stats[uid];
    const count = period === 'total'
      ? (s.total?.[game] || 0)
      : getWinCount(s, period, key, game);
    if (count > 0) {
      const u = users.find((x) => x.id === uid);
      if (!u) continue;
      const priv = u.privacy || {};
      rows.push({
        userId: uid,
        username: u.username,
        avatar: priv.showAvatarInLeaderboard === false ? '' : (u.avatar || randomAvatar()),
        wins: count
      });
    }
  }
  rows.sort((a, b) => b.wins - a.wins);
  return rows.slice(0, 100);
}
function userById(id) { return users.find((u) => u.id === id); }

function pushUserEvent(userId, event) {
  const set = userClients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* 忽略 */ }
  }
}
function isOnline(userId) {
  // 有活跃 session 即视为在线
  for (const s of sessions.values()) {
    if (s.userId === userId && s.expiresAt > Date.now()) return true;
  }
  return false;
}

function loadUsers() {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    users = [];
  }
  users = users.map(normalizeUser);
  // 首次启动写入管理员账号
  if (!users.some((u) => u.username === ADMIN_USERNAME)) {
    users.push(createUserRecord(ADMIN_USERNAME, ADMIN_PASSWORD, true));
    saveUsers();
    console.log(`[auth] 已创建管理员账号: ${ADMIN_USERNAME}`);
  }
}

function saveUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  try { fs.chmodSync(USERS_FILE, 0o600); } catch { /* 忽略 */ }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
}

function randomAvatar() {
  const avatars = ['🐱', '🐶', '🦊', '🐼', '🐨', '🦁', '🐯', '🐰', '🐸', '🐵', '🐮', '🐷', '🦄', '🐲', '🐙', '🦉'];
  return avatars[Math.floor(Math.random() * avatars.length)];
}

function normalizeUser(u) {
  if (!u.avatar) u.avatar = randomAvatar();
  if (u.banned === undefined) u.banned = false;
  if (u.banReason === undefined) u.banReason = '';
  if (u.role === undefined) u.role = u.isAdmin ? 'admin' : 'user';
  if (!Array.isArray(u.friends)) u.friends = [];
  if (!Array.isArray(u.incoming)) u.incoming = [];
  if (!Array.isArray(u.outgoing)) u.outgoing = [];
  if (u.email === undefined) u.email = '';
  if (!u.privacy) u.privacy = {};
  if (u.privacy.showAvatarInLobby === undefined) u.privacy.showAvatarInLobby = true;
  if (u.privacy.showAvatarInLeaderboard === undefined) u.privacy.showAvatarInLeaderboard = true;
  return u;
}

function createUserRecord(username, password, isAdmin = false, email = '') {
  const salt = crypto.randomBytes(16).toString('hex');
  return normalizeUser({
    id: makeId(),
    username,
    salt,
    hash: hashPassword(password, salt),
    role: isAdmin ? 'admin' : 'user',
    banned: false,
    banReason: '',
    avatar: randomAvatar(),
    email: email ? String(email).toLowerCase().trim() : '',
    friends: [],
    incoming: [],
    outgoing: [],
    privacy: { showAvatarInLobby: true, showAvatarInLeaderboard: true },
    createdAt: Date.now()
  });
}

function findUser(username) {
  return users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}

function findUserByEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return null;
  return users.find((u) => (u.email || '').toLowerCase() === e);
}

function verifyPassword(user, password) {
  return user.hash === hashPassword(password, user.salt);
}

function setPassword(user, password) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
}

// 邮箱验证码存储：email -> { code, expiresAt, attempts }
const resetCodes = new Map();
const RESET_CODE_TTL = 10 * 60 * 1000; // 10 分钟
const RESET_MAX_ATTEMPTS = 5;
function makeResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function pruneResetCodes() {
  const now = Date.now();
  for (const [k, v] of resetCodes) {
    if (v.expiresAt < now) resetCodes.delete(k);
  }
}

// ---------------- 邮件发送（SMTP via nodemailer） ----------------
// 配置通过环境变量传入：
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
// 未配置时验证码打印到控制台（仅开发/测试用）
let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  try {
    const nodemailer = require('nodemailer');
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    mailTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: (Number(SMTP_PORT) || 465) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      ...(proxy ? { proxy } : {})
    });
    return mailTransport;
  } catch (e) {
    console.error('[mail] nodemailer 加载失败:', e.message);
    return null;
  }
}

async function sendResetEmail(toEmail, code, username) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const subject = '【联机对弈】密码重置验证码';
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#e2a45a;">密码重置</h2>
      <p>你好 <b>${username}</b>，</p>
      <p>你正在申请重置密码，验证码为：</p>
      <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#f5f0e6;padding:16px;border-radius:8px;text-align:center;margin:16px 0;color:#1a1206;">${code}</div>
      <p>验证码 10 分钟内有效，请勿泄露给他人。</p>
      <p style="color:#999;font-size:12px;">如非本人操作，请忽略此邮件。</p>
    </div>`;
  const transporter = getMailTransport();
  if (!transporter) {
    console.log(`\n[mail] 未配置 SMTP，验证码已打印到控制台：\n  邮箱: ${toEmail}\n  用户: ${username}\n  验证码: ${code}\n`);
    return { dev: true, code };
  }
  try {
    await transporter.sendMail({ from, to: toEmail, subject, html });
    return { ok: true };
  } catch (e) {
    console.error('[mail] 发送失败:', e.message);
    throw e;
  }
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    isAdmin: user.role === 'admin',
    expiresAt: Date.now() + SESSION_TTL
  });
  return token;
}

function getUserById(id) {
  return users.find((u) => u.id === id);
}

function getSession(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  // 每次请求从用户表刷新最新状态（封禁/角色即时生效）
  const user = getUserById(s.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  s.username = user.username;
  s.role = user.role;
  s.isAdmin = user.role === 'admin';
  s.banned = Boolean(user.banned);
  return s;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    role: user.role,
    isAdmin: user.role === 'admin',
    banned: Boolean(user.banned),
    banReason: user.banReason || '',
    privacy: user.privacy || { showAvatarInLobby: true, showAvatarInLeaderboard: true },
    createdAt: user.createdAt
  };
}

// 登录校验（含封禁拦截），失败时自动写响应并返回 null
function requireUser(req, res) {
  const session = getSession(req);
  if (!session) { sendJSON(res, 401, { error: '请先登录' }); return null; }
  if (session.banned) {
    sendJSON(res, 403, { error: `账号已被封禁${session.banReason ? '：' + session.banReason : ''}` });
    return null;
  }
  return session;
}
function requireAdmin(req, res) {
  const s = requireUser(req, res);
  if (!s) return null;
  if (!s.isAdmin) { sendJSON(res, 403, { error: '需要管理员权限' }); return null; }
  return s;
}

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const index = (x, y) => y * SIZE + x;
const inside = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
const makeId = () => crypto.randomBytes(9).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function shortError(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

// ---------------------------------------------------------------- 棋局逻辑

function createBoard(game) {
  if (game === 'chess') return Rules.Chess.create();
  if (game === 'go') return Go.create();
  return new Uint8Array(CELLS);
}

function checkWin(board, x, y, color) {
  for (const [dx, dy] of DIRS) {
    const line = [[x, y]];
    for (let step = 1; step < SIZE; step++) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      if (!inside(nx, ny) || board[index(nx, ny)] !== color) break;
      line.push([nx, ny]);
    }
    for (let step = 1; step < SIZE; step++) {
      const nx = x - dx * step;
      const ny = y - dy * step;
      if (!inside(nx, ny) || board[index(nx, ny)] !== color) break;
      line.unshift([nx, ny]);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function patternScore(count, openEnds) {
  if (count >= 5) return 10_000_000;
  if (count === 4) return openEnds === 2 ? 1_000_000 : openEnds === 1 ? 120_000 : 0;
  if (count === 3) return openEnds === 2 ? 45_000 : openEnds === 1 ? 1_200 : 0;
  if (count === 2) return openEnds === 2 ? 800 : openEnds === 1 ? 120 : 0;
  if (count === 1) return openEnds === 2 ? 20 : 8;
  return 0;
}

function dirScore(board, x, y, dx, dy, color) {
  let count = 1;
  let open = 0;
  let step = 1;
  while (inside(x + dx * step, y + dy * step) && board[index(x + dx * step, y + dy * step)] === color) {
    count++;
    step++;
  }
  if (inside(x + dx * step, y + dy * step) && board[index(x + dx * step, y + dy * step)] === 0) open++;
  step = 1;
  while (inside(x - dx * step, y - dy * step) && board[index(x - dx * step, y - dy * step)] === color) {
    count++;
    step++;
  }
  if (inside(x - dx * step, y - dy * step) && board[index(x - dx * step, y - dy * step)] === 0) open++;
  return patternScore(count, open);
}

function pointScore(board, x, y, color) {
  let total = 0;
  for (const [dx, dy] of DIRS) total += dirScore(board, x, y, dx, dy, color);
  return total;
}

function candidates(board) {
  const cells = [];
  let hasStone = false;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[index(x, y)] !== 0) {
        hasStone = true;
        break;
      }
    }
    if (hasStone) break;
  }
  if (!hasStone) return [{ x: 7, y: 7 }];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[index(x, y)] !== 0) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (inside(nx, ny) && board[index(nx, ny)] !== 0) {
            near = true;
            break;
          }
        }
      }
      if (near) cells.push({ x, y });
    }
  }
  return cells.length ? cells : [{ x: 7, y: 7 }];
}

// 返回局面上的攻防关键分：己方 attackMax、对手 defendMax（以己方视角评估对手威胁）
function gomokuThreats(board, color) {
  const opponent = 3 - color;
  const cells = candidates(board);
  let attackMax = 0;
  let defendMax = 0;
  for (const { x, y } of cells) {
    if (board[index(x, y)] !== 0) continue;
    board[index(x, y)] = color;
    attackMax = Math.max(attackMax, pointScore(board, x, y, color));
    board[index(x, y)] = 0;
    board[index(x, y)] = opponent;
    defendMax = Math.max(defendMax, pointScore(board, x, y, opponent));
    board[index(x, y)] = 0;
  }
  return { attackMax, defendMax };
}

// 本地启发式引擎：先找必胜/必防点，再按攻防综合分挑点
function pickLocalMove(board, color) {
  const opponent = 3 - color;
  const cells = candidates(board);
  let bestWin = null;
  let bestBlock = null;
  const scored = [];

  for (const { x, y } of cells) {
    board[index(x, y)] = color;
    const attack = pointScore(board, x, y, color);
    board[index(x, y)] = 0;

    board[index(x, y)] = opponent;
    const defend = pointScore(board, x, y, opponent);
    board[index(x, y)] = 0;

    if (attack >= 10_000_000) bestWin = bestWin || { x, y };
    if (defend >= 10_000_000) bestBlock = bestBlock || { x, y };

    const centerPull = 14 - (Math.abs(x - 7) + Math.abs(y - 7));
    scored.push({ x, y, total: attack * 1.08 + defend * 1.0 + centerPull * 3 });
  }

  if (bestWin) return bestWin;
  if (bestBlock) return bestBlock;

  scored.sort((a, b) => b.total - a.total);
  const top = scored.slice(0, Math.min(3, scored.length));
  const pool = top.filter((c) => c.total >= top[0].total * 0.92);
  return pool[crypto.randomInt(pool.length)];
}

// ------------------------------------------------------------ 象棋 AI

const CHESS_PIECE_VALUE = {
  K: 10000,
  R: 900,
  C: 450,
  N: 400,
  A: 200,
  B: 200,
  P: 100
};

// 棋子在不同位置的额外加成（红方视角，从上到下 y=9..0，越往前越加分）
function chessPieceBonus(piece, x, y, side) {
  let bonus = 0;
  const isRed = side === 'r';
  // 兵/卒过河越多越值钱
  if (piece.toUpperCase() === 'P') {
    const crossed = isRed ? y <= 4 : y >= 5;
    if (crossed) bonus += 40; // 过河兵 +40
    // 过河后横向走更灵活
    if (crossed) bonus += 10 * (isRed ? (4 - y) : (y - 5));
    // 车、马、炮越靠中线越好
  } else if (piece.toUpperCase() === 'R' || piece.toUpperCase() === 'C') {
    const centerDist = Math.abs(x - 4);
    bonus += 6 - centerDist; // 0-6
  } else if (piece.toUpperCase() === 'N') {
    const centerDist = Math.abs(x - 4);
    bonus += 4 - centerDist + Math.abs(isRed ? y - 7 : y - 2);
  }
  return bonus;
}

// 快速评估：己方 material - 对方 material（含位置加成）
function chessEvaluate(board, side) {
  let myScore = 0;
  let oppScore = 0;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    const type = p.toUpperCase();
    const s = p === type ? 'r' : 'b';
    const base = CHESS_PIECE_VALUE[type] || 0;
    const bonus = chessPieceBonus(type, i % Rules.Chess.WIDTH, Math.floor(i / Rules.Chess.WIDTH), s);
    const v = base + bonus;
    if (s === side) myScore += v;
    else oppScore += v;
  }
  return myScore - oppScore;
}

// 收集某一方的全部合法走法（含吃子标记）
function chessAllMoves(board, side) {
  const moves = [];
  const W = Rules.Chess.WIDTH;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || Rules.Chess.pieceColor(p) !== side) continue;
    const from = { x: i % W, y: Math.floor(i / W) };
    const targets = Rules.Chess.legalMoves(board, from.x, from.y);
    for (const to of targets) {
      const capIdx = Rules.Chess.index(to.x, to.y);
      const captured = board[capIdx];
      moves.push({ from, to, captured: captured || '', piece: p });
    }
  }
  return moves;
}

// 走法排序：先吃大子、再将军、最后乱序
function chessOrderMoves(board, side, moves) {
  return moves
    .map((m) => {
      let score = 0;
      if (m.captured) {
        const capType = m.captured.toUpperCase();
        const mineType = m.piece.toUpperCase();
        // 吃的子越值钱越好，送的子越不值钱越好（MVV-LVA）
        score += (CHESS_PIECE_VALUE[capType] || 0) * 10 - (CHESS_PIECE_VALUE[mineType] || 0);
      }
      // 走到中心附近略微加分
      score += 5 - Math.abs(m.to.x - 4);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((v) => v.m);
}

// alpha-beta 搜索，depth=2（快 + 够用）
function chessSearch(board, side, depth, alpha, beta) {
  const oppSide = side === 'r' ? 'b' : 'r';
  if (depth === 0) return { score: chessEvaluate(board, side) };

  const moves = chessOrderMoves(board, side, chessAllMoves(board, side));
  if (!moves.length) {
    // 无合法走法：被将死或困毙，视为大负分
    const inCheck = Rules.Chess.isInCheck(board, side);
    return { score: inCheck ? -90000 : -100 };
  }

  let bestMove = null;
  for (const m of moves) {
    const captured = board[Rules.Chess.index(m.to.x, m.to.y)];
    board[Rules.Chess.index(m.to.x, m.to.y)] = m.piece;
    board[Rules.Chess.index(m.from.x, m.from.y)] = '';

    let child;
    if (captured && captured.toUpperCase() === 'K') {
      child = { score: 90000 + depth }; // 直接吃将必胜
    } else {
      child = chessSearch(board, oppSide, depth - 1, -beta, -alpha);
      child.score = -child.score;
    }

    board[Rules.Chess.index(m.from.x, m.from.y)] = m.piece;
    board[Rules.Chess.index(m.to.x, m.to.y)] = captured || '';

    if (child.score > alpha) {
      alpha = child.score;
      bestMove = m;
    }
    if (alpha >= beta) break;
  }
  return { score: alpha, move: bestMove };
}

// 带快速必胜/必防检测的 alpha-beta 包装
function pickChessMove(board, side) {
  // 1) 能直接吃将就直接吃（或把对方将死）
  const moves = chessAllMoves(board, side);
  for (const m of moves) {
    if (m.captured && m.captured.toUpperCase() === 'K') return m;
  }
  // 1b) 走子后让对方无合法走法（将死）
  for (const m of moves) {
    const captured = board[Rules.Chess.index(m.to.x, m.to.y)];
    board[Rules.Chess.index(m.to.x, m.to.y)] = m.piece;
    board[Rules.Chess.index(m.from.x, m.from.y)] = '';
    const opp = side === 'r' ? 'b' : 'r';
    const mate = !Rules.Chess.hasLegalMove(board, opp);
    board[Rules.Chess.index(m.from.x, m.from.y)] = m.piece;
    board[Rules.Chess.index(m.to.x, m.to.y)] = captured || '';
    if (mate) return m;
  }

  // 2) alpha-beta depth=2
  const result = chessSearch(board, side, 2, -Infinity, Infinity);
  if (result.move) return result.move;

  // 3) 兜底：随便挑一个合法走法
  if (moves.length) return moves[crypto.randomInt(moves.length)];
  return null;
}

// 让模型看一个可读的棋盘，并要求只输出 JSON 坐标
async function askLLM(room, color) {
  if (!providerApiKey()) return null;
  const me = color === 1 ? '黑棋' : '白棋';
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    let line = '';
    for (let x = 0; x < SIZE; x++) {
      const v = room.board[index(x, y)];
      line += v === 0 ? '.' : v === 1 ? 'X' : 'O';
    }
    rows.push(`${String(y).padStart(2, '0')} ${line}`);
  }
  const recent = room.moves
    .slice(-6)
    .map((m) => `${m.color === 1 ? 'X' : 'O'}(${m.x},${m.y})`)
    .join(' ');

  const prompt = [
    `你在下十五路五子棋。你执${me}（X=黑=1，O=白=2），现在轮到你落子。`,
    '棋盘坐标：x 从左到右 0-14，y 从上到下 0-14；"." 是空位。',
    ...rows,
    `最近落子：${recent || '无'}`,
    '请选一个空位落子。优先考虑自己连五、阻止对手连五、以及形成活三/冲四。',
    '只输出一个 JSON，不要解释、不要代码块，例如：{"x":7,"y":7}'
  ].join('\n');

  // OpenRouter 免费层模型经常轮换关停，需要 fallback 列表兜底。
  // 其他官方供应商没有 fallback，失败直接返回 null 让本地引擎接管。
  const tried = new Set();
  const fallback = config.provider === 'openrouter' ? ASK_FALLBACK : [];
  const candidates = [providerModel(), ...fallback].filter((m) => m && !tried.has(m) && tried.add(m));

  let lastError = null;
  for (const model of candidates) {
    const move = await tryModel(model, prompt, room);
    if (move) return move;
    lastError = tryModel._lastError || lastError;
    await sleep(250);
  }

  if (lastError) askLLM._lastError = lastError;
  return null;
}

async function tryModel(model, prompt, room) {
  const baseURL = providerBaseURL().replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const isOpenRouter = config.provider === 'openrouter';
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerApiKey()}`,
        ...(isOpenRouter ? {
          'HTTP-Referer': `http://localhost:${PORT}`,
          'X-Title': 'Gomoku Online'
        } : {})
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是五子棋高手，回答必须是一个 JSON 对象。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400,
        temperature: 0.25
      }),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      tryModel._lastError = `${model.split('/').pop()} HTTP ${response.status}`;
      return null;
    }
    let data;
    try { data = JSON.parse(text); } catch { tryModel._lastError = `${model} JSON 解析失败`; return null; }
    const message = data?.choices?.[0]?.message || {};
    const content = message.content;
    const parsed = parseMove(content, room.board);
    if (parsed) return parsed;
    if (!content && message.reasoning) {
      return parseMove(message.reasoning, room.board, true);
    }
    tryModel._lastError = `${model} 未返回可解析坐标`;
    return null;
  } catch (err) {
    tryModel._lastError = `${model.split('/').pop()} ${err.name}`;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseMove(content, board, preferLast = false) {
  if (!content) return null;
  const text = Array.isArray(content)
    ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
    : String(content);

  const jsonMatches = text.match(/\{[^{}]*"x"[^{}]*"y"[^{}]*\}/gi) || [];
  const ordered = preferLast ? jsonMatches.slice().reverse() : jsonMatches;
  for (const candidate of ordered) {
    try {
      const obj = JSON.parse(candidate);
      const x = Number(obj.x);
      const y = Number(obj.y);
      if (validMove(board, x, y)) return { x, y };
    } catch {
      /* 继续尝试其它格式 */
    }
  }

  const loose = text.match(/[xX]\s*[=:：]?\s*(\d{1,2})\D{1,12}[yY]\s*[=:：]?\s*(\d{1,2})/g);
  if (loose) {
    const list = preferLast ? loose.slice().reverse() : loose;
    for (const item of list) {
      const nums = item.match(/\d{1,3}/g) || [];
      const x = Number(nums[0]);
      const y = Number(nums[1]);
      if (validMove(board, x, y)) return { x, y };
    }
  }

  const algebraic = text.match(/\b([A-Oa-o])\s*-?\s*(\d{1,2})\b/g);
  if (algebraic) {
    const list = preferLast ? algebraic.slice().reverse() : algebraic;
    for (const item of list) {
      const parts = item.match(/[A-Oa-o]|\d{1,2}/g) || [];
      const x = parts[0].toUpperCase().charCodeAt(0) - 65;
      const y = Number(parts[1]) - 1;
      if (validMove(board, x, y)) return { x, y };
    }
  }
  return null;
}

function validMove(board, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && inside(x, y) && board[index(x, y)] === 0;
}

// 象棋走子：校验起点归属、规则合法性，并处理将死 / 吃将
function applyChessMove(room, player, move, source) {
  if (room.status !== 'playing') return { error: '对局未开始' };
  if (player.color !== room.turn) return { error: '还没轮到你' };

  const from = move && move.from;
  const to = move && move.to;
  if (!from || !to) return { error: '走法格式不正确' };
  if (!Rules.Chess.inBoard(from.x, from.y) || !Rules.Chess.inBoard(to.x, to.y)) {
    return { error: '坐标超出棋盘' };
  }

  const piece = room.board[Rules.Chess.index(from.x, from.y)];
  if (!piece) return { error: '起点没有棋子' };
  if (Rules.Chess.sideToPlayer(Rules.Chess.pieceColor(piece)) !== player.color) {
    return { error: '这不是你的棋子' };
  }
  if (!Rules.Chess.isLegalMove(room.board, from, to)) {
    return { error: '这一步不合象棋规则' };
  }

  const info = Rules.Chess.applyMove(room.board, from, to);
  room.moves.push({
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    piece: info.piece,
    captured: info.captured || '',
    color: player.color,
    by: player.isAI ? 'ai' : 'human',
    source: source || 'human',
    at: Date.now()
  });
  room.updatedAt = Date.now();

  const opponent = 3 - player.color;
  if (info.capturedGeneral) {
    room.status = 'finished';
    room.winner = player.color;
    room.winReason = 'capture';
    recordWinIfHuman(room);
    broadcast(room);
    return { ok: true };
  }
  if (!Rules.Chess.hasLegalMove(room.board, Rules.Chess.playerToSide(opponent))) {
    room.status = 'finished';
    room.winner = player.color;
    room.winReason = 'checkmate';
    recordWinIfHuman(room);
    broadcast(room);
    return { ok: true };
  }

  room.turn = opponent;
  broadcast(room);

  if (room.mode === 'ai' && room.status === 'playing' && room.turn === 2) {
    runAI(room).catch((err) => {
      room.aiBusy = false;
      if (room.ai) room.ai.thinking = false;
      console.error('[chess ai] 未捕获错误:', err);
      broadcast(room);
    });
  }

  return { ok: true };
}

function applyGoAction(room, player, move, source) {
  if (room.status !== 'playing') return { error: '对局未开始' };
  if (player.color !== room.turn) return { error: '还没轮到你落子' };

  // 停一手
  if (move.pass) {
    room.passes = (room.passes || 0) + 1;
    room.ko = null;
    room.moves.push({
      pass: true,
      color: player.color,
      by: player.isAI ? 'ai' : 'human',
      source: source || 'human',
      at: Date.now()
    });
    room.updatedAt = Date.now();
    if (room.passes >= 2) {
      finishGo(room);
    } else {
      room.turn = 3 - room.turn;
      broadcast(room);
    }
    if (room.status === 'playing') scheduleGoAI(room);
    return { ok: true };
  }

  const result = Go.play(room.board, move.x, move.y, player.color, room.ko);
  if (result.error) return { error: result.error };

  room.board = result.board;
  room.ko = result.koPoint;
  if (!room.captures) room.captures = { 1: 0, 2: 0 };
  room.captures[player.color] += result.captured.length;
  room.passes = 0;
  room.moves.push({
    x: move.x,
    y: move.y,
    color: player.color,
    captures: result.captured.length,
    by: player.isAI ? 'ai' : 'human',
    source: source || 'human',
    at: Date.now()
  });
  room.turn = 3 - room.turn;
  room.updatedAt = Date.now();

  if (room.board.every((v) => v !== 0)) finishGo(room);
  else broadcast(room);
  if (room.status === 'playing') scheduleGoAI(room);
  return { ok: true };
}

function finishGo(room) {
  const s = Go.score(room.board);
  room.score = s;
  room.status = 'finished';
  room.winner = s.winner;
  room.winReason = 'score';
  room.draw = false;
  room.updatedAt = Date.now();
  recordWinIfHuman(room);
  broadcast(room);
}

function scheduleGoAI(room) {
  if (room.status !== 'playing') return;
  const ai = room.players.find((p) => p.isAI);
  if (!ai || room.turn !== ai.color) return;
  if (room.ai) {
    room.ai.thinking = true;
    room.ai.error = '';
  }
  broadcast(room);

  const lastMove = room.moves[room.moves.length - 1];
  const opponentPassed = Boolean(lastMove && lastMove.pass);
  setTimeout(() => {
    if (room.status !== 'playing' || room.turn !== ai.color) return;
    const move = Go.aiMove(room.board, ai.color, room.ko, opponentPassed);
    if (room.ai) {
      room.ai.thinking = false;
      room.ai.source = 'local';
    }
    applyGoAction(room, ai, move, 'local');
  }, 500);
}

// ---------------------------------------------------------------- 房间

const rooms = new Map();

function createRoom({ name, mode, aiEngine, playerName, playerId, game, userId }) {
  const code = makeCode();
  const gameType = game === 'chess' ? 'chess' : game === 'go' ? 'go' : 'gomoku';
  const isAI = mode === 'ai';
  const engine = isAI ? (aiEngine === 'local' ? 'local' : 'llm') : null;
  const host = {
    id: playerId || makeId(),
    name: playerName,
    color: 1,
    isAI: false,
    connected: true,
    userId
  };
  const room = {
    code,
    game: gameType,
    name,
    mode: isAI ? 'ai' : 'pvp',
    status: isAI ? 'playing' : 'waiting',
    board: createBoard(gameType),
    turn: 1,
    players: [host],
    hostId: host.id,
    winner: 0,
    winLine: null,
    winReason: '',
    draw: false,
    moves: [],
    messages: [],
    clients: new Set(),
    // 围棋专用状态
    ko: null,
    passes: 0,
    captures: { 1: 0, 2: 0 },
    score: null,
    ai: isAI
      ? { thinking: false, error: '', source: '', engine: engine }
      : null,
    aiEngine: engine,
    aiBusy: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  if (isAI) {
    const effectiveEngine = engine === 'llm' && !providerApiKey() ? 'local' : engine;
    // 围棋只有本地引擎
    const useEngine = gameType === 'go' ? 'local' : effectiveEngine;
    room.aiEngine = useEngine;
    room.ai.engine = useEngine;
    room.players.push({
      id: 'ai',
      name: 'AI 棋手',
      color: 2,
      isAI: true,
      connected: true
    });
    room.ai.autoNote = engine === 'llm' && effectiveEngine === 'local' ? '未配置 API Key，已使用本地引擎' : '';
  }
  rooms.set(code, room);
  return room;
}

function playerOf(room, playerId) {
  return room.players.find((p) => p.id === playerId && !p.isAI);
}

// 校验：请求者是否拥有该玩家位置（已登录且 userId 匹配）
function authorOf(room, playerId, session) {
  if (!session) return null;
  const player = playerOf(room, playerId);
  if (!player) return null;
  if (player.userId !== session.userId) return null;
  return player;
}

function publicRoom(room) {
  const sideToMove = room.game === 'chess' ? Rules.Chess.playerToSide(room.turn) : null;
  let boardData;
  if (room.game === 'go') {
    boardData = {
      size: Go.SIZE,
      komi: Go.KOMI,
      grid: Array.from(room.board),
      captures: room.captures || { 1: 0, 2: 0 },
      ko: room.ko ?? null,
      passes: room.passes || 0,
      score: room.score || null
    };
  } else {
    boardData = Array.from(room.board);
  }
  return {
    code: room.code,
    game: room.game,
    name: room.name,
    mode: room.mode,
    status: room.status,
    board: boardData,
    turn: room.turn,
    check:
      room.game === 'chess' && room.status === 'playing'
        ? Rules.Chess.isInCheck(room.board, sideToMove)
        : false,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isAI: p.isAI,
      connected: p.connected
    })),
    hostId: room.hostId,
    winner: room.winner,
    winLine: room.winLine,
    winReason: room.winReason || '',
    draw: room.draw,
    moves: room.moves,
    messages: room.messages.slice(-50),
    ai: room.ai
      ? {
          thinking: room.ai.thinking,
          error: room.ai.error,
          source: room.ai.source,
          engine: room.aiEngine,
          autoNote: room.ai.autoNote || ''
        }
      : null,
    spectators: Math.max(0, room.clients.size - room.players.filter((p) => p.connected && !p.isAI).length),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function publicRoomSummary(room) {
  const humans = room.players.filter((p) => !p.isAI);
  const playerInfo = humans.map((p) => {
    const u = p.userId ? userById(p.userId) : null;
    let avatar = '';
    if (u) {
      const priv = u.privacy || {};
      avatar = priv.showAvatarInLobby === false ? '' : (u.avatar || randomAvatar());
    }
    return { id: p.id, name: p.name, avatar, userId: p.userId };
  });
  return {
    code: room.code,
    game: room.game,
    name: room.name,
    mode: room.mode,
    status: room.status,
    players: humans.length + (room.mode === 'ai' ? 1 : 0),
    humanCount: humans.length,
    capacity: 2,
    aiEngine: room.aiEngine,
    winner: room.winner,
    draw: room.draw,
    playerInfo,
    createdAt: room.createdAt
  };
}

function broadcast(room) {
  for (const client of room.clients) {
    try {
      const payload = `event: state\ndata: ${JSON.stringify(publicRoom(room))}\n\n`;
      client.res.write(payload);
    } catch {
      /* 连接已断，close 事件会清理 */
    }
  }
}

function broadcastChat(room, msg) {
  const payload = `event: chat\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const client of room.clients) {
    try {
      client.res.write(payload);
    } catch {
      /* 连接已断 */
    }
  }
}

function refreshPresence(room) {
  for (const player of room.players) {
    if (player.isAI) continue;
    let online = false;
    for (const client of room.clients) {
      if (client.playerId === player.id) {
        online = true;
        break;
      }
    }
    if (player.connected !== online) {
      player.connected = online;
    }
  }
  room.updatedAt = Date.now();
}

function applyMove(room, player, move, source) {
  if (room.game === 'chess') return applyChessMove(room, player, move, source);
  if (room.game === 'go') return applyGoAction(room, player, move, source);

  const x = move.x;
  const y = move.y;
  if (room.status !== 'playing') return { error: '对局未开始' };
  if (!validMove(room.board, x, y)) return { error: '该位置不能落子' };
  if (player.color !== room.turn) return { error: '还没轮到你' };

  room.board[index(x, y)] = player.color;
  room.moves.push({
    x,
    y,
    color: player.color,
    by: player.isAI ? 'ai' : 'human',
    source: source || 'human',
    at: Date.now()
  });
  room.updatedAt = Date.now();

  const line = checkWin(room.board, x, y, player.color);
  if (line) {
    room.status = 'finished';
    room.winner = player.color;
    room.winLine = line;
    recordWinIfHuman(room);
    broadcast(room);
    return { ok: true };
  }
  if (room.moves.length >= CELLS) {
    room.status = 'finished';
    room.winner = 0;
    room.draw = true;
    broadcast(room);
    return { ok: true };
  }

  room.turn = 3 - room.turn;
  broadcast(room);

  if (room.mode === 'ai' && room.status === 'playing' && room.turn === 2) {
    runAI(room).catch((err) => {
      room.aiBusy = false;
      if (room.ai) room.ai.thinking = false;
      console.error('[ai] 未捕获错误:', err);
      broadcast(room);
    });
  }
  return { ok: true };
}

async function runAI(room) {
  if (room.mode !== 'ai' || room.status !== 'playing' || room.aiBusy) return;
  const ai = room.players.find((p) => p.isAI);
  if (!ai || room.turn !== ai.color) return;

  room.aiBusy = true;
  room.ai.thinking = true;
  room.ai.error = '';
  room.ai.source = '';
  broadcast(room);

  const started = Date.now();
  let move = null;
  let source = 'local';

  if (room.game === 'chess') {
    // 象棋：永远走本地启发式（LLM 对复杂坐标/非法棋不可靠）
    const remain = 600 - (Date.now() - started);
    if (remain > 0) await sleep(remain);
    move = pickChessMove(room.board, ai.color === 1 ? 'r' : 'b');
    source = 'local';
  } else if (room.aiEngine === 'llm' && providerApiKey()) {
    try {
      move = await askLLM(room, ai.color);
      if (move) source = 'llm';
      else room.ai.error = '模型未返回合法落子，已由本地引擎接手';
    } catch (err) {
      room.ai.error = `模型调用失败：${shortError(err)}`;
    }

    // 安全校验：LLM 返回的落子不能忽略必胜/必防点
    if (move) {
      const threats = gomokuThreats(room.board, ai.color);
      // 阈值说明（patternScore 输出）：
      //   ≥ 10_000_000 → 对方直接连五（必须堵）
      //   ≥   1_000_000 → 对方活四/冲四（必须堵）
      //   ≥      45_000 → 对方活三（必须堵，否则下回合就冲四）
      const mustPlay = threats.attackMax >= 45_000;
      const mustBlock = threats.defendMax >= 45_000;
      if (mustPlay || mustBlock) {
        const safetyMove = pickLocalMove(room.board, ai.color);
        if (safetyMove && (safetyMove.x !== move.x || safetyMove.y !== move.y)) {
          room.ai.error = '模型漏判关键棋型，已由本地引擎接管';
          move = safetyMove;
          source = 'local';
        }
      }
    }
  }

  if (!move) {
    const remain = 420 - (Date.now() - started);
    if (remain > 0) await sleep(remain);
    move = pickLocalMove(room.board, ai.color);
    source = 'local';
  }

  room.aiBusy = false;
  room.ai.thinking = false;
  room.ai.source = source;

  if (room.status !== 'playing') {
    broadcast(room);
    return;
  }
  if (!move) {
    room.ai.error = room.ai.error || 'AI 找不到可落子的位置';
    broadcast(room);
    return;
  }

  if (room.game === 'chess') {
    applyMove(room, ai, { from: { x: move.from.x, y: move.from.y }, to: { x: move.to.x, y: move.to.y } }, source);
  } else {
    applyMove(room, ai, { x: move.x, y: move.y }, source);
  }
}

function resetRoom(room) {
  room.board = createBoard(room.game);
  room.status = 'playing';
  room.turn = 1;
  room.winner = 0;
  room.winLine = null;
  room.winReason = '';
  room.draw = false;
  room.moves = [];
  room.aiBusy = false;
  room.ko = null;
  room.passes = 0;
  room.captures = { 1: 0, 2: 0 };
  room.score = null;
  room.updatedAt = Date.now();
  if (room.ai) {
    room.ai.thinking = false;
    room.ai.error = '';
    room.ai.source = '';
  }
}

// ---------------------------------------------------------------- HTTP

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJSON(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const isShared = pathname.startsWith('/shared/');
  const baseDir = isShared ? SHARED_DIR : PUBLIC_DIR;
  const relative = isShared ? pathname.slice('/shared'.length) : pathname;
  const filePath = path.join(baseDir, path.normalize(relative));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 单页应用回退
      if (!path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function handleSSE(req, res, room) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const url = new URL(req.url, 'http://localhost');
  const playerId = url.searchParams.get('playerId') || '';
  const client = { res, playerId };
  room.clients.add(client);
  refreshPresence(room);

  res.write(`event: state\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);
  broadcast(room);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 忽略 */
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.clients.delete(client);
    setTimeout(() => {
      refreshPresence(room);
      broadcast(room);
    }, 1_200);
  });
}

async function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      const cur = providerConfig();
      const hasKey = Boolean(providerApiKey());
      return sendJSON(res, 200, {
        provider: config.provider,
        hasKey,
        keyMasked: maskKey(providerApiKey()),
        baseURL: cur.baseURL || '',
        model: providerModel(),
        providerList: Object.entries(PROVIDERS).map(([id, p]) => ({
          id,
          name: p.name,
          baseURL: p.baseURL,
          defaultModel: p.defaultModel,
          keyPlaceholder: p.keyPlaceholder,
          models: p.models
        }))
      });
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      if (typeof body.provider === 'string' && config.providers[body.provider]) {
        config.provider = body.provider;
      }
      if (body.providers && typeof body.providers === 'object') {
        for (const id of Object.keys(config.providers)) {
          const incoming = body.providers[id];
          if (!incoming) continue;
          const cur = config.providers[id];
          if (typeof incoming.apiKey === 'string') {
            const trimmed = incoming.apiKey.trim();
            if (incoming.clearKey) cur.apiKey = '';
            else if (trimmed) cur.apiKey = trimmed;
          }
          if (typeof incoming.baseURL === 'string') {
            cur.baseURL = incoming.baseURL.trim();
          }
          if (typeof incoming.model === 'string' && incoming.model.trim()) {
            cur.model = incoming.model.trim();
          }
        }
      }
      // 兼容老的单字段提交（只改当前 provider）
      const cur = providerConfig();
      if (typeof body.apiKey === 'string') {
        const trimmed = body.apiKey.trim();
        if (body.clearKey) cur.apiKey = '';
        else if (trimmed) cur.apiKey = trimmed;
      }
      if (typeof body.baseURL === 'string') cur.baseURL = body.baseURL.trim();
      if (typeof body.model === 'string' && body.model.trim()) cur.model = body.model.trim();

      saveConfig();
      return sendJSON(res, 200, {
        provider: config.provider,
        hasKey: Boolean(providerApiKey()),
        keyMasked: maskKey(providerApiKey()),
        baseURL: cur.baseURL || '',
        model: providerModel()
      });
    }
    return sendJSON(res, 405, { error: '方法不支持' });
  }

  if (pathname === '/api/config/test' && method === 'POST') {
    if (!providerApiKey()) return sendJSON(res, 400, { ok: false, error: '还没有配置 API Key' });
    try {
      const baseURL = providerBaseURL().replace(/\/+$/, '');
      const meta = providerMeta();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      // OpenRouter 有专门的 /key 接口；其它 OpenAI 兼容供应商用 /models 探测
      const testUrl = meta.testPath ? `${baseURL}${meta.testPath}` : `${baseURL}/models`;
      const response = await fetch(testUrl, {
        headers: { Authorization: `Bearer ${providerApiKey()}` },
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await response.text();
      if (!response.ok) {
        return sendJSON(res, 200, {
          ok: false,
          error: `${meta.name} 返回 ${response.status}：${text.slice(0, 160)}`
        });
      }
      if (config.provider === 'openrouter') {
        const data = JSON.parse(text).data || {};
        return sendJSON(res, 200, {
          ok: true,
          label: data.label || '',
          freeTier: Boolean(data.is_free_tier),
          usage: data.usage ?? 0,
          freeRemaining: data.free_model_daily_requests
            ? data.free_model_daily_requests.remaining
            : null,
          freeLimit: data.free_model_daily_requests ? data.free_model_daily_requests.limit : null
        });
      }
      return sendJSON(res, 200, { ok: true, label: `${meta.name} 密钥有效` });
    } catch (err) {
      return sendJSON(res, 200, { ok: false, error: shortError(err) });
    }
  }

  if (pathname === '/api/models' && method === 'GET') {
    const meta = providerMeta();
    // OpenRouter 动态拉取免费模型列表，其它供应商用内置列表
    if (config.provider === 'openrouter') {
      try {
        if (!modelCache.data || Date.now() - modelCache.at > 10 * 60_000) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12_000);
          const response = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
          clearTimeout(timer);
          const payload = await response.json();
          const list = (payload.data || [])
            .filter((m) => typeof m.id === 'string' && m.id.endsWith(':free'))
            .map((m) => ({ id: m.id, name: m.name || m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
          if (list.length) modelCache = { at: Date.now(), data: list };
        }
      } catch {
        /* 使用兜底列表 */
      }
      return sendJSON(res, 200, {
        models: modelCache.data || FALLBACK_MODELS,
        defaultModel: providerModel()
      });
    }
    return sendJSON(res, 200, {
      models: meta.models,
      defaultModel: providerModel()
    });
  }

  // ---------------- 鉴权 ----------------

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJSON(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (username.length < 2 || username.length > 16) {
      return sendJSON(res, 400, { error: '用户名长度需 2-16 位' });
    }
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(username)) {
      return sendJSON(res, 400, { error: '用户名只能包含中英文、数字、下划线、点、减号' });
    }
    if (password.length < 4 || password.length > 64) {
      return sendJSON(res, 400, { error: '密码长度需 4-64 位' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJSON(res, 400, { error: '邮箱格式不正确' });
    }
    if (findUser(username)) {
      return sendJSON(res, 409, { error: '该用户名已被注册' });
    }
    if (email && findUserByEmail(email)) {
      return sendJSON(res, 409, { error: '该邮箱已被注册' });
    }
    const user = createUserRecord(username, password, false, email);
    users.push(user);
    saveUsers();
    const token = createSession(user);
    return sendJSON(res, 200, { token, user: publicUser(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJSON(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = findUser(username);
    if (!user || !verifyPassword(user, password)) {
      return sendJSON(res, 401, { error: '用户名或密码错误' });
    }
    if (user.banned) {
      return sendJSON(res, 403, { error: `账号已被封禁${user.banReason ? '：' + user.banReason : ''}` });
    }
    const token = createSession(user);
    return sendJSON(res, 200, { token, user: publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const session = getSession(req);
    if (session) {
      const header = req.headers['authorization'] || '';
      const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (token) sessions.delete(token);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const session = getSession(req);
    if (!session) return sendJSON(res, 401, { error: '未登录' });
    const user = users.find((u) => u.id === session.userId);
    if (!user) return sendJSON(res, 401, { error: '账号不存在' });
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  // 发送密码重置验证码
  if (pathname === '/api/auth/forgot-password' && method === 'POST') {
    const body = await readJSON(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return sendJSON(res, 400, { error: '请输入邮箱' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJSON(res, 400, { error: '邮箱格式不正确' });
    }
    const user = findUserByEmail(email);
    if (!user) {
      // 不暴露该邮箱是否注册，统一返回成功
      return sendJSON(res, 200, { ok: true });
    }
    pruneResetCodes();
    const existing = resetCodes.get(email);
    // 60 秒内不能重复发送
    if (existing && Date.now() - existing.sentAt < 60_000) {
      return sendJSON(res, 429, { error: '发送过于频繁，请稍后再试' });
    }
    const code = makeResetCode();
    resetCodes.set(email, { code, userId: user.id, expiresAt: Date.now() + RESET_CODE_TTL, attempts: 0, sentAt: Date.now() });
    try {
      const result = await sendResetEmail(email, code, user.username);
      return sendJSON(res, 200, { ok: true, dev: result.dev || false });
    } catch (e) {
      return sendJSON(res, 500, { error: '邮件发送失败，请稍后重试' });
    }
  }

  // 重置密码
  if (pathname === '/api/auth/reset-password' && method === 'POST') {
    const body = await readJSON(req);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!email || !code) return sendJSON(res, 400, { error: '请输入邮箱和验证码' });
    if (newPassword.length < 4 || newPassword.length > 64) {
      return sendJSON(res, 400, { error: '密码长度需 4-64 位' });
    }
    pruneResetCodes();
    const record = resetCodes.get(email);
    if (!record) return sendJSON(res, 400, { error: '验证码无效或已过期' });
    record.attempts += 1;
    if (record.attempts > RESET_MAX_ATTEMPTS) {
      resetCodes.delete(email);
      return sendJSON(res, 400, { error: '验证次数过多，请重新获取验证码' });
    }
    if (record.code !== code) {
      return sendJSON(res, 400, { error: '验证码错误' });
    }
    const user = getUserById(record.userId);
    if (!user) return sendJSON(res, 400, { error: '账号不存在' });
    setPassword(user, newPassword);
    saveUsers();
    resetCodes.delete(email);
    // 踢掉该用户所有现有 session
    for (const [tok, s] of sessions) {
      if (s.userId === user.id) sessions.delete(tok);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ---------------- 房间（需登录） ----------------

  if (pathname === '/api/rooms') {
    if (method === 'GET') {
      const list = Array.from(rooms.values())
        .filter((room) => Date.now() - room.updatedAt < 6 * 3600_000)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 40)
        .map(publicRoomSummary);
      return sendJSON(res, 200, { rooms: list });
    }
    if (method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const game = body.game === 'chess' ? 'chess' : body.game === 'go' ? 'go' : 'gomoku';
      const fallbackName = game === 'chess' ? '无名棋局' : game === 'go' ? '围棋对局' : '无名对局';
      const name = String(body.name || '').trim().slice(0, 24) || fallbackName;
      const playerName = session.username;
      const mode = body.mode === 'ai' ? 'ai' : 'pvp';
      const room = createRoom({
        name,
        game,
        mode,
        aiEngine: body.aiEngine === 'local' ? 'local' : 'llm',
        playerName,
        userId: session.userId
      });
      const player = room.players[0];
      setTimeout(() => broadcast(room), 0);
      const mySeat = 0;
      return sendJSON(res, 200, {
        room: publicRoom(room, mySeat),
        playerId: player.id,
        color: player.color
      });
    }
    return sendJSON(res, 405, { error: '方法不支持' });
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{1,12})(?:\/([a-z]+))?$/);
  if (roomMatch) {
    const code = roomMatch[1].toUpperCase();
    const action = roomMatch[2];
    const room = rooms.get(code);
    if (!room) return sendJSON(res, 404, { error: '房间不存在' });

    if (!action && method === 'GET') {
      return sendJSON(res, 200, { room: publicRoom(room) });
    }

    if (action === 'events' && method === 'GET') {
      return handleSSE(req, res, room);
    }

    if (action === 'join' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const playerId = String(body.playerId || '');
      let player = playerOf(room, playerId);
      if (!player) {
        if (room.mode === 'ai' || room.players.filter((p) => !p.isAI).length >= 2) {
          return sendJSON(res, 409, { error: '房间已满' });
        }
        player = {
          id: makeId(),
          name: session.username,
          color: 2,
          isAI: false,
          connected: true,
          userId: session.userId
        };
        room.players.push(player);
        room.status = 'playing';
        room.turn = 1;
        room.updatedAt = Date.now();
      } else {
        if (player.userId !== session.userId) {
          return sendJSON(res, 403, { error: '这不是你的位置' });
        }
        player.connected = true;
        player.name = session.username;
      }
      broadcast(room);
      const mySeat = 0;
      return sendJSON(res, 200, {
        room: publicRoom(room, mySeat),
        playerId: player.id,
        color: player.color
      });
    }

    if (action === 'move' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const player = authorOf(room, String(body.playerId || ''), session);
      if (!player) return sendJSON(res, 403, { error: '你不在这个房间里' });

      let move;
      if (room.game === 'chess') {
        const from = body.from || { x: Number(body.fromX), y: Number(body.fromY) };
        const to = body.to || { x: Number(body.toX), y: Number(body.toY) };
        move = {
          from: { x: Number(from.x), y: Number(from.y) },
          to: { x: Number(to.x), y: Number(to.y) }
        };
      } else if (room.game === 'go') {
        move = { x: Number(body.x), y: Number(body.y), pass: Boolean(body.pass) };
      } else {
        move = { x: Number(body.x), y: Number(body.y) };
      }

      const result = applyMove(room, player, move, 'human');
      if (result.error) return sendJSON(res, 400, result);
      return sendJSON(res, 200, { ok: true, room: publicRoom(room) });
    }

    if (action === 'resign' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const player = authorOf(room, String(body.playerId || ''), session);
      if (!player) return sendJSON(res, 403, { error: '你不在这个房间里' });
      if (room.status === 'playing') {
        room.status = 'finished';
        room.winner = 3 - player.color;
        if (room.game === 'go') room.winReason = 'resign';
        room.winLine = null;
        room.updatedAt = Date.now();
        recordWinIfHuman(room);
        broadcast(room);
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'rematch' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const player = authorOf(room, String(body.playerId || ''), session);
      if (!player) return sendJSON(res, 403, { error: '你不在这个房间里' });
      if (room.status !== 'finished') return sendJSON(res, 400, { error: '对局还没结束' });
      if (room.mode === 'pvp' && room.players.filter((p) => !p.isAI).length < 2) {
        return sendJSON(res, 409, { error: '等待对手加入后再开新局' });
      }
      resetRoom(room);
      broadcast(room);
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'leave' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const player = authorOf(room, String(body.playerId || ''), session);
      if (player) {
        if (room.status === 'playing' && room.mode === 'pvp') {
          room.status = 'finished';
          room.winner = 3 - player.color;
          recordWinIfHuman(room);
        }
        room.players = room.players.filter((p) => p.id !== player.id);
        room.players.forEach((p) => {
          if (!p.isAI) p.connected = false;
        });
        if (!room.players.some((p) => !p.isAI)) {
          for (const client of room.clients) {
            try {
              client.res.end();
            } catch {
              /* 忽略 */
            }
          }
          rooms.delete(room.code);
          return sendJSON(res, 200, { ok: true });
        }
        room.updatedAt = Date.now();
        broadcast(room);
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'chat' && method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readJSON(req);
      const player = authorOf(room, String(body.playerId || ''), session);
      if (!player) return sendJSON(res, 403, { error: '你不在这个房间里' });
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) return sendJSON(res, 400, { error: '消息不能为空' });
      const msg = {
        id: makeId(),
        playerId: player.id,
        name: player.name,
        color: player.color,
        text,
        at: Date.now()
      };
      room.messages.push(msg);
      if (room.messages.length > 50) room.messages = room.messages.slice(-50);
      room.updatedAt = Date.now();
      broadcastChat(room, msg);
      return sendJSON(res, 200, { ok: true, msg });
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  }

  // ---------------- 头像 ----------------
  if (pathname === '/api/auth/avatar' && method === 'PUT') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const avatar = String(body.avatar || '').trim();
    if (!avatar) return sendJSON(res, 400, { error: '头像不能为空' });
    // 支持 emoji / http URL / base64 data URL（限制 512KB）
    const isDataUrl = avatar.startsWith('data:image/');
    const isHttpUrl = avatar.startsWith('http://') || avatar.startsWith('https://');
    if (!isDataUrl && !isHttpUrl && avatar.length > 16) {
      return sendJSON(res, 400, { error: '头像格式不正确' });
    }
    if (isDataUrl && avatar.length > 512 * 1024) {
      return sendJSON(res, 400, { error: '图片过大，请压缩后重试' });
    }
    if (isHttpUrl && avatar.length > 512) {
      return sendJSON(res, 400, { error: '图片 URL 过长' });
    }
    const user = getUserById(session.userId);
    if (!user) return sendJSON(res, 404, { error: '用户不存在' });
    user.avatar = avatar;
    saveUsers();
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  // ---------------- 隐私设置 ----------------
  if (pathname === '/api/auth/privacy' && method === 'PUT') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const user = getUserById(session.userId);
    if (!user) return sendJSON(res, 404, { error: '用户不存在' });
    if (!user.privacy) user.privacy = {};
    if (body.showAvatarInLobby !== undefined) user.privacy.showAvatarInLobby = Boolean(body.showAvatarInLobby);
    if (body.showAvatarInLeaderboard !== undefined) user.privacy.showAvatarInLeaderboard = Boolean(body.showAvatarInLeaderboard);
    saveUsers();
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  // ---------------- 排行榜 ----------------
  if (pathname === '/api/leaderboard' && method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const period = params.get('period') || 'daily';
    const game = params.get('game') || 'gomoku';
    const rows = leaderboard(period, game);
    return sendJSON(res, 200, { period, game, rows });
  }

  // ---------------- 用户搜索 ----------------
  if (pathname === '/api/users/search' && method === 'GET') {
    const session = requireUser(req, res);
    if (!session) return;
    const q = String(new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return sendJSON(res, 200, { users: [] });
    const me = getUserById(session.userId);
    const results = users
      .filter((u) => u.id !== session.userId)
      .filter((u) => u.username.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
      .slice(0, 20)
      .map((u) => ({
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        isFriend: me && me.friends.includes(u.id),
        outgoing: me && me.outgoing.some((r) => r.userId === u.id),
        incoming: me && me.incoming.some((r) => r.userId === u.id)
      }));
    return sendJSON(res, 200, { users: results });
  }

  // ---------------- 好友 ----------------
  if (pathname === '/api/friends' && method === 'GET') {
    const session = requireUser(req, res);
    if (!session) return;
    const me = getUserById(session.userId);
    if (!me) return sendJSON(res, 404, { error: '用户不存在' });
    const friends = me.friends.map((fid) => {
      const u = getUserById(fid);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar, online: isOnline(u.id) };
    }).filter(Boolean);
    const incoming = me.incoming.map((r) => {
      const u = getUserById(r.userId);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar, at: r.at };
    }).filter(Boolean);
    const outgoing = me.outgoing.map((r) => {
      const u = getUserById(r.userId);
      if (!u) return null;
      return { id: u.id, username: u.username, avatar: u.avatar, at: r.at };
    }).filter(Boolean);
    return sendJSON(res, 200, { friends, incoming, outgoing });
  }

  if (pathname === '/api/friends/request' && method === 'POST') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const targetId = String(body.userId || '');
    if (targetId === session.userId) return sendJSON(res, 400, { error: '不能加自己' });
    const me = getUserById(session.userId);
    const target = getUserById(targetId);
    if (!target) return sendJSON(res, 404, { error: '用户不存在' });
    if (me.friends.includes(targetId)) return sendJSON(res, 400, { error: '已经是好友' });
    if (me.outgoing.some((r) => r.userId === targetId)) return sendJSON(res, 400, { error: '已发送过请求' });
    me.outgoing = me.outgoing.filter((r) => r.userId !== targetId);
    me.outgoing.push({ userId: targetId, at: Date.now() });
    target.incoming = target.incoming.filter((r) => r.userId !== session.userId);
    target.incoming.push({ userId: session.userId, at: Date.now() });
    saveUsers();
    pushUserEvent(targetId, { type: 'friend_request', from: { id: me.id, username: me.username, avatar: me.avatar } });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/friends/accept' && method === 'POST') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const fromId = String(body.userId || '');
    const me = getUserById(session.userId);
    const from = getUserById(fromId);
    if (!from) return sendJSON(res, 404, { error: '用户不存在' });
    me.incoming = me.incoming.filter((r) => r.userId !== fromId);
    from.outgoing = from.outgoing.filter((r) => r.userId !== session.userId);
    if (!me.friends.includes(fromId)) me.friends.push(fromId);
    if (!from.friends.includes(session.userId)) from.friends.push(session.userId);
    saveUsers();
    pushUserEvent(fromId, { type: 'friend_accept', from: { id: me.id, username: me.username, avatar: me.avatar } });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/friends/reject' && method === 'POST') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const fromId = String(body.userId || '');
    const me = getUserById(session.userId);
    const from = getUserById(fromId);
    if (!from) return sendJSON(res, 404, { error: '用户不存在' });
    me.incoming = me.incoming.filter((r) => r.userId !== fromId);
    from.outgoing = from.outgoing.filter((r) => r.userId !== session.userId);
    saveUsers();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/friends/cancel' && method === 'POST') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const toId = String(body.userId || '');
    const me = getUserById(session.userId);
    const to = getUserById(toId);
    if (!to) return sendJSON(res, 404, { error: '用户不存在' });
    me.outgoing = me.outgoing.filter((r) => r.userId !== toId);
    to.incoming = to.incoming.filter((r) => r.userId !== session.userId);
    saveUsers();
    return sendJSON(res, 200, { ok: true });
  }

  const friendDel = pathname.match(/^\/api\/friends\/([A-Za-z0-9]+)$/);
  if (friendDel && method === 'DELETE') {
    const session = requireUser(req, res);
    if (!session) return;
    const fid = friendDel[1];
    const me = getUserById(session.userId);
    const f = getUserById(fid);
    if (!f) return sendJSON(res, 404, { error: '用户不存在' });
    me.friends = me.friends.filter((x) => x !== fid);
    f.friends = f.friends.filter((x) => x !== session.userId);
    saveUsers();
    return sendJSON(res, 200, { ok: true });
  }

  // ---------------- 私聊 ----------------
  const dmMatch = pathname.match(/^\/api\/dm\/([A-Za-z0-9]+)$/);
  if (dmMatch) {
    const session = requireUser(req, res);
    if (!session) return;
    const otherId = dmMatch[1];
    const other = getUserById(otherId);
    if (!other) return sendJSON(res, 404, { error: '用户不存在' });
    const me = getUserById(session.userId);
    const key = pairKey(session.userId, otherId);
    if (method === 'GET') {
      const list = (dms[key] || []).slice(-100);
      return sendJSON(res, 200, { messages: list, other: { id: other.id, username: other.username, avatar: other.avatar } });
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const type = body.type === 'image' || body.type === 'video' || body.type === 'voice' ? body.type : 'text';
      let text = '';
      let data = '';
      let duration = 0;
      if (type === 'text') {
        text = String(body.text || '').trim().slice(0, 300);
        if (!text) return sendJSON(res, 400, { error: '消息不能为空' });
      } else {
        data = String(body.data || '').trim();
        if (!data) return sendJSON(res, 400, { error: '消息内容为空' });
        if (type === 'image' && !data.startsWith('data:image/')) return sendJSON(res, 400, { error: '图片格式不正确' });
        if (type === 'video' && !data.startsWith('data:video/')) return sendJSON(res, 400, { error: '视频格式不正确' });
        if (type === 'voice' && !data.startsWith('data:audio/')) return sendJSON(res, 400, { error: '语音格式不正确' });
        if (type === 'image' && data.length > 2 * 1024 * 1024) return sendJSON(res, 400, { error: '图片过大（>2MB）' });
        if (type === 'video' && data.length > 8 * 1024 * 1024) return sendJSON(res, 400, { error: '视频过大（>8MB）' });
        if (type === 'voice' && data.length > 2 * 1024 * 1024) return sendJSON(res, 400, { error: '语音过大（>2MB）' });
        if (type === 'voice') duration = Math.max(1, Math.min(60, Number(body.duration) || 0));
      }
      if (!dms[key]) dms[key] = [];
      const msg = { from: session.userId, type, text, data, duration, at: Date.now() };
      dms[key].push(msg);
      if (dms[key].length > 500) dms[key].splice(0, dms[key].length - 500);
      saveDms();
      pushUserEvent(otherId, {
        type: 'dm',
        from: { id: me.id, username: me.username, avatar: me.avatar },
        msgType: msg.type,
        text: msg.text,
        data: msg.data,
        duration: msg.duration,
        at: msg.at
      });
      return sendJSON(res, 200, { ok: true, msg });
    }
    return sendJSON(res, 405, { error: '方法不支持' });
  }

  // ---------------- 切磋（邀请好友建房） ----------------
  if (pathname === '/api/friends/challenge' && method === 'POST') {
    const session = requireUser(req, res);
    if (!session) return;
    const body = await readJSON(req);
    const friendId = String(body.userId || '');
    const game = body.game === 'chess' ? 'chess' : body.game === 'go' ? 'go' : 'gomoku';
    const me = getUserById(session.userId);
    const friend = getUserById(friendId);
    if (!friend) return sendJSON(res, 404, { error: '用户不存在' });
    if (!me.friends.includes(friendId)) return sendJSON(res, 400, { error: '对方不是你的好友' });
    const room = createRoom({
      name: `${me.username} 的切磋邀请`,
      game,
      mode: 'pvp',
      aiEngine: 'local',
      playerName: me.username,
      userId: me.id
    });
    setTimeout(() => broadcast(room), 0);
    pushUserEvent(friendId, {
      type: 'challenge',
      from: { id: me.id, username: me.username, avatar: me.avatar },
      roomCode: room.code,
      game,
      at: Date.now()
    });
    const player = room.players[0];
    return sendJSON(res, 200, { room: publicRoom(room), playerId: player.id, color: player.color });
  }

  // ---------------- 用户级 SSE（好友/私聊/切磋通知） ----------------
  if (pathname === '/api/events' && method === 'GET') {
    const session = getSession(req);
    if (!session) return sendJSON(res, 401, { error: '请先登录' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', userId: session.userId })}\n\n`);
    const set = userClients.get(session.userId) || new Set();
    set.add(res);
    userClients.set(session.userId, set);
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* 忽略 */ }
    }, 25_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      const s = userClients.get(session.userId);
      if (s) {
        s.delete(res);
        if (s.size === 0) userClients.delete(session.userId);
      }
    });
    return;
  }

  // ---------------- 管理员 ----------------
  if (pathname === '/api/admin/users' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const list = users.map((u) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      role: u.role,
      isAdmin: u.role === 'admin',
      banned: Boolean(u.banned),
      banReason: u.banReason || '',
      createdAt: u.createdAt,
      online: isOnline(u.id),
      friendCount: u.friends.length
    }));
    return sendJSON(res, 200, { users: list });
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)\/(ban|unban|role|impersonate)$/);
  if (adminUserMatch && method === 'POST') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const targetId = adminUserMatch[1];
    const action = adminUserMatch[2];
    const target = getUserById(targetId);
    if (!target) return sendJSON(res, 404, { error: '用户不存在' });
    if (action === 'ban') {
      const body = await readJSON(req);
      target.banned = true;
      target.banReason = String(body.reason || '').slice(0, 100);
      saveUsers();
      pushUserEvent(targetId, { type: 'banned', reason: target.banReason });
      return sendJSON(res, 200, { ok: true, user: publicUser(target) });
    }
    if (action === 'unban') {
      target.banned = false;
      target.banReason = '';
      saveUsers();
      return sendJSON(res, 200, { ok: true, user: publicUser(target) });
    }
    if (action === 'role') {
      const body = await readJSON(req);
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (target.id === session.userId && role !== 'admin') {
        return sendJSON(res, 400, { error: '不能撤销自己的管理员权限' });
      }
      target.role = role;
      saveUsers();
      return sendJSON(res, 200, { ok: true, user: publicUser(target) });
    }
    if (action === 'impersonate') {
      // 操控用户：管理员获取该用户的登录 token
      if (target.banned) return sendJSON(res, 403, { error: '该用户已被封禁' });
      const token = createSession(target);
      return sendJSON(res, 200, { token, user: publicUser(target) });
    }
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

let modelCache = { at: 0, data: null };

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/')) {
    handleAPI(req, res).catch((err) => {
      if (!res.headersSent) sendJSON(res, 500, { error: shortError(err) });
      else res.end();
    });
    return;
  }
  serveStatic(req, res);
});

// 定期清理：空房 / 过期对局
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.updatedAt;
    const empty = room.clients.size === 0;
    if ((empty && idle > 25 * 60_000) || idle > 6 * 3600_000) {
      rooms.delete(code);
    }
  }
}, 5 * 60_000).unref();

loadConfig();
loadUsers();
loadDms();
loadStats();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`五子棋服务已启动: http://localhost:${PORT}`);
  console.log(`${providerMeta().name}: ${providerApiKey() ? `已配置 (${maskKey(providerApiKey())}) · ${providerModel()}` : '未配置'}`);
});
