import { solveAliyunPuzzle } from './aliyun-captcha.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(el) {
  return !!(el && el.offsetParent !== null);
}

async function ensureLoginDialog(page, email, log) {
  let visible = await page.evaluate(() => {
    const d = document.querySelector('#login-dialog');
    return !!(d && d.offsetParent !== null);
  });
  if (!visible) {
    log('🌐 Mở lại trang login...');
    await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button, a, [role="button"]')].find((e) => {
        if (!e.offsetParent) return false;
        const text = (e.innerText || e.textContent || '').trim();
        return /^(sign|log)\s*in$|^đăng\s*nhập$|^login$/i.test(text);
      });
      el?.click();
      return el?.innerText?.trim() || null;
    });
    log(clicked ? `🖱️ Click "${clicked}"` : '⚠️ Không thấy nút Sign in');
  }
  await page.waitForSelector('#login-dialog', { timeout: 20000 });
  await page.waitForFunction(() => {
    const d = document.querySelector('#login-dialog');
    return !!(d && d.offsetParent !== null);
  }, { timeout: 20000 });
  await sleep(1000);

  const selector = [
    '#login-dialog input[placeholder*="email" i]',
    '#login-dialog input[placeholder*="mail" i]',
    '#login-dialog input.el-input__inner',
  ];
  let input = null;
  for (const sel of selector) {
    for (const el of await page.$$(sel)) {
      if (await el.evaluate(isVisible)) {
        input = el;
        break;
      }
    }
    if (input) break;
  }
  if (!input) throw new Error('Không tìm thấy ô email trong login dialog');
  await input.click({ clickCount: 3 });
  await input.type(email, { delay: 40 });
  log(`✓ Đã điền email: ${email}`);

  const tosChecked = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#login-dialog .tos img')];
    if (!imgs.length) return true;
    return imgs[imgs.length - 1].style.display !== 'none';
  });
  if (!tosChecked) {
    await page.evaluate(() => document.querySelector('#login-dialog .tos img')?.click());
    await sleep(400);
  }
}

async function waitForCaptcha(getCaptcha, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const state = getCaptcha() || {};
    const ib = state.imageBuffers || {};
    if (state.initCaptcha && ib.back && ib.shadow) {
      return { initCaptcha: state.initCaptcha, imageBuffers: ib };
    }
    await sleep(500);
  }
  throw new Error('Không bắt được captcha khi đăng nhập lại');
}

async function fillOtp(page, otp, customerId) {
  const customerInput = await page.$('#registration-customer-id');
  if (customerInput && customerId) {
    await customerInput.click({ clickCount: 3 });
    await customerInput.type(customerId, { delay: 30 });
    await sleep(300);
  }
  await page.waitForSelector('input[type="number"][maxlength="1"]', { timeout: 20000 });
  const inputs = await page.$$('input[type="number"][maxlength="1"]');
  if (inputs.length < 6) throw new Error(`Chỉ thấy ${inputs.length} ô OTP`);
  for (let i = 0; i < 6; i++) {
    await inputs[i].type(otp[i], { delay: 60 });
    await sleep(120);
  }
  await sleep(1200);
}

export async function loginWithOtpOfficial(page, {
  email,
  mail,
  log = console.log,
  getCaptcha = () => ({}),
  resetCaptcha = () => {},
  otpTimeoutMs = 180000,
  capturedAuth = () => null,
} = {}) {
  if (!email || !mail || typeof mail.pollOTP !== 'function') {
    throw new Error('Thiếu email hoặc mail.pollOTP cho đăng nhập chính thống');
  }
  log('🔐 Đăng nhập lại bằng đường chính thống (captcha → OTP → login)...');

  if (typeof resetCaptcha === 'function') resetCaptcha();
  await ensureLoginDialog(page, email, log);

  const submit = await page.evaluate(() => {
    const dlg = document.querySelector('#login-dialog');
    const btn = [...dlg.querySelectorAll('button')].find((b) => {
      if (!b.offsetParent) return false;
      const text = (b.innerText || '').trim();
      return /đăng\s*nhập|đăng\s*ký|login|sign|continue|get\s*code|xác\s*nhận/i.test(text);
    });
    btn?.click();
    return btn?.innerText?.trim() || null;
  });
  log(submit ? `🖱️ Click "${submit}"` : '⌨️ Bấm Enter để tiếp tục');
  if (!submit) {
    const input = await page.$('#login-dialog input.el-input__inner');
    await input?.press('Enter');
  }

  const { imageBuffers } = await waitForCaptcha(getCaptcha);
  const solved = await solveAliyunPuzzle(page, imageBuffers, log, { maxAttempts: 3, powDelay: 6000 });
  if (!solved?.success) throw new Error('Captcha đăng nhập lại thất bại sau 3 lần');
  log('✅ Captcha đăng nhập OK');

  // OTP được gửi sau khi captcha verify — chỉ nhận mail mới hơn mốc này.
  const since = Date.now();
  log('⏳ Chờ mã OTP đăng nhập...');
  const otp = await mail.pollOTP({ timeout: otpTimeoutMs, since });
  log(`📨 Đã nhận mã OTP: ${otp}`);

  await fillOtp(page, otp, email.split('@')[0]);

  let loggedIn = false;
  try {
    await page.waitForFunction(() => {
      const d = document.querySelector('#login-dialog');
      return !d || d.offsetParent === null;
    }, { timeout: 30000 });
    loggedIn = true;
  } catch {
    const state = await page.evaluate(() => ({
      url: location.href,
      text: document.querySelector('#login-dialog')?.innerText?.slice(0, 300) || '',
      toast: [...document.querySelectorAll('.el-message, .el-notification')]
        .map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | '),
    }));
    log('⚠️ Login dialog vẫn hiện: ' + JSON.stringify(state));
  }

  const auth = await page.evaluate(() => ({
    token: localStorage.getItem('token') || '',
    userId: localStorage.getItem('userId') || '',
    users: (() => { try { return JSON.parse(localStorage.getItem('users') || '[]'); } catch { return []; } })(),
  })).catch(() => ({ token: '', userId: '', users: [] }));
  const captured = typeof capturedAuth === 'function' ? capturedAuth() : null;
  const result = {
    token: captured?.token || auth.token || null,
    userId: captured?.userId || auth.userId || null,
    customerId: captured?.customerId || null,
    mobilePhone: captured?.mobilePhone || email,
  };
  if (!result.token) throw new Error('Đăng nhập nhưng không lấy được auth token');
  if (!loggedIn) log('⚠️ Có token nhưng UI chưa ẩn login dialog — tiếp tục với token');
  log(`✅ Đăng nhập chính thống thành công (userId=${result.userId || '?'})`);
  return result;
}

export default loginWithOtpOfficial;
