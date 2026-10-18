// The page a recipient sees after tapping the link in the SMS (GET /s/:id).
// Plain server-rendered HTML that works on any phone browser: the full text
// with a Copy button, and a Download button per file. Viewing the page changes
// nothing (link-preview bots fetch it too); downloads are POSTs that redirect
// to a short-lived signed URL.
import { formatBytes } from '../public/js/sms.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Escaped text with http(s) links made clickable. Everything else stays inert text. */
export function linkify(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    out += escapeHtml(s.slice(last, m.index));
    const href = escapeHtml(m[0]);
    out += `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank">${href}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

const dateText = (iso) => new Date(iso).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--line:rgba(16,24,40,.12);--text:#12161c;--muted:#4a5361;--accent:#3d5afe;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#16191f;--line:rgba(230,235,245,.12);--text:#e8eaef;--muted:#a3abb8;--accent:#8c9eff;--on:#0b1033}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
.brand{font-weight:600;letter-spacing:-.01em;color:var(--muted);font-size:14px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.text{white-space:pre-wrap;word-break:break-word;margin:0 0 14px}
a{color:var(--accent)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:10px;border:0;background:var(--accent);color:var(--on);font:600 15px system-ui,sans-serif;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.file{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.file:first-of-type{border-top:0;padding-top:0}
.file .name{flex:1;min-width:0;overflow-wrap:anywhere}.file .size{color:var(--muted);font-size:14px}
.foot{color:var(--muted);font-size:13px}
h1{font-size:20px;margin:0 0 8px}
`;

function page(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html><html lang="en-IN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><div class="brand">MMBASAP</div>${body}</main></body></html>`,
  };
}

export function sharePage(share, { now = new Date() } = {}) {
  if (!share) return page('Not found', '<div class="card"><h1>Nothing here</h1><p class="foot">This link is wrong or the share was deleted.</p></div>', 404);
  if (new Date(share.expiresAt) <= now) return page('Expired', '<div class="card"><h1>This share has expired</h1><p class="foot">Ask the sender to send it again.</p></div>', 410);

  const text = share.text
    ? `<div class="card"><p class="text" id="t">${linkify(share.text)}</p>
<button class="btn ghost" type="button" id="copy">Copy text</button></div>`
    : '';
  const files = share.files?.length
    ? `<div class="card">${share.files.map((f, i) => `<form class="file" method="post" action="/s/${escapeHtml(share.id)}/file/${i}">
<span class="name">${escapeHtml(f.name)}</span><span class="size">${escapeHtml(formatBytes(f.size))}</span>
<button class="btn" type="submit">Download</button></form>`).join('')}</div>`
    : '';
  const script = share.text
    ? `<script>document.getElementById('copy').onclick=function(){var b=this,t=document.getElementById('t').innerText;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied'},function(){
var r=document.createRange();r.selectNodeContents(document.getElementById('t'));var s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Selected — copy it'})}</script>`
    : '';
  return page('Shared with you', `${text}${files}<p class="foot">Sent ${escapeHtml(dateText(share.createdAt))} · link works until ${escapeHtml(dateText(share.expiresAt))}</p>${script}`);
}
