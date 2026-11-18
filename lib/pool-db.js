import pg from 'pg';

const { Pool } = pg;

export const DAY_SECONDS = 24 * 60 * 60;
export const DEFAULT_TTL_SECONDS = 12 * DAY_SECONDS;
export const DEFAULT_MAX_ACCOUNTS = 300;

/**
 * Pool tài khoản VMOS trên PostgreSQL — bảng `vmos`.
 *
 * - Producer lưu tài khoản mới vào bảng này (tối đa 300).
 * - API lấy account CŨ NHẤT, xoá ngay sau khi lấy.
 * - Account cũ hơn 12 ngày bị xoá định kỳ / mỗi lần gọi API.
 * - `token_expires_at` là hạn của OTP inbox (24h), không phải hạn account.
 * - Mọi mốc thời gian dùng NOW() của Postgres, không dùng đồng hồ local.
 */
export class VmosPoolDB {
  constructor({
    connectionString = process.env.DATABASE_URL || '',
    table = 'vmos',
    ttlSeconds = DEFAULT_TTL_SECONDS,
    maxAccounts = DEFAULT_MAX_ACCOUNTS,
    pool = null,
    log = console.log,
  } = {}) {
    this.connectionString = connectionString;
    this.table = String(table || 'vmos');
    this.qTable = `"${this.table.replace(/"/g, '""')}"`;
    this.ttlSeconds = Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS);
    this.maxAccounts = Math.max(1, Number(maxAccounts) || DEFAULT_MAX_ACCOUNTS);
    this.log = log;
    this.pool = pool;
  }

  get enabled() {
    return !!(this.connectionString || this.pool);
  }

  async connect() {
    if (!this.enabled) {
      throw new Error('Thiếu DATABASE_URL / database.connectionString');
    }
    if (!this.pool) {
      const { Pool: PgPool } = pg;
      this.pool = new PgPool({
        connectionString: this.connectionString,
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 15000,
      });
      await this.pool.query('SELECT 1');
    }
    await this.createTable();
    this.log(`[db] đã kết nối PostgreSQL, bảng "${this.table}" sẵn sàng`);
    return this;
  }

  async createTable() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qTable} (
        id               BIGSERIAL PRIMARY KEY,
        email            TEXT NOT NULL UNIQUE,
        password         TEXT,
        token            TEXT,
        token_expires_at TIMESTAMPTZ,
        provider         TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const indexName = `${this.table}_created_at_idx`.replace(/"/g, '""');
    const index = `"${indexName}"`;
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${index} ON ${this.qTable} (created_at)`,
    );
  }

  /** Xoá account cũ hơn TTL (12 ngày) — dùng NOW() của DB. */
  async cleanupExpired() {
    if (!this.pool) return 0;
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.qTable} WHERE created_at < NOW() - (($1::int) || ' seconds')::interval`,
      [this.ttlSeconds],
    );
    if (rowCount > 0) this.log(`[db] đã xoá ${rowCount} account quá hạn (>${this.ttlSeconds}s)`);
    return rowCount;
  }

  async count() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${this.qTable}`);
    return rows?.[0]?.n || 0;
  }

  async canAccept() {
    if (!this.pool) return false;
    await this.cleanupExpired();
    const n = await this.count();
    return n < this.maxAccounts;
  }

  /** Lưu account mới. Trả false nếu pool đã đầy (300). */
  async save(account) {
    if (!this.pool) return false;
    if (!(await this.canAccept())) {
      this.log(`[db] pool đầy (${this.maxAccounts}) — bỏ qua ${account?.email || '?'}`);
      return false;
    }
    const tokenExpiresAt =
      account.tokenExpiresAt == null
        ? null
        : new Date(
            typeof account.tokenExpiresAt === 'number'
              ? account.tokenExpiresAt
              : account.tokenExpiresAt,
          ).toISOString();
    await this.pool.query(
      `INSERT INTO ${this.qTable}
         (email, password, token, token_expires_at, provider)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         password = EXCLUDED.password,
         token = EXCLUDED.token,
         token_expires_at = EXCLUDED.token_expires_at,
         provider = EXCLUDED.provider,
         created_at = NOW()
       RETURNING id`,
      [
        account.email,
        account.password || null,
        account.token || null,
        tokenExpiresAt,
        account.provider || null,
      ],
    );
    this.log(`[db] đã lưu ${account.email} vào bảng "${this.table}"`);
    return true;
  }

  /**
   * Lấy account CŨ NHẤT (ORDER BY created_at ASC) rồi XOÁ luôn.
   * Mặc định mirror policy VSPhone: tuổi >= 5p, còn hạn >= 5p.
   */
  async takeOne({ minAgeSeconds = 300, minRemainingSeconds = 300 } = {}) {
    if (!this.pool) return null;
    await this.cleanupExpired();
    const takeMaxAge = Math.max(
      minAgeSeconds,
      this.ttlSeconds - Math.max(0, minRemainingSeconds),
    );
    const { rows } = await this.pool.query(
      `WITH picked AS (
         SELECT id, email, password, token, token_expires_at, provider, created_at
         FROM ${this.qTable}
         WHERE created_at <= NOW() - (($1::int) || ' seconds')::interval
           AND created_at >= NOW() - (($2::int) || ' seconds')::interval
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       DELETE FROM ${this.qTable} AS t
       USING picked AS p
       WHERE t.id = p.id
       RETURNING p.email, p.password, p.token, p.token_expires_at AS "tokenExpiresAt",
                 p.provider, p.created_at AS "createdAt"`,
      [minAgeSeconds, takeMaxAge],
    );
    const row = rows?.[0];
    if (!row) return null;
    this.log(`[db] đã lấy và xoá ${row.email} khỏi "${this.table}"`);
    return {
      email: row.email,
      password: row.password || '',
      token: row.token || null,
      tokenExpiresAt: row.tokenExpiresAt ? new Date(row.tokenExpiresAt).toISOString() : null,
      provider: row.provider || null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
  }

  async stats({ minAgeSeconds = 300, minRemainingSeconds = 300 } = {}) {
    if (!this.pool) {
      return { total: 0, ready: 0, fresh: 0, expiring: 0, maxAccounts: this.maxAccounts, ttlSeconds: this.ttlSeconds };
    }
    const takeMaxAge = Math.max(
      minAgeSeconds,
      this.ttlSeconds - Math.max(0, minRemainingSeconds),
    );
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE created_at <= NOW() - (($1::int) || ' seconds')::interval
             AND created_at >= NOW() - (($2::int) || ' seconds')::interval
         )::int AS ready,
         COUNT(*) FILTER (
           WHERE created_at > NOW() - (($1::int) || ' seconds')::interval
         )::int AS fresh,
         COUNT(*) FILTER (
           WHERE created_at < NOW() - (($2::int) || ' seconds')::interval
         )::int AS expiring
       FROM ${this.qTable}`,
      [minAgeSeconds, takeMaxAge],
    );
    const r = rows?.[0] || {};
    return {
      total: r.total || 0,
      ready: r.ready || 0,
      fresh: r.fresh || 0,
      expiring: r.expiring || 0,
      maxAccounts: this.maxAccounts,
      ttlSeconds: this.ttlSeconds,
    };
  }

  /** Lấy account cũ nhất để re-login (KHÔNG xoá). */
  async peekOne() {
    if (!this.pool) return null;
    await this.cleanupExpired();
    const { rows } = await this.pool.query(
      `SELECT email, password, token, token_expires_at AS "tokenExpiresAt", provider
       FROM ${this.qTable}
       ORDER BY created_at ASC
       LIMIT 1`,
    );
    return rows?.[0] || null;
  }

  async close() {
    try {
      if (this.pool) await this.pool.end();
    } catch {
      /* ignore */
    }
  }
}

export const poolPolicy = { minAgeSeconds: 300, minRemainingSeconds: 300 };
