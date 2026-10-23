'use strict';

// 云数据库持久化层（PostgreSQL，兼容 Neon / Supabase / Render PG 等）。
// 配置了 DATABASE_URL 时，账号、私聊、统计、配置、登录态都存到云数据库，
// 部署重启不会丢失；未配置时自动回退到本地 JSON 文件（方便本地开发）。

const cache = new Map();
const timers = new Map();
const pending = new Map();
let pool = null;
let enabled = false;

function isEnabled() {
  return enabled;
}

function has(key) {
  return cache.has(key);
}

function get(key) {
  return cache.get(key);
}

async function init(logger = console) {
  const rawUrl = (process.env.DATABASE_URL || '').trim();
  if (!rawUrl) {
    logger.log('[store] 未配置 DATABASE_URL，使用本地文件存储（云端部署时数据会丢失）');
    return false;
  }
  // Neon / Supabase 等的 pooler 连接串有时带 pg 不识别的查询参数，清掉它们
  const urlObj = new URL(rawUrl);
  for (const k of ['channel_binding']) urlObj.searchParams.delete(k);
  const url = urlObj.toString();
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    logger.warn('[store] 缺少 pg 依赖，回退到本地文件存储');
    return false;
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    max: 4,
    ssl: isLocal ? undefined : true,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000
  });
  pool.on('error', (err) => logger.error('[store] 数据库连接异常:', err.message));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_kv (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query('SELECT key, value FROM app_kv');
      for (const row of rows) cache.set(row.key, row.value);
      enabled = true;
      logger.log(`[store] 云数据库已连接，加载 ${rows.length} 项数据`);
      return true;
    } catch (err) {
      const detail = err instanceof AggregateError
        ? err.errors.map((e) => e.message).join(' | ')
        : err.message;
      logger.error(`[store] 数据库初始化失败（第 ${attempt}/5 次）: ${detail}`);
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  await pool.end().catch(() => {});
  pool = null;
  logger.warn('[store] 云数据库不可用，回退到本地文件存储');
  return false;
}

function set(key, value) {
  cache.set(key, value);
  if (!enabled) return;
  pending.set(key, value);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { flush(key); }, 600));
}

async function flush(key) {
  timers.delete(key);
  if (!enabled || !pending.has(key)) return;
  const value = pending.get(key);
  pending.delete(key);
  try {
    await pool.query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  } catch (err) {
    console.error(`[store] 保存 ${key} 失败: ${err.message}`);
    pending.set(key, value);
  }
}

async function flushAll() {
  const keys = [...new Set([...pending.keys(), ...timers.keys()])];
  for (const key of keys) clearTimeout(timers.get(key));
  await Promise.all(keys.map((key) => flush(key)));
}

async function close() {
  await flushAll();
  enabled = false;
  if (pool) await pool.end().catch(() => {});
}

module.exports = { init, has, get, set, flushAll, close, isEnabled };
