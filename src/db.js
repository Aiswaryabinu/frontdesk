'use strict';
/**
 * Tiny database adapter. Production = PostgreSQL (DATABASE_URL). Local tests = node:sqlite.
 * The service only ever uses:   await db.tx(async (t) => { await t.query('... ? ...', [params]) })
 * Placeholders are written as ? and converted to $1, $2 ... for Postgres.
 * Every query result is { rows, rowCount }.
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

async function openPostgres(url) {
  const { Pool } = require('pg'); // declared in package.json
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  const toPg = (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  const wrap = (client) => ({
    async query(sql, params = []) {
      const r = await client.query(toPg(sql), params);
      return { rows: r.rows, rowCount: r.rowCount };
    },
  });
  return {
    dialect: 'pg',
    forUpdate: ' FOR UPDATE',
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    },
    async migrate() {
      const client = await pool.connect();
      try {
        // advisory lock so two instances starting together do not race on DDL
        await client.query('SELECT pg_advisory_lock(727272)');
        await client.query(read('schema.sql'));
        await client.query(read('triggers.pg.sql'));
        await client.query('SELECT pg_advisory_unlock(727272)');
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
    // used by tests only (never called in production code paths)
    raw: pool,
  };
}

async function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  let chain = Promise.resolve();
  const q = (sql, params = []) => {
    const st = db.prepare(sql);
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = st.all(...params).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    const r = st.run(...params);
    return { rows: [], rowCount: Number(r.changes) };
  };
  return {
    dialect: 'sqlite',
    forUpdate: '',
    // One connection: transactions are queued so statements of different requests never interleave.
    async tx(fn) {
      const prev = chain;
      let release;
      chain = new Promise((r) => (release = r));
      await prev;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const out = await fn({ query: async (sql, params) => q(sql, params) });
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } finally {
        release();
      }
    },
    async migrate() {
      db.exec(read('schema.sql'));
      db.exec(read('triggers.sqlite.sql'));
    },
    async close() {
      db.close();
    },
    raw: db,
  };
}

async function openDb(url = process.env.DATABASE_URL) {
  if (url && /^postgres(ql)?:\/\//.test(url)) return openPostgres(url);
  return openSqlite(process.env.SQLITE_PATH || ':memory:');
}

module.exports = { openDb };
