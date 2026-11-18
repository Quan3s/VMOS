import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runBot } from './bot.js';
import { bootstrapEnv } from './lib/env-check.js';
import { VmosPoolDB, poolPolicy } from './lib/pool-db.js';
import { respawnProducer } from './lib/respawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

const cfg = loadConfig();
const HEADLESS = parseBool(process.env.HEADLESS, cfg.headless ?? false);
if (HEADLESS && process.env.VMOS_ALLOW_HEADLESS !== '1') {
  console.error('[producer] VMOS phải chạy HEADED (HEADLESS=false) để tránh Cloudflare.');
  console.error('[producer] Nếu vẫn muốn thử: đặt VMOS_ALLOW_HEADLESS=1');
  process.exit(1);
}

const botConfig = {
  ...cfg,
  headless: HEADLESS,
  browserPath: process.env.BROWSER_PATH || cfg.browserPath || '',
  useWarp: parseBool(process.env.WARP_ENABLED, cfg.useWarp ?? false),
  debug: parseBool(process.env.VMOS_DEBUG, cfg.debug ?? false),
};

const delayMs = Math.max(1000, Number(process.env.PRODUCER_DELAY_MS || cfg.delayMs || 15000));

export async function runProducer({
  db = new VmosPoolDB({
    connectionString: process.env.DATABASE_URL || cfg.database?.connectionString || '',
    table: process.env.VMOS_DB_TABLE || cfg.database?.table || 'vmos',
    maxAccounts: Number(process.env.VMOS_MAX_ACCOUNTS || cfg.database?.maxAccounts || 300),
  }),
  emit = null,
  respawn = respawnProducer,
} = {}) {
  const log = (line) => console.log(line);
  await bootstrapEnv(log);
  await db.connect();

  const socket = new EventEmitter();
  socket.on('log', (line) => console.log(line));
  socket.on('step', ({ n, name }) => console.log(`[step ${n}/10] ${name}`));
  socket.on('error', (msg) => console.error(`[bot] lỗi: ${msg}`));
  if (emit) socket.on('log', (line) => emit('log', line));

  let savePromise = Promise.resolve();
  let reloginSucceeded = false;
  socket.on('result', (result) => {
    savePromise = db.save(result)
      .then((saved) => {
        log(`[producer] ${saved ? 'đã lưu' : 'không lưu'} ${result.email}`);
        if (emit) emit('result', result);
      })
      .catch((err) => console.error(`[producer] lưu DB lỗi: ${err.message}`));
  });
  socket.on('relogin-success', (info) => {
    reloginSucceeded = true;
    log(`[producer] đăng nhập lại chính thống OK: ${info?.email || '?'}`);
  });

  log(`[producer] chạy HEADED, delay=${delayMs}ms, pool tối đa ${db.maxAccounts}, TTL ${db.ttlSeconds / 86400} ngày`);

  while (true) {
    if (!(await db.canAccept())) {
      log(`[producer] pool đã đầy (${db.maxAccounts}) — chờ 60s`);
      await sleep(60000);
      continue;
    }

    reloginSucceeded = false;
    let done = false;
    const finished = new Promise((resolve) => {
      const onDone = () => { done = true; resolve(); };
      // runBot gọi onDone() trong finally (kể cả khi có lỗi bên trong).
      runBot(botConfig, socket, onDone).catch((err) => {
        console.error(`[producer] runBot fatal: ${err.message}`);
        onDone();
      });
    });
    await finished;
    await savePromise;

    if (reloginSucceeded) {
      log('[producer] relogin xong → spawn tiến trình mới để tạo account tiếp...');
      respawn();
      process.exit(0);
      return;
    }
    log(`[producer] nghỉ ${delayMs}ms trước account tiếp theo...`);
    await sleep(delayMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runProducer().catch((err) => {
    console.error('[producer] fatal:', err.message);
    process.exit(1);
  });
}

export { poolPolicy };
