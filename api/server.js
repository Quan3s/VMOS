import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VmosPoolDB, poolPolicy } from '../lib/pool-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const port = Number(process.env.PORT || 3000);
const apiKeys = new Set(
  (process.env.API_KEY || process.env.API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
);

const db = new VmosPoolDB({
  connectionString: process.env.DATABASE_URL || '',
  table: process.env.VMOS_DB_TABLE || 'vmos',
  maxAccounts: Number(process.env.VMOS_MAX_ACCOUNTS || 300),
  ttlSeconds: Number(process.env.VMOS_TTL_SECONDS || 12 * 24 * 3600),
});

const app = express();
app.disable('x-powered-by');

function requireKey(req, res, next) {
  const key = String(req.headers['x-api-key'] || req.query.apikey || req.query.apiKey || '');
  if (apiKeys.size === 0 || !apiKeys.has(key)) {
    return res.status(401).json({ ok: false, error: 'invalid api key' });
  }
  next();
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'vmos-pool-api',
    endpoints: ['/health', 'GET /register', 'POST /cleanup'],
  });
});

app.get(['/health', '/ping'], async (_req, res) => {
  try {
    res.json({ ok: true, pool: await db.stats(poolPolicy) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(['/register', '/account', '/pool/account'], requireKey, async (req, res) => {
  try {
    const account = await db.takeOne(poolPolicy);
    if (!account) {
      return res.status(503).json({
        ok: false,
        error: 'chưa có account sẵn sàng',
        pool: await db.stats(poolPolicy),
      });
    }
    const pair = `${account.email}|${account.password}`;
    if (req.query.format === 'raw' || req.query.raw === '1') {
      res.type('text/plain').send(pair + '\n');
      return;
    }
    res.json({ ok: true, account: pair, ...account });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/cleanup', requireKey, async (_req, res) => {
  try {
    const deleted = await db.cleanupExpired();
    res.json({ ok: true, deleted, pool: await db.stats(poolPolicy) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export async function startApi() {
  await db.connect();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[api] listening 0.0.0.0:${port}`);
    console.log('[api] GET /register?apikey=... | x-api-key | ?format=raw');
    console.log(`[api] table=${db.table} max=${db.maxAccounts} ttl=${db.ttlSeconds / 86400} days`);
  });
  const timer = setInterval(() => {
    db.cleanupExpired().catch((err) => console.error('[api] cleanup lỗi:', err.message));
  }, 60 * 60 * 1000);
  timer.unref();

  const shutdown = () => {
    clearInterval(timer);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startApi().catch((err) => {
    console.error('[api] fatal:', err.message);
    process.exit(1);
  });
}

export { app, db, ROOT };
