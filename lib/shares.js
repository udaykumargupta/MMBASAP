// Where shares live. A share is one send: the text, the files, who it went to
// and how delivery is going. JSON file on this Mac by default; Neon Postgres
// when DATABASE_URL (or POSTGRES_URL, as Vercel's Neon integration names it)
// is set — required on Vercel.
//
// Share: { id, createdAt, expiresAt, channel, to, text, files: [{ id, name, type, size }],
//          body, mode, status, providerMessageId?, error? }
//
// Contract (all async):
//   create(share)          → share
//   get(id)                → share | null
//   update(id, patch)      → share | null   (shallow merge)
//   recent(limit, channel) → newest first, only that channel
//   countSince(iso, channel) → shares of that channel created at or after iso
//   expired(isoTime)       → shares whose expiresAt is before isoTime
//   removeExpired(isoTime) → number of expired shares deleted
//   remove(id)
import fs from 'node:fs';
import path from 'node:path';

export const databaseUrl = (env = process.env) => String(env.DATABASE_URL || env.POSTGRES_URL || '').trim();

export function fileShares(dataDir) {
  const file = path.join(dataDir, 'shares.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  };
  const save = (list) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file); // atomic: a crash never leaves half a file
  };
  return {
    kind: 'file',
    file,
    async create(share) {
      const list = load();
      list.push(share);
      save(list);
      return share;
    },
    async get(id) {
      return load().find((s) => s.id === id) || null;
    },
    async update(id, patch) {
      const list = load();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return null;
      list[i] = { ...list[i], ...patch };
      save(list);
      return list[i];
    },
    async recent(limit = 20, channel = 'sms') {
      return load().filter((s) => s.channel === channel).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async countSince(iso, channel = 'sms') {
      return load().filter((s) => s.channel === channel && s.createdAt >= iso).length;
    },
    async expired(iso) {
      return load().filter((s) => s.expiresAt < iso);
    },
    async remove(id) {
      save(load().filter((s) => s.id !== id));
    },
    async removeExpired(iso) {
      const list = load();
      const keep = list.filter((s) => s.expiresAt >= iso);
      save(keep);
      return list.length - keep.length;
    },
  };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS mmbasap_shares (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  data       jsonb NOT NULL
)`;
const INDEX = 'CREATE INDEX IF NOT EXISTS mmbasap_shares_created_at ON mmbasap_shares (created_at DESC)';

/** connect(url) → { query(text, params) → rows } — injectable for tests. */
export function neonShares(url, { connect } = {}) {
  let ready = null;
  const db = () => (ready ||= (async () => {
    const sql = connect ? connect(url) : (await import('@neondatabase/serverless')).neon(url);
    await sql.query(SCHEMA); // creates the table on first use
    await sql.query(INDEX);
    return sql;
  })().catch((err) => { ready = null; throw err; }));
  const parse = (data) => (typeof data === 'string' ? JSON.parse(data) : data);
  const rowsOf = (rows) => rows.map((r) => parse(r.data));

  return {
    kind: 'database',
    async create(share) {
      await (await db()).query(
        'INSERT INTO mmbasap_shares (id, created_at, expires_at, data) VALUES ($1, $2, $3, $4::jsonb)',
        [share.id, share.createdAt, share.expiresAt, JSON.stringify(share)],
      );
      return share;
    },
    async get(id) {
      return rowsOf(await (await db()).query('SELECT data FROM mmbasap_shares WHERE id = $1', [id]))[0] || null;
    },
    async update(id, patch) {
      const rows = await (await db()).query('UPDATE mmbasap_shares SET data = data || $2::jsonb WHERE id = $1 RETURNING data', [id, JSON.stringify(patch)]);
      return rowsOf(rows)[0] || null;
    },
    async recent(limit = 20, channel = 'sms') {
      return rowsOf(await (await db()).query("SELECT data FROM mmbasap_shares WHERE data->>'channel' = $2 ORDER BY created_at DESC LIMIT $1", [limit, channel]));
    },
    async countSince(iso, channel = 'sms') {
      const rows = await (await db()).query("SELECT count(*)::int AS n FROM mmbasap_shares WHERE created_at >= $1 AND data->>'channel' = $2", [iso, channel]);
      return Number(rows[0]?.n || 0);
    },
    async expired(iso) {
      return rowsOf(await (await db()).query('SELECT data FROM mmbasap_shares WHERE expires_at < $1 LIMIT 200', [iso]));
    },
    async remove(id) {
      await (await db()).query('DELETE FROM mmbasap_shares WHERE id = $1', [id]);
    },
    async removeExpired(iso) {
      return (await (await db()).query('DELETE FROM mmbasap_shares WHERE expires_at < $1 RETURNING id', [iso])).length;
    },
  };
}

export function createShares({ env = process.env, dataDir }) {
  const url = databaseUrl(env);
  return url ? neonShares(url) : fileShares(dataDir);
}
