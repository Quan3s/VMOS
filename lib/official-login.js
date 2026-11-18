import { solveAliyunPuzzle } from './aliyun-captcha.js';
import { listInbox, readInboxMessage } from './mailtm.js';

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

async function waitForLoginChallenge(page, getCaptcha, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const state = getCaptcha() || {};
    const ib = state.imageBuffers || {};
    if (state.initCaptcha && ib.back && ib.shadow) {
      return { initCaptcha: state.initCaptcha, imageBuffers: ib, otpReady: false };
    }
    // Session còn trusted → site có khi không hỏi captcha mà gửi thẳng OTP.
    const otpReady = await page.evaluate(() => {
      const hasOtpInput = !!document.querySelector('input[maxlength="6"], input[type="number"][maxlength="1"]');
      const text = document.body.innerText || '';
      return hasOtpInput && /verification code sent|resend|mã xác minh/i.test(text);
    }).catch(() => false);
    if (otpReady) return { otpReady: true };
    await sleep(500);
  }
  const diag = await page.evaluate(() => {
    const dlg = document.querySelector('#login-dialog');
    return {
      url: location.href,
      text: (dlg?.innerText || document.body.innerText || '').slice(0, 1000),
      inputs: [...document.querySelectorAll('#login-dialog input')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({ type: e.type, maxLength: e.maxLength, placeholder: e.placeholder })),
    };
  }).catch(() => ({}));
  throw new Error('Không bắt được captcha khi đăng nhập lại: ' + JSON.stringify(diag));
}

/** Ép site dùng đăng nhập bằng mã thay vì panel password. */
async function switchToCodeLogin(page, log) {
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('#login-dialog');
    if (!dlg) return null;
    const el = [...dlg.querySelectorAll('a, button, span, div')].find((e) => {
      if (!e.offsetParent || e.children.length > 2) return false;
      const text = (e.innerText || e.textContent || '').trim();
      return /verification\s*code|code\s*login|get\s*code|mã\s*xác\s*minh|nhận\s*mã/i.test(text) &&
        text.length < 60;
    });
    el?.click();
    return el?.innerText?.trim() || null;
  });
  if (clicked) {
    log(`🔄 Chuyển sang login bằng mã: "${clicked}"`);
    await sleep(1000);
  }
}

async function fillOtp(page, otp, customerId) {
  const customerInput = await page.$('#registration-customer-id');
  if (customerInput && customerId) {
    await customerInput.click({ clickCount: 3 });
    await customerInput.type(customerId, { delay: 30 });
    await sleep(300);
  }
  const selectors = [
    'input[type="number"][maxlength="1"]',
    'input[inputmode="numeric"][maxlength="1"]',
    'input[maxlength="1"]',
  ];
  let inputs = [];
  for (const sel of selectors) {
    const found = await page.$$(sel);
    if (found.length >= 6) {
      inputs = found.slice(0, 6);
      break;
    }
  }
  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i++) {
      await inputs[i].type(otp[i], { delay: 60 });
      await sleep(120);
    }
  } else {
    const single = await page.$('input[maxlength="6"], input[placeholder*="code" i], input[placeholder*="mã" i]');
    if (!single) throw new Error('Không tìm thấy ô OTP khi đăng nhập lại');
    await single.click({ clickCount: 3 });
    await single.type(otp, { delay: 60 });
  }
  await sleep(1200);
}

async function tryClickResend(page, log) {
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('#login-dialog') || document;
    const el = [...dlg.querySelectorAll('a, button, span, div')].find((e) => {
      if (!e.offsetParent || e.children.length > 3) return false;
      const text = (e.innerText || e.textContent || '').trim();
      return /^(resend|get code|send again|gửi lại|nhận lại)$/i.test(text) ||
        (/resend|gửi lại/i.test(text) && text.length < 30);
    });
    const disabled = el && (el.disabled || /disabled|is-disabled|countdown/i.test(el.className || ''));
    if (!el || disabled) return null;
    el.click();
    return (el.innerText || '').trim();
  }).catch(() => null);
  if (clicked) log(`🔁 Đã click resend OTP: "${clicked}"`);
  return clicked;
}

async function pollLoginOtp(mail, { timeoutMs, since, exclude = [], log, page = null }) {
  const session = mail?.session;
  const t0 = Date.now();
  const seenIds = new Set();
  const excludeSet = new Set(exclude.filter(Boolean).map(String));
  let resent = false;

  while (Date.now() - t0 < timeoutMs) {
    if (session?.provider && session?.address) {
      try {
        const messages = await listInbox(session);
        for (const m of (messages || []).sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0))) {
          if (!m || seenIds.has(m.id)) continue;
          seenIds.add(m.id);
          if (since && m.date && Date.parse(m.date) < since) continue;
          let otp = m.otp;
          if (!otp) {
            try {
              const detail = await readInboxMessage(session, m.id);
              otp = detail?.otp;
            } catch {}
          }
          if (!otp || excludeSet.has(String(otp))) continue;
          log(`📨 OTP login: ${otp}`);
          return otp;
        }
      } catch (e) {
        log(`⚠️ poll OTP login: ${e.message}`);
      }
    } else if (typeof mail?.pollOTP === 'function') {
      try {
        const otp = await mail.pollOTP({ timeout: 10000, since });
        if (otp && !excludeSet.has(String(otp))) return otp;
      } catch {}
    }
    // Sau ~45s chưa có mã, thử resend một lần (nếu UI cho phép).
    if (!resent && page && Date.now() - t0 > 45000) {
      resent = true;
      await tryClickResend(page, log);
    }
    await sleep(3000);
  }
  throw new Error('OTP timeout');
}

export async function loginWithOtpOfficial(page, {
  email,
  mail,
  log = console.log,
  getCaptcha = () => ({}),
  resetCaptcha = () => {},
  otpTimeoutMs = 180000,
  capturedAuth = () => null,
  excludeOtps = [],
} = {}) {
  if (!email || !mail || typeof mail.pollOTP !== 'function') {
    throw new Error('Thiếu email hoặc mail.pollOTP cho đăng nhập chính thống');
  }
  log('🔐 Đăng nhập lại bằng đường chính thống (captcha → OTP → login)...');

  await ensureLoginDialog(page, email, log);
  // Chỉ clear captcha SAU khi đã điền email — tránh xoá captcha site vừa gửi lúc mở dialog.
  if (typeof resetCaptcha === 'function') resetCaptcha();
  await switchToCodeLogin(page, log);

  const loginStartedAt = Date.now();
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

  const challenge = await waitForLoginChallenge(page, getCaptcha);
  if (!challenge.otpReady) {
    const solved = await solveAliyunPuzzle(page, challenge.imageBuffers, log, {
      maxAttempts: 3,
      powDelay: 6000,
    });
    if (!solved?.success) throw new Error('Captcha đăng nhập lại thất bại sau 3 lần');
    log('✅ Captcha đăng nhập OK');
  } else {
    log('✓ Site không hỏi captcha (session trusted) — đã gửi thẳng OTP');
  }

  // Chỉ nhận OTP gửi sau lúc bấm Login; loại trừ OTP đã dùng (vd đổi password).
  const since = loginStartedAt - 30000;
  log('⏳ Chờ mã OTP đăng nhập...');
  const otp = await pollLoginOtp(mail, {
    timeoutMs: otpTimeoutMs,
    since,
    exclude: excludeOtps,
    log,
    page,
  });
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
