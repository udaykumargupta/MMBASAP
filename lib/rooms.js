// Pair-your-phone storage. A "room" joins one laptop browser and one phone:
// both hold the room id and a secret key (the key never reaches the server —
// it travels in the QR code's #fragment). The laptop drops encrypted messages
// into the room; the phone picks them up and opens WhatsApp or Messages.
// The server sees the ciphertext, the room id, and the file records (attached
// files themselves are stored privately but not end-to-end encrypted).
//
// room:    { id, createdAt, laptopSeenAt, phoneSeenAt }
// message: { id, roomId, createdAt, expiresAt, iv, data, fileIds, status: 'waiting'|'received'|'opened' }
// upload:  { fileId, roomId, size, createdAt, expiresAt, owner, ip }  (ip is a hash, for per-address quotas)
//
// Contract (all async):
//   create(roomId, iso)                → room   (only the laptop creates rooms, by POST)
//   seen(roomId, side, iso)            → room | null  (never creates)
//   getRoom(roomId)                    → room | null
//   addMessage(message)                → message
//   listMessages(roomId, sinceIso, nowIso, limit) → live messages created after sinceIso, oldest first
//   countMessages(roomId, nowIso)      → live messages in the room
//   getMessage(roomId, id)             → message | null
//   setStatus(roomId, id, status)      → message | null  (status only moves forward)
//   putUpload(upload)                  → upload
//   getUpload(fileId)                  → upload | null
//   extendUpload(fileId, iso, maxIso)  → upload | null  (expiry only grows, never past maxIso)
//   storedBytes({ roomId?, ip? })      → bytes of every non-owner upload still on record (expired or
//                                         not: a record goes only after its file is deleted)
//   addUsage(key, bytes)               → total counted under key after adding (e.g. 'dl:2026-10-18')
//   expiredUploads(nowIso, limit)      → fileIds whose uploads expired
//   removeUploads(fileIds)
//   purge(nowIso)                      → drops expired messages, rooms idle for 30 days, old usage keys
import fs from 'node:fs';
import path from 'node:path';
import { databaseUrl } from './shares.js';

const ORDER = { waiting: 0, received: 1, opened: 2 };
const ROOM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 10;
const maxIso = (a, b) => (a > b ? a : b);
const minIso = (a, b) => (a < b ? a : b);

export function fileRooms(dataDir) {
  const file = path.join(dataDir, 'rooms.json');
  const load = () => {
    try {
      return { rooms: {}, messages: [], uploads: {}, usage: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return { rooms: {}, messages: [], uploads: {}, usage: {} };
    }
  };
  const save = (db) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };
  const change = (fn) => {
    const db = load();
    const out = fn(db);
    save(db);
    return out;
  };

  return {
    kind: 'file',
    async create(roomId, at) {
      return change((db) => {
        db.rooms[roomId] ||= { id: roomId, createdAt: at, laptopSeenAt: at, phoneSeenAt: null };
        return { ...db.rooms[roomId] };
      });
    },
    async seen(roomId, side, at) {
      return change((db) => {
        const room = db.rooms[roomId];
        if (!room) return null;
        room[side === 'phone' ? 'phoneSeenAt' : 'laptopSeenAt'] = at;
        return { ...room };
      });
    },
    async getRoom(roomId) {
      return load().rooms[roomId] || null;
    },
    async addMessage(message) {
      return change((db) => { db.messages.push(message); return message; });
    },
    async listMessages(roomId, sinceIso = '', at = '', limit = LIST_LIMIT) {
      return load().messages.filter((m) => m.roomId === roomId && m.createdAt > sinceIso && m.expiresAt > at)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    },
    async countMessages(roomId, at) {
      return load().messages.filter((m) => m.roomId === roomId && m.expiresAt > at).length;
    },
    async getMessage(roomId, id) {
      return load().messages.find((m) => m.roomId === roomId && m.id === id) || null;
    },
    async setStatus(roomId, id, status) {
      return change((db) => {
        const m = db.messages.find((x) => x.roomId === roomId && x.id === id);
        if (!m) return null;
        if (ORDER[status] > ORDER[m.status]) m.status = status;
        return { ...m };
      });
    },
    async putUpload(upload) {
      return change((db) => { db.uploads[upload.fileId] = upload; return upload; });
    },
    async getUpload(fileId) {
      return load().uploads[fileId] || null;
    },
    async extendUpload(fileId, at, cap) {
      return change((db) => {
        const u = db.uploads[fileId];
        if (!u) return null;
        u.expiresAt = maxIso(u.expiresAt, minIso(at, cap));
        return { ...u };
      });
    },
    async storedBytes({ roomId, ip } = {}) {
      return Object.values(load().uploads)
        .filter((u) => !u.owner && (!roomId || u.roomId === roomId) && (!ip || u.ip === ip))
        .reduce((n, u) => n + u.size, 0);
    },
    async addUsage(key, bytes) {
      return change((db) => {
        db.usage[key] = (db.usage[key] || 0) + bytes;
        return db.usage[key];
      });
    },
    async expiredUploads(at, limit = 500) {
      return Object.values(load().uploads).filter((u) => u.expiresAt < at).slice(0, limit).map((u) => u.fileId);
    },
    async removeUploads(fileIds) {
      change((db) => { for (const id of fileIds) delete db.uploads[id]; });
    },
    async purge(at) {
      change((db) => {
        const idleBefore = new Date(Date.parse(at) - ROOM_IDLE_MS).toISOString();
        db.messages = db.messages.filter((m) => m.expiresAt >= at);
        for (const [id, room] of Object.entries(db.rooms)) {
          const last = [room.laptopSeenAt, room.phoneSeenAt, room.createdAt].filter(Boolean).sort().pop();
          if (last < idleBefore) delete db.rooms[id];
        }
        const today = at.slice(0, 10);
        for (const key of Object.keys(db.usage)) if (key.slice(-10) < today.slice(0, 8) + '00') delete db.usage[key];
      });
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mmbasap_rooms (
    id             text PRIMARY KEY,
    created_at     timestamptz NOT NULL,
    laptop_seen_at timestamptz,
    phone_seen_at  timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS mmbasap_messages (
    room_id    text NOT NULL,
    id         text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    iv         text NOT NULL,
    data       text NOT NULL,
    file_ids   jsonb NOT NULL DEFAULT '[]',
    status     text NOT NULL DEFAULT 'waiting',
    PRIMARY KEY (room_id, id)
  )`,
  'CREATE INDEX IF NOT EXISTS mmbasap_messages_room_created ON mmbasap_messages (room_id, created_at)',
  `CREATE TABLE IF NOT EXISTS mmbasap_uploads (
    file_id    text PRIMARY KEY,
    room_id    text,
    size       bigint NOT NULL,
    owner      boolean NOT NULL DEFAULT false,
    ip         text,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  'ALTER TABLE mmbasap_uploads ADD COLUMN IF NOT EXISTS ip text',
  'CREATE INDEX IF NOT EXISTS mmbasap_uploads_expires ON mmbasap_uploads (expires_at)',
  `CREATE TABLE IF NOT EXISTS mmbasap_usage (
    key   text PRIMARY KEY,
    bytes bigint NOT NULL
  )`,
];

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const roomOf = (r) => (r ? { id: r.id, createdAt: iso(r.created_at), laptopSeenAt: iso(r.laptop_seen_at), phoneSeenAt: iso(r.phone_seen_at) } : null);
const messageOf = (r) => (r ? {
  id: r.id, roomId: r.room_id, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), iv: r.iv, data: r.data,
  fileIds: typeof r.file_ids === 'string' ? JSON.parse(r.file_ids) : r.file_ids || [], status: r.status,
} : null);
const uploadOf = (r) => (r ? {
  fileId: r.file_id, roomId: r.room_id, size: Number(r.size), owner: r.owner, ip: r.ip || null, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
} : null);

/** connect(url) → { query(text, params) → rows } — injectable for tests. */
export function neonRooms(url, { connect } = {}) {
  let ready = null;
  const db = () => (ready ||= (async () => {
    const sql = connect ? connect(url) : (await import('@neondatabase/serverless')).neon(url);
    for (const statement of SCHEMA) await sql.query(statement); // creates the tables on first use
    return sql;
  })().catch((err) => { ready = null; throw err; }));
  const q = async (text, params) => (await db()).query(text, params);

  return {
    kind: 'database',
    async create(roomId, at) {
      await q('INSERT INTO mmbasap_rooms (id, created_at, laptop_seen_at) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING', [roomId, at]);
      return this.getRoom(roomId);
    },
    async seen(roomId, side, at) {
      const column = side === 'phone' ? 'phone_seen_at' : 'laptop_seen_at';
      return roomOf((await q(`UPDATE mmbasap_rooms SET ${column} = $2 WHERE id = $1 RETURNING *`, [roomId, at]))[0]);
    },
    async getRoom(roomId) {
      return roomOf((await q('SELECT * FROM mmbasap_rooms WHERE id = $1', [roomId]))[0]);
    },
    async addMessage(m) {
      await q(
        'INSERT INTO mmbasap_messages (room_id, id, created_at, expires_at, iv, data, file_ids, status) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (room_id, id) DO NOTHING',
        [m.roomId, m.id, m.createdAt, m.expiresAt, m.iv, m.data, JSON.stringify(m.fileIds), m.status],
      );
      return m;
    },
    async listMessages(roomId, sinceIso, at, limit = LIST_LIMIT) {
      const rows = await q(
        `SELECT * FROM mmbasap_messages WHERE room_id = $1 AND created_at > $2 AND expires_at > $3 ORDER BY created_at LIMIT ${Number(limit) | 0}`,
        [roomId, sinceIso || '1970-01-01T00:00:00Z', at || '1970-01-01T00:00:00Z'],
      );
      return rows.map(messageOf);
    },
    async countMessages(roomId, at) {
      const rows = await q('SELECT count(*)::int AS n FROM mmbasap_messages WHERE room_id = $1 AND expires_at > $2', [roomId, at]);
      return Number(rows[0]?.n || 0);
    },
    async getMessage(roomId, id) {
      return messageOf((await q('SELECT * FROM mmbasap_messages WHERE room_id = $1 AND id = $2', [roomId, id]))[0]);
    },
    async setStatus(roomId, id, status) {
      // Status only moves forward: waiting → received → opened.
      const rows = await q(
        `UPDATE mmbasap_messages SET status = $3 WHERE room_id = $1 AND id = $2
           AND (CASE status WHEN 'waiting' THEN 0 WHEN 'received' THEN 1 ELSE 2 END)
             < (CASE $3::text WHEN 'waiting' THEN 0 WHEN 'received' THEN 1 ELSE 2 END)
         RETURNING *`,
        [roomId, id, status],
      );
      return messageOf(rows[0]) || this.getMessage(roomId, id);
    },
    async putUpload(u) {
      await q(
        'INSERT INTO mmbasap_uploads (file_id, room_id, size, owner, ip, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [u.fileId, u.roomId, u.size, u.owner, u.ip || null, u.createdAt, u.expiresAt],
      );
      return u;
    },
    async getUpload(fileId) {
      return uploadOf((await q('SELECT * FROM mmbasap_uploads WHERE file_id = $1', [fileId]))[0]);
    },
    async extendUpload(fileId, at, cap) {
      const rows = await q(
        'UPDATE mmbasap_uploads SET expires_at = GREATEST(expires_at, LEAST($2::timestamptz, $3::timestamptz)) WHERE file_id = $1 RETURNING *',
        [fileId, at, cap],
      );
      return uploadOf(rows[0]);
    },
    async storedBytes({ roomId, ip } = {}) {
      const where = ['NOT owner'];
      const params = [];
      if (roomId) { params.push(roomId); where.push(`room_id = $${params.length}`); }
      if (ip) { params.push(ip); where.push(`ip = $${params.length}`); }
      const rows = await q(`SELECT COALESCE(SUM(size), 0)::bigint AS n FROM mmbasap_uploads WHERE ${where.join(' AND ')}`, params);
      return Number(rows[0]?.n || 0);
    },
    async addUsage(key, bytes) {
      const rows = await q(
        'INSERT INTO mmbasap_usage (key, bytes) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET bytes = mmbasap_usage.bytes + $2 RETURNING bytes',
        [key, bytes],
      );
      return Number(rows[0].bytes);
    },
    async expiredUploads(at, limit = 500) {
      return (await q(`SELECT file_id FROM mmbasap_uploads WHERE expires_at < $1 ORDER BY expires_at LIMIT ${Number(limit) | 0}`, [at])).map((r) => r.file_id);
    },
    async removeUploads(fileIds) {
      if (fileIds.length) await q('DELETE FROM mmbasap_uploads WHERE file_id = ANY($1::text[])', [fileIds]);
    },
    async purge(at) {
      await q('DELETE FROM mmbasap_messages WHERE expires_at < $1', [at]);
      await q(
        'DELETE FROM mmbasap_rooms WHERE GREATEST(created_at, COALESCE(laptop_seen_at, created_at), COALESCE(phone_seen_at, created_at)) < $1',
        [new Date(Date.parse(at) - ROOM_IDLE_MS).toISOString()],
      );
      // Usage keys end in a date; keep this month's.
      await q("DELETE FROM mmbasap_usage WHERE right(key, 10) < $1", [`${at.slice(0, 8)}00`]);
    },
  };
}

export function createRooms({ env = process.env, dataDir }) {
  const url = databaseUrl(env);
  return url ? neonRooms(url) : fileRooms(dataDir);
}
