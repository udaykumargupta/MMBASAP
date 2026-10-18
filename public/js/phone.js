// MMBASAP on the phone. Scanning the laptop's QR code opens this page with
// the pairing in the URL fragment; it is saved here and the fragment is
// wiped. The page then checks the room every few seconds (while it's on
// screen) and shows each message from the laptop as a card with one big
// button: it opens WhatsApp or Messages with the number and text filled in,
// and the user taps Send there. Files for WhatsApp are fetched ahead of time
// so the Share button can hand them straight over (sharing has to happen
// right after a tap, so it can't wait for a download).
import { h, icon, logoSvg, toast } from './ui.js';
import { messageAad, openJson, outgoingText, parsePairFragment, smsLink, validPairing, whatsappLink } from './pair.js';
import { formatBytes } from './sms.js';

const root = document.getElementById('app');
const PAIR_KEY = 'mmbasap.pairing';
const DONE_KEY = 'mmbasap.done';
const POLL_MS = 3000;
const AUTO_FETCH_MAX = 50 * 1024 * 1024; // Android can't share more than about 50 MB at once
const MAX_AGE_MS = 25 * 60 * 60 * 1000;  // messages live a day on the server; anything older is a replay
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  /** false when storage is blocked (private mode): the pairing then lasts only for this visit. */
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  drop(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

async function getJson(path, options = {}) {
  const res = await fetch(path, { cache: 'no-store', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Server returned ${res.status}`), { status: res.status });
  return body;
}
const postStatus = (pairing, id, status) => fetch(`/api/rooms/${pairing.roomId}/messages/${id}/status`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }), keepalive: true,
}).catch(() => {});

const prettyNumber = (e164) => e164.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');
const when = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

/** Only accept what the laptop page produces; anything else is dropped. */
function cleanPayload(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.channel !== 'whatsapp' && p.channel !== 'sms') return null;
  if (typeof p.to !== 'string' || !/^\+\d{8,15}$/.test(p.to)) return null;
  const files = Array.isArray(p.files) ? p.files.filter((f) => f && typeof f.id === 'string').slice(0, 5).map((f) => ({
    id: f.id, name: String(f.name || 'file').slice(0, 200), type: typeof f.type === 'string' ? f.type : '', size: Number(f.size) || 0,
  })) : [];
  const link = typeof p.link === 'string' && p.link.startsWith(`${location.origin}/s/`) ? p.link : '';
  const sentAt = Date.parse(p.sentAt);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_AGE_MS) return null;
  return { channel: p.channel, to: p.to, text: typeof p.text === 'string' ? p.text.slice(0, 10_000) : '', files, link, sentAt: p.sentAt };
}

/** Whether this browser can hand files like these to other apps (checked before downloading anything). */
function canShareFiles(fileObjects) {
  try { return Boolean(navigator.canShare && navigator.canShare({ files: fileObjects })); } catch { return false; }
}

// ------------------------------------------------------------- not paired
function renderUnpaired() {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('div', { class: 'auth-gate' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-logo', html: logoSvg() }),
    h('h1', {}, 'MMBASAP'),
    h('p', { class: 'auth-intro' }, 'Open MMBASAP on your laptop, choose WhatsApp or SMS, and scan the QR code with this phone’s camera.'),
    h('p', { class: 'auth-foot', html: `${icon('lock')}<span>Message text is end-to-end encrypted between your laptop and this phone.</span>` }))));
}

// ----------------------------------------------------------------- paired
function renderPaired(pairing, { persisted }) {
  root.removeAttribute('aria-busy');
  const done = new Set(store.get(DONE_KEY, []));
  const cards = new Map(); // message id → { el } (null while being built)
  let since = '';
  let timer = null;
  let failures = 0;
  let alive = true;
  let inflight = false;
  let again = false;
  let downloads = Promise.resolve(); // one card's files at a time

  const status = h('span', { class: 'phone-status' }, 'Connecting…');
  const onVisible = () => { if (!document.hidden) poll(); };
  function teardown() {
    alive = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  }
  const unpair = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Unpair this phone', title: 'Unpair', html: icon('logout'),
    onclick: () => {
      if (!confirm('Unpair this phone? You can pair again by scanning a new QR code on your laptop.')) return;
      teardown();
      store.drop(PAIR_KEY);
      store.drop(DONE_KEY);
      renderUnpaired();
    },
  });
  const list = h('div', { class: 'phone-list' });
  const empty = h('div', { class: 'phone-empty' },
    h('span', { class: 'phone-empty-icon', html: icon('phone') }),
    h('strong', {}, 'Paired with your laptop'),
    h('span', {}, 'Type a message on the laptop and press “Send to my phone”. It will pop up here — keep this page open.'),
    persisted ? null : h('span', { class: 'hint bad-text' }, 'This browser won’t remember the pairing (private mode?). Scan again next time.'),
    ios ? null : h('span', { class: 'hint' }, 'Tip: add this page to your home screen to open it in one tap.'));
  root.replaceChildren(
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: logoSvg() }), 'MMBASAP'),
      h('div', { class: 'topbar-actions' }, status, unpair))),
    h('main', { class: 'main phone-main' }, empty, list));

  function syncEmpty() {
    empty.hidden = [...cards.values()].some((c) => c && !c.el.classList.contains('done'));
  }

  function markDone(id) {
    done.add(id);
    store.set(DONE_KEY, [...done].slice(-200));
    const c = cards.get(id);
    if (c) c.el.classList.add('done');
    syncEmpty();
  }

  async function downloadFiles(payload, note) {
    const out = [];
    for (const [i, f] of payload.files.entries()) {
      note.textContent = `Getting file ${i + 1} of ${payload.files.length}…`;
      const { url } = await getJson(`/api/rooms/${pairing.roomId}/file?f=${encodeURIComponent(f.id)}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      out.push(new File([blob], f.name, { type: f.type || blob.type || 'application/octet-stream' }));
    }
    return out;
  }

  function renderCard(message, payload) {
    const isWhatsApp = payload.channel === 'whatsapp';
    const hasFiles = payload.files.length > 0;
    const note = h('div', { class: 'phone-note' });
    const linkLine = hasFiles && payload.link
      ? h('a', { class: 'phone-link', href: payload.link, target: '_blank', rel: 'noopener noreferrer' }, 'Download link for the files')
      : null;
    let shareable = null; // File[] once fetched and the browser can share them

    const openText = () => outgoingText(payload, { includeLink: hasFiles && (!isWhatsApp || !shareable) });
    const openBtn = h('a', {
      class: 'btn primary phone-open', rel: 'noopener',
      html: `${icon('send')}<span>${isWhatsApp ? 'Open WhatsApp chat' : 'Open Messages'}</span>`,
    });
    const syncOpen = () => {
      openBtn.href = isWhatsApp ? whatsappLink(payload.to, openText()) : smsLink(payload.to, openText(), { ios });
    };
    syncOpen();
    openBtn.addEventListener('click', () => { postStatus(pairing, message.id, 'opened'); });

    const shareBtn = hasFiles && isWhatsApp ? h('button', { class: 'btn ghost', type: 'button', hidden: true }) : null;
    const getBtn = hasFiles && isWhatsApp ? h('button', { class: 'btn ghost', type: 'button', hidden: true, html: `${icon('clip')}<span>Get files to share</span>` }) : null;
    const doneBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => markDone(message.id) }, 'Done');
    const el = h('article', { class: `card phone-card${done.has(message.id) ? ' done' : ''}` },
      h('div', { class: 'phone-card-head' },
        h('span', { class: `badge ${isWhatsApp ? 'wa' : 'sms'}` }, isWhatsApp ? 'WhatsApp' : 'SMS'),
        h('strong', { class: 'phone-to' }, prettyNumber(payload.to)),
        h('time', { datetime: payload.sentAt }, when(payload.sentAt))),
      payload.text ? h('p', { class: 'phone-text' }, payload.text) : null,
      hasFiles ? h('ul', { class: 'phone-files' }, payload.files.map((f) => h('li', {},
        h('span', { html: icon('file') }), h('span', { class: 'file-name' }, f.name), h('span', { class: 'file-meta' }, formatBytes(f.size))))) : null,
      h('div', { class: 'phone-actions' }, openBtn, shareBtn, getBtn, doneBtn),
      note, linkLine);

    function useLink(reason) {
      shareable = null;
      if (shareBtn) shareBtn.hidden = true;
      if (getBtn) getBtn.hidden = true;
      note.textContent = reason;
      syncOpen();
    }

    if (!hasFiles) return el;
    if (!isWhatsApp) { note.textContent = 'SMS can’t carry files, so the text includes a download link.'; return el; }

    // WhatsApp: can this phone hand such files over at all? Ask before downloading anything.
    const total = payload.files.reduce((n, f) => n + (f.size || 0), 0);
    if (!ios && total > AUTO_FETCH_MAX) {
      useLink('These files are too big to hand to WhatsApp directly, so the message includes a download link instead.');
      return el;
    }
    const probe = payload.files.map((f) => new File([], f.name, { type: f.type || 'application/octet-stream' }));
    if (!canShareFiles(probe)) {
      useLink('This phone can’t hand these files to WhatsApp directly, so the message includes a download link instead.');
      return el;
    }
    const fetchFiles = () => {
      if (getBtn) getBtn.hidden = true;
      note.textContent = 'Getting files ready…';
      downloads = downloads.then(async () => {
        if (!alive) return;
        try {
          const fileObjects = await downloadFiles(payload, note);
          if (!canShareFiles(fileObjects)) return useLink('This phone can’t hand these files to WhatsApp directly, so the message includes a download link instead.');
          shareable = fileObjects;
          shareBtn.hidden = false;
          shareBtn.innerHTML = `${icon('clip')}<span>${fileObjects.length > 1 ? `Share ${fileObjects.length} files to WhatsApp` : 'Share file to WhatsApp'}</span>`;
          note.textContent = 'Step 1: open the chat and send the text. Step 2: share the file and pick the same chat.';
          syncOpen();
        } catch {
          useLink('Couldn’t get the files onto this phone, so the message includes a download link instead.');
        }
      });
    };
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.share({ files: shareable });
        postStatus(pairing, message.id, 'opened');
      } catch (err) {
        if (err?.name !== 'AbortError') useLink('Sharing didn’t work, so the message includes a download link instead.');
      }
    });
    getBtn.addEventListener('click', fetchFiles);
    // Fetch right away only the first time a message arrives; after that, only on a tap.
    if (message.status === 'waiting' && !done.has(message.id)) fetchFiles();
    else if (done.has(message.id)) note.textContent = payload.link ? 'The files are still available from the download link below.' : '';
    else { getBtn.hidden = false; note.textContent = 'Tap “Get files to share” to download them.'; }
    return el;
  }

  async function poll() {
    clearTimeout(timer);
    if (!alive || document.hidden) return; // resumes on visibilitychange
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      const { messages, more } = await getJson(`/api/rooms/${pairing.roomId}/messages?since=${encodeURIComponent(since)}`);
      if (more) again = true; // a page of 10; fetch the rest straight away
      if (!alive) return;
      failures = 0;
      status.textContent = 'Paired';
      status.className = 'phone-status ok';
      for (const message of messages) {
        if (message.createdAt > since) since = message.createdAt;
        if (cards.has(message.id)) continue;
        cards.set(message.id, null); // reserved, so an overlapping poll skips it
        let payload = null;
        try {
          payload = cleanPayload(await openJson(pairing.key, message, messageAad(pairing.roomId, message.id)));
        } catch { /* not for this key (an old pairing) or tampered with — ignore */ }
        if (!alive) return;
        if (!payload) continue;
        const el = renderCard(message, payload);
        cards.set(message.id, { el });
        list.prepend(el);
        if (message.status === 'waiting') postStatus(pairing, message.id, 'received');
        if (!done.has(message.id) && message.status === 'waiting') {
          try { navigator.vibrate?.(80); } catch { /* ignore */ }
        }
      }
      syncEmpty();
    } catch {
      if (!alive) return;
      failures++;
      status.textContent = failures > 2 ? 'Offline — retrying' : 'Reconnecting…';
      status.className = 'phone-status bad';
    } finally {
      inflight = false;
    }
    if (!alive) return;
    if (again) { again = false; poll(); return; }
    timer = setTimeout(poll, failures ? Math.min(POLL_MS * 2 ** failures, 30_000) : POLL_MS);
  }

  document.addEventListener('visibilitychange', onVisible);
  syncEmpty();
  poll();
}

// ------------------------------------------------------------------- boot
function start() {
  if (!window.isSecureContext || !crypto.subtle) {
    root.removeAttribute('aria-busy');
    root.replaceChildren(h('div', { class: 'auth-gate' }, h('div', { class: 'auth-card' },
      h('h1', {}, 'MMBASAP'), h('p', { class: 'auth-intro' }, 'This page needs a secure (https) connection to decrypt your messages. Open it from your MMBASAP https address.'))));
    return;
  }
  let fromQr = parsePairFragment(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname); // keep the key out of history and screenshots
  const stored = store.get(PAIR_KEY, null);
  if (fromQr && validPairing(stored) && (stored.roomId !== fromQr.roomId || stored.key !== fromQr.key)
    && !confirm('This phone is already paired with a laptop. Pair it with the new one instead?')) {
    fromQr = null;
  }
  let persisted = true;
  if (fromQr) {
    persisted = store.set(PAIR_KEY, fromQr);
    store.drop(DONE_KEY);
    toast('Phone paired with your laptop', { tone: 'ok' });
  }
  const pairing = fromQr || stored;
  if (validPairing(pairing)) renderPaired(pairing, { persisted });
  else renderUnpaired();
}

// Scanning a new QR inside the installed app only changes the #fragment: reload to pick it up.
window.addEventListener('hashchange', () => { if (parsePairFragment(location.hash)) location.reload(); });

start();
