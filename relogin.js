import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './bot.js';
import { prepareProxy, stopProxy } from './lib/proxy.js';
import { bootstrapEnv } from './lib/env-check.js';
import { createMailFromSession } from './lib/mailtm.js';
import { getInboxToken } from './lib/inbox-store.js';
import { loginWithOtpOfficial } from './lib/official-login.js';
import { VmosPoolDB } from './lib/pool-db.js';
import { respawnProducer } from './lib/respawn.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickAccount(db) {
  const raw = process.env.VMOS_RELOGIN_ACCOUNT || '';
  if (raw) {
    const [email, token] = raw.split('|');
    if (!email || !token) throw new Error('VMOS_RELOGIN_ACCOUNT phải có dạng email|inboxToken');
    return { email, token };
  }
  const row = await db.peekOne();
  if (!row) throw new Error('Không có account nào trong pool để đăng nhập lại');
  return row;
}

export async function runRelogin() {
  const log = (msg) => console.log(msg);
  await bootstrapEnv(log);

  const db = new VmosPoolDB({
    connectionString: process.env.DATABASE_URL || '',
    table: process.env.VMOS_DB_TABLE || 'vmos',
  });
  await db.connect();
  const account = await pickAccount(db);
  log(`🔑 Re-login: ${account.email}`);

  const inbox = getInboxToken(account.token);
  if (!inbox) throw new Error('Inbox token hết hạn hoặc không tồn tại (chỉ sống 24h)');
  const mail = createMailFromSession(inbox.session, log);

  const proxyInfo = await prepareProxy(log, { warp: process.env.WARP_ENABLED === 'true' });
  const browser = await launchBrowser({ headless: false, browserPath: process.env.BROWSER_PATH }, proxyInfo, log);
  const [page] = await browser.pages();
  if (!page) throw new Error('Không có page để đăng nhập');

  const imageBuffers = {};
  let initCaptcha = null;
  let sessionAuth = null;

  page.on('response', async (res) => {
    const url = res.url();
    try {
      if (/\/back\.png/.test(url)) imageBuffers.back = await res.buffer();
      else if (/\/shadow\.png/.test(url)) imageBuffers.shadow = await res.buffer();
      if (/captcha.*aliyuncs\.com/.test(url) && res.request().method() === 'POST') {
        const pd = res.request().postData() || '';
        if (pd.includes('Action=InitCaptcha')) initCaptcha = await res.json();
      }
      if (/\/vcpcloud\/api\//.test(url)) {
        const data = JSON.parse(await res.text())?.data;
        if (data?.token && data?.userId) {
          sessionAuth = {
            token: data.token,
            userId: data.userId,
            customerId: data.customerId,
            mobilePhone: data.mobilePhone,
          };
        }
      }
    } catch {
      /* ignore */
    }
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  try {
    const auth = await loginWithOtpOfficial(page, {
      email: account.email,
      mail,
      log,
      getCaptcha: () => ({ initCaptcha, imageBuffers }),
      resetCaptcha: () => {
        initCaptcha = null;
        imageBuffers.back = null;
        imageBuffers.shadow = null;
      },
      capturedAuth: () => sessionAuth,
    });
    log(`✅ Relogin OK token=${auth.token.length} userId=${auth.userId || '?'}`);
    await db.close();
    await browser.close();
    await stopProxy(proxyInfo, log);
    log('🚀 Spawn producer mới...');
    respawnProducer();
    process.exit(0);
  } catch (err) {
    await browser.close().catch(() => {});
    await stopProxy(proxyInfo, log).catch(() => {});
    await db.close();
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runRelogin().catch((err) => {
    console.error('[relogin] fatal:', err.message);
    process.exit(1);
  });
}
