import test from 'node:test';
import assert from 'node:assert/strict';
import { VmosPoolDB, DEFAULT_TTL_SECONDS } from '../lib/pool-db.js';
import { respawnProducer } from '../lib/respawn.js';

function makePool({ count = 0, rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\)/i.test(sql)) return { rows: [{ n: count }] };
      if (/^DELETE FROM/i.test(sql)) return { rowCount: 0 };
      if (/^WITH picked/i.test(sql)) return { rows };
      return { rows: [] };
    },
    async end() {},
  };
}

test('bảng vmos có token_expires_at và cleanup dùng TTL 12 ngày', async () => {
  const pool = makePool();
  const db = new VmosPoolDB({ pool, log: () => {} });
  await db.connect();
  assert.equal(DEFAULT_TTL_SECONDS, 12 * 24 * 3600);
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS "vmos"/);
  assert.match(pool.calls[0].sql, /token_expires_at TIMESTAMPTZ/);
  await db.cleanupExpired();
  const cleanup = pool.calls.find((c) => /^DELETE FROM/i.test(c.sql));
  assert.deepEqual(cleanup.params, [1036800]);
});

test('producer không lưu khi pool đã đạt 500', async () => {
  const pool = makePool({ count: 500 });
  const db = new VmosPoolDB({ pool, log: () => {} });
  await db.connect();
  assert.equal(await db.canAccept(), false);
  assert.equal(
    await db.save({ email: 'a@x.com', password: 'p', token: 't', provider: 'inboxkitten' }),
    false,
  );
  assert.equal(pool.calls.some((c) => /^INSERT INTO/i.test(c.sql)), false);
});

test('takeOne lấy cũ nhất, tuổi >= 5p, còn hạn >= 5p, TTL 12 ngày', async () => {
  const pool = makePool({
    rows: [{
      email: 'old@x.com',
      password: 'pw',
      token: 'inbox-token',
      tokenExpiresAt: new Date('2026-11-19T00:00:00Z'),
      provider: 'inboxkitten',
      createdAt: new Date('2026-11-18T00:00:00Z'),
    }],
  });
  const db = new VmosPoolDB({ pool, log: () => {} });
  await db.connect();
  const account = await db.takeOne();
  assert.equal(account.email, 'old@x.com');
  const take = pool.calls.find((c) => /^WITH picked/i.test(c.sql));
  assert.match(take.sql, /ORDER BY created_at ASC/);
  assert.deepEqual(take.params, [300, 1036800 - 300]);
});

test('respawn spawn producer detached với VMOS_RESPAWNED=1', () => {
  let opts;
  let unrefCalled = false;
  const child = { unref: () => { unrefCalled = true; } };
  respawnProducer({
    script: '/app/vmos/producer.js',
    args: [],
    env: { FOO: 'bar' },
    spawn: (exe, args, options) => {
      opts = { exe, args, options };
      return child;
    },
  });
  assert.equal(opts.exe, process.execPath);
  assert.deepEqual(opts.args, ['/app/vmos/producer.js']);
  assert.equal(opts.options.detached, true);
  assert.equal(opts.options.env.VMOS_RESPAWNED, '1');
  assert.equal(opts.options.env.FOO, 'bar');
  assert.equal(unrefCalled, true);
});
