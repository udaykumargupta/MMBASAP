// Where attached files live. Vercel functions only accept 4.5 MB per request,
// so file bytes never go through our API: the browser asks for an upload
// target and PUTs the file straight there; downloads redirect to a short-lived
// signed URL. Two backends with the same contract:
//   blobFiles  — a private Vercel Blob store (BLOB_READ_WRITE_TOKEN), for deployments
//   localFiles — files under data/files, served by our own signed URLs, for this Mac
//
// Contract:
//   newFileId(name)                    → 'mmbasap/<random>/<safe name>'
//   uploadTarget({ fileId, type, size })→ { url, method: 'PUT', headers } — refuses bodies over size
//   exists(fileId)                     → boolean
//   downloadUrl(fileId, { type, name })→ url valid for a few minutes
//   remove(fileIds)
//   handle(req, res, url)              → true when it answered (localFiles only)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomId } from './ids.js';

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // phone videos fit; Vercel Blob free storage is 1 GB
export const MAX_FILES = 5;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_TTL_MS = 30 * 1000; // the phone and the share page use the URL at once
const FILE_ID = /^mmbasap\/[A-Za-z0-9]{16}\/[A-Za-z0-9._-]{1,80}$/;

export const isFileId = (id) => typeof id === 'string' && FILE_ID.test(id);

/** A name that is safe in a URL path and on disk; keeps the extension. */
export function safeName(name) {
  const base = String(name || 'file').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  if (!base) return 'file';
  if (base.length <= 80) return base;
  const ext = path.extname(base).slice(0, 12);
  return base.slice(0, 80 - ext.length) + ext;
}

/** A random folder per file; the (sanitised) name stays so downloads save under it. The store is private. */
const newFileId = (name) => `mmbasap/${randomId(16)}/${safeName(name)}`;

// Local downloads are shown in the browser only for plainly safe types;
// everything else (HTML, SVG, XML/XSL, scripts…) is forced to download.
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i;

export function localFiles({ dir, secret = crypto.randomBytes(32).toString('hex'), maxBytes = MAX_FILE_BYTES, now = Date.now }) {
  const sign = (parts) => crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('base64url');
  const fileOf = (id) => path.join(dir, ...id.split('/'));
  const signedUrl = (op, fileId, ttl, extra = {}) => {
    const exp = String(now() + ttl);
    const q = new URLSearchParams({ op, f: fileId, exp, ...extra });
    q.set('sig', sign([op, fileId, exp, extra.t || '', extra.n || '', extra.s || '']));
    return `/api/local-file?${q}`;
  };

  function verify(q) {
    const op = q.get('op'), f = q.get('f'), exp = q.get('exp'), sig = q.get('sig') || '';
    if (!isFileId(f) || !(Number(exp) > now())) return null;
    const want = sign([op, f, exp, q.get('t') || '', q.get('n') || '', q.get('s') || '']);
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { op, fileId: f, size: Number(q.get('s')) || maxBytes };
  }

  const reply = (res, status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };

  return {
    kind: 'local',
    newFileId,
    async uploadTarget({ fileId, size = maxBytes }) {
      return { url: signedUrl('put', fileId, UPLOAD_TTL_MS, { s: String(Math.min(size, maxBytes)) }), method: 'PUT', headers: {} };
    },
    async exists(fileId) {
      return isFileId(fileId) && fs.existsSync(fileOf(fileId));
    },
    async downloadUrl(fileId, { type = '', name = '' } = {}) {
      return signedUrl('get', fileId, DOWNLOAD_TTL_MS, { t: type, n: name });
    },
    async remove(fileIds) {
      for (const id of fileIds) {
        if (!isFileId(id)) continue;
        fs.rmSync(path.dirname(fileOf(id)), { recursive: true, force: true });
      }
    },
    async handle(req, res, url) {
      if (url.pathname !== '/api/local-file') return false;
      const ok = verify(url.searchParams);
      if (!ok) { reply(res, 403, 'This link is invalid or has expired.'); return true; }
      const file = fileOf(ok.fileId);
      if (ok.op === 'put' && req.method === 'PUT') {
        if (fs.existsSync(file)) { reply(res, 409, 'Already uploaded'); return true; }
        const chunks = [];
        let size = 0, tooBig = false;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > ok.size) { tooBig = true; continue; } // keep reading so the 413 reaches the browser
          chunks.push(chunk);
        }
        if (tooBig) { reply(res, 413, 'File too large'); return true; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, Buffer.concat(chunks));
        fs.renameSync(`${file}.tmp`, file);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, size }));
        return true;
      }
      if (ok.op === 'get' && req.method === 'GET') {
        if (!fs.existsSync(file)) { reply(res, 404, 'This file is gone.'); return true; }
        const type = url.searchParams.get('t') || 'application/octet-stream';
        const name = url.searchParams.get('n') || path.basename(file);
        const inline = INLINE.test(type);
        res.writeHead(200, {
          'Content-Type': inline ? type : 'application/octet-stream',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': fs.statSync(file).size,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        });
        fs.createReadStream(file).pipe(res);
        return true;
      }
      reply(res, 405, 'Method not allowed');
      return true;
    },
  };
}

/** sdk() → the @vercel/blob module — injectable for tests. */
export function blobFiles({ token, maxBytes = MAX_FILE_BYTES, now = Date.now, sdk = () => import('@vercel/blob') }) {
  return {
    kind: 'blob',
    newFileId,
    async uploadTarget({ fileId, type, size = maxBytes }) {
      const { issueSignedToken, presignUrl, parseStoreIdFromDelegationToken } = await sdk();
      const validUntil = now() + UPLOAD_TTL_MS;
      const limit = Math.min(size, maxBytes); // the declared size is the most the URL accepts
      const signed = await issueSignedToken({ token, pathname: fileId, operations: ['put'], validUntil, maximumSizeInBytes: limit });
      const { presignedUrl } = await presignUrl(signed, {
        operation: 'put', pathname: fileId, access: 'private', validUntil, maximumSizeInBytes: limit, allowOverwrite: false, addRandomSuffix: false,
      });
      // The same headers @vercel/blob's own browser upload sends with a presigned PUT.
      return {
        url: presignedUrl,
        method: 'PUT',
        headers: {
          'x-api-version': '12',
          'x-vercel-blob-access': 'private',
          'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(signed.delegationToken),
          'x-content-type': type || 'application/octet-stream',
        },
      };
    },
    async exists(fileId) {
      if (!isFileId(fileId)) return false;
      const { head, BlobNotFoundError } = await sdk();
      try {
        await head(fileId, { token });
        return true;
      } catch (err) {
        const missing = (BlobNotFoundError && err instanceof BlobNotFoundError) || err?.name === 'BlobNotFoundError'
          || /does not exist|not.?found/i.test(err?.message || '');
        if (missing) return false;
        throw err;
      }
    },
    async downloadUrl(fileId) {
      const { issueSignedToken, presignUrl } = await sdk();
      const validUntil = now() + DOWNLOAD_TTL_MS;
      const signed = await issueSignedToken({ token, pathname: fileId, operations: ['get'], validUntil });
      const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname: fileId, access: 'private', validUntil });
      return presignedUrl;
    },
    async remove(fileIds) {
      const ids = fileIds.filter(isFileId);
      if (!ids.length) return;
      const { del } = await sdk();
      await del(ids, { token });
    },
  };
}

export function createFiles({ env = process.env, dataDir, secret }) {
  const token = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  return token ? blobFiles({ token }) : localFiles({ dir: path.join(dataDir, 'files'), secret });
}
