// MMBASAP on the laptop: two cards. "What to send" (text, links, files) and
// "Deliver to" (WhatsApp or SMS through your paired phone, or the owner's
// Auto SMS). Pair-your-phone works for anyone: a QR code links this browser
// to a phone once; after that each message pops up on the phone, which opens
// WhatsApp or Messages pre-filled so it goes out from the user's own number.
import { h, icon, logoSvg, toast } from './ui.js';
import { api, getConfig, loadConfig, onSignOut, ownerSignedIn, passcodeForm, signOut } from './api.js';
import { messageAad, newPairing, pairUrl, randomId, sealJson, validPairing } from './pair.js';
import { qrSvg } from './qr.js';
import { cleanText, composeSms, formatBytes, normalizePhone, segments, MAX_TEXT } from './sms.js';

const root = document.getElementById('app');
const POLL_MS = 2500;
const POLL_FOR_MS = 10 * 60 * 1000;
const SLOW_PHONE_MS = 30 * 1000;

const AUTO_STATUS = {
  sending: { text: 'Sending…', tone: 'busy', icon: 'clock' },
  queued: { text: 'Waiting for the owner’s phone to send it', tone: 'busy', icon: 'phone' },
  sent: { text: 'Sent from the owner’s phone', tone: 'ok', icon: 'check' },
  delivered: { text: 'Delivered', tone: 'ok', icon: 'check' },
  failed: { text: 'Not sent', tone: 'bad', icon: 'warn' },
};
const PHONE_PILL = { sending: ['busy', 'Sending'], waiting: ['busy', 'Waiting for phone'], received: ['ok', 'On your phone'], opened: ['ok', 'Opened'], failed: ['bad', 'Not sent'], expired: ['bad', 'Expired'] };

// ------------------------------------------------------------- theme/prefs
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f4f5f8' : '#0e1014';
  try { localStorage.setItem('mmbasap.theme', t); } catch { /* ignore */ }
}
const theme = () => document.documentElement.dataset.theme;
const prefs = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`mmbasap.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`mmbasap.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** PUT with progress (fetch can't report upload progress). onXhr gets the request so it can be aborted. */
function putFile(target, file, onProgress, onXhr) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr?.(xhr);
    xhr.open(target.method || 'PUT', target.url);
    for (const [k, v] of Object.entries(target.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? 'File too large' : `Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload blocked or network down'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { aborted: true }));
    xhr.send(file);
  });
}

const prettyNumber = (e164) => e164.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

// --------------------------------------------------------------------- app
function renderApp() {
  const config = getConfig();
  const limits = config.limits || {};
  const channels = (config.channels || []).filter((c) => !c.owner || config.owner?.available);
  const state = {
    files: [], // { file, name, size, type, fileId, progress, status: 'uploading'|'done'|'error', error }
    channel: channels.some((c) => c.id === prefs.get('channel') && c.enabled) ? prefs.get('channel') : 'whatsapp',
    expiresInDays: prefs.get('expiry', 1),
    sending: false,
    current: null, // what the status box is tracking: { kind: 'phone'|'auto', ... }
    pollTimer: null,
    pairing: validPairing(prefs.get('pairing')) ? prefs.get('pairing') : null,
    phoneSeenAt: null,
    roomTimer: null,
    roomChecked: false, // false until the first answer about this pairing arrives
    roomCreated: false,
    showQr: false,
  };
  const viaPhone = () => state.channel !== 'auto-sms';
  const dryRun = config.owner?.provider === 'console';

  // --------------------------------------------------------- header
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Switch theme', title: 'Switch theme' });
  const syncThemeBtn = () => { themeBtn.innerHTML = icon(theme() === 'light' ? 'moon' : 'sun'); };
  themeBtn.addEventListener('click', () => { setTheme(theme() === 'light' ? 'dark' : 'light'); syncThemeBtn(); });
  syncThemeBtn();
  const ownerBtn = h('button', { class: 'btn ghost small', type: 'button', hidden: !(config.owner?.available && config.owner.signInRequired) });
  const syncOwnerBtn = () => {
    ownerBtn.innerHTML = ownerSignedIn() ? `${icon('logout')}<span>Owner: lock</span>` : `${icon('lock')}<span>Owner</span>`;
  };
  ownerBtn.addEventListener('click', () => (ownerSignedIn() ? signOut() : openOwnerDialog()));
  syncOwnerBtn();
  const header = h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: logoSvg() }), 'MMBASAP'),
    h('div', { class: 'topbar-actions' }, ownerBtn, themeBtn)));

  // ---------------------------------------------------- card 1: what
  const text = h('textarea', {
    class: 'field textarea', id: 'text', rows: '9', maxlength: String(MAX_TEXT),
    placeholder: 'Paste a link, type a note, or drop files here…', 'aria-label': 'What to send',
  });
  text.value = prefs.get('draft', '');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, id: 'file-input' });
  const attachBtn = h('button', { class: 'btn ghost', type: 'button', html: `${icon('clip')}<span>Attach files</span>`, onclick: () => fileInput.click() });
  const fileHint = h('span', { class: 'hint' }, `Photos, videos, PDFs… up to ${limits.maxFiles || 5} files, ${formatBytes(limits.maxFileBytes || 100 * 1024 * 1024)} each`);
  const fileList = h('ul', { class: 'file-list', 'aria-label': 'Attached files' });
  const sendCard = h('section', { class: 'card', 'aria-labelledby': 'what-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'what-title' }, h('span', { class: 'step' }, '1'), 'What to send'),
      h('span', { class: 'from' }, 'From this browser')),
    text,
    h('div', { class: 'attach-row' }, attachBtn, fileHint, fileInput),
    fileList);

  // ---------------------------------------------------- card 2: where
  const channelBtns = new Map();
  const channelRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Send with' },
    channels.map((c) => {
      const b = h('button', {
        class: 'chip', type: 'button', role: 'radio', disabled: !c.enabled, title: c.enabled ? '' : `${c.label} is coming soon`,
        onclick: () => chooseChannel(c.id),
      }, c.owner ? h('span', { class: 'chip-lock', html: icon('lock') }) : null, c.label, c.note ? h('span', { class: 'chip-note' }, c.note) : null);
      channelBtns.set(c.id, b);
      return b;
    }));
  const channelHelp = h('div', { class: 'help' });

  const phoneRow = h('div', { class: 'pair-row' });
  const qrBox = h('div', { class: 'qr-box', hidden: true });

  const phone = h('input', {
    class: 'field', id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
    placeholder: '98765 43210', 'aria-describedby': 'phone-help',
  });
  phone.value = prefs.get('lastTo', '');
  const phoneHelp = h('div', { class: 'help', id: 'phone-help' });
  const recentRow = h('div', { class: 'recent', 'aria-label': 'Recent numbers' });
  const expiryRow = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Download link works for' },
    (limits.expiryDays || [1, 7]).map((d) => h('button', {
      type: 'button', role: 'radio', 'data-days': String(d),
      onclick: () => { state.expiresInDays = d; prefs.set('expiry', d); syncExpiry(); },
    }, d === 1 ? '1 day' : `${d} days`)));
  const expiryField = h('div', { class: 'field-group' }, h('span', { class: 'label' }, 'Download link works for'), expiryRow);
  const previewLabel = h('span', { class: 'label' }, 'The message');
  const previewBody = h('pre', { class: 'preview-body' });
  const previewMeta = h('div', { class: 'preview-meta' });
  const sendBtn = h('button', { class: 'btn primary send', type: 'button', html: `${icon('send')}<span>Send</span>` });
  const dryNote = h('div', { class: 'dry-run', role: 'note', hidden: true, html: `${icon('warn')}<span><strong>Dry run — nothing reaches a phone.</strong> Auto SMS is only printed in the terminal running MMBASAP. Add your SMS Gateway login (SMSGATE_USER, SMSGATE_PASS) to .env and restart to send for real.</span>` });
  const statusBox = h('div', { class: 'status', hidden: true, role: 'status' });
  const deliverCard = h('section', { class: 'card', 'aria-labelledby': 'where-title' },
    h('div', { class: 'card-head' }, h('h2', { id: 'where-title' }, h('span', { class: 'step' }, '2'), 'Deliver to')),
    h('div', { class: 'field-group' }, h('span', { class: 'label' }, 'Send with'), channelRow, channelHelp),
    phoneRow,
    qrBox,
    dryNote,
    h('div', { class: 'field-group' }, h('label', { class: 'label', for: 'phone' }, 'Their phone number'), phone, phoneHelp, recentRow),
    expiryField,
    h('div', { class: 'preview' }, h('div', { class: 'preview-head' }, previewLabel, previewMeta), previewBody),
    sendBtn,
    h('div', { class: 'kbd-hint' }, navigator.platform?.includes('Mac') ? '⌘ + Enter to send' : 'Ctrl + Enter to send'),
    statusBox);

  // ---------------------------------------------------- history
  const historyList = h('ul', { class: 'history-list' });
  const history = h('section', { class: 'history', 'aria-labelledby': 'history-title', hidden: true },
    h('h2', { id: 'history-title' }, 'Recent'), historyList);

  const dropMask = h('div', { class: 'drop-mask', 'aria-hidden': 'true' }, h('div', {}, 'Drop to attach'));
  root.replaceChildren(header, h('main', { class: 'main' },
    h('div', { class: 'intro' }, h('h1', {}, 'Send to any phone'), h('p', {}, 'Type or paste here, attach files, and send it on WhatsApp or SMS — from your own number.')),
    h('div', { class: 'cards' }, sendCard, deliverCard),
    history), dropMask);
  root.removeAttribute('aria-busy');

  // ---------------------------------------------------- owner sign-in
  function openOwnerDialog(then) {
    const form = passcodeForm({
      onSignedIn: () => {
        dialog.close();
        syncOwnerBtn();
        toast('Owner unlocked — Auto SMS is available', { tone: 'ok' });
        loadServerHistory();
        then?.();
      },
    });
    const dialog = h('dialog', { class: 'dialog', 'aria-label': 'Owner sign-in' },
      h('div', { class: 'dialog-head' }, h('h2', {}, 'Owner sign-in'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: icon('x'), onclick: () => dialog.close() })),
      h('p', { class: 'muted' }, 'Auto SMS sends straight from the owner’s phone without any tap. Only the owner can use it.'),
      form.el);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    form.focus();
  }
  onSignOut(() => {
    syncOwnerBtn();
    if (state.channel === 'auto-sms') chooseChannel('whatsapp');
    loadServerHistory();
  });

  // ---------------------------------------------------- pairing
  function ensurePairing() {
    if (!state.pairing) {
      state.pairing = newPairing();
      prefs.set('pairing', state.pairing);
      state.phoneSeenAt = null;
      state.roomChecked = true; // brand new: nobody has scanned it yet
      state.roomCreated = false;
    }
    return state.pairing;
  }
  /** The server only learns about a pairing when the laptop registers it. */
  async function registerRoom(p) {
    if (state.roomCreated) return;
    const { res } = await api(`/api/rooms/${p.roomId}`, { method: 'POST', json: {} });
    if (res.ok) state.roomCreated = true;
  }
  function newPhone() {
    if (state.sending) { toast('Wait for the current send to finish.', { tone: 'error' }); return; }
    if (!confirm('Pair a different phone? The phone paired now will stop getting messages.')) return;
    clearTimeout(state.pollTimer);
    clearTimeout(state.roomTimer);
    state.current = null;
    statusBox.hidden = true;
    for (const f of state.files) f.xhr?.abort();
    state.files = []; // uploads belong to the old pairing
    renderFiles(); preview(); syncSend();
    state.pairing = null;
    ensurePairing();
    state.showQr = true;
    syncPairing();
    pollRoom();
  }
  async function pollRoom() {
    clearTimeout(state.roomTimer);
    if (!state.pairing || !viaPhone()) return;
    const roomId = state.pairing.roomId;
    try {
      await registerRoom(state.pairing);
      const { res, body } = await api(`/api/rooms/${roomId}?side=laptop`);
      if (res.ok && state.pairing?.roomId === roomId) {
        if (!body.room) state.roomCreated = false; // swept after a long idle: register again next time
        setPhoneSeen(body.room?.phoneSeenAt || null);
      }
    } catch { /* offline: try again */ }
    if (document.hidden || state.pairing?.roomId !== roomId) return; // resumes on visibilitychange
    const fast = state.showQr || !state.phoneSeenAt || state.current?.tracking;
    state.roomTimer = setTimeout(pollRoom, fast ? 3000 : 30_000);
  }
  /** Records when the phone last checked in; the first time after a scan hides the QR code. */
  function setPhoneSeen(iso) {
    const wasPaired = Boolean(state.phoneSeenAt);
    const firstAnswer = !state.roomChecked;
    state.roomChecked = true;
    state.phoneSeenAt = iso || state.phoneSeenAt;
    if (!wasPaired && state.phoneSeenAt) {
      state.showQr = false;
      if (!firstAnswer) toast('Phone paired ✓', { tone: 'ok' }); // not on every reload of an already-paired laptop
    }
    syncPairing();
  }
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  let pairView = ''; // what the pairing row and QR show now, to rebuild only on change
  let qrFor = '';
  function syncPairing() {
    const checking = Boolean(state.pairing) && !state.roomChecked;
    const paired = Boolean(state.phoneSeenAt);
    const showQrBox = viaPhone() && !checking && (state.showQr || !paired);
    phoneRow.hidden = !viaPhone();
    qrBox.hidden = !showQrBox;
    if (!viaPhone()) return;
    const text = checking ? 'Checking your phone…' : paired ? `Your phone is paired · active ${ago(state.phoneSeenAt)}` : 'Pair your phone once — it does the sending';
    const view = `${checking}|${paired}`;
    if (view !== pairView) {
      pairView = view;
      phoneRow.replaceChildren(...[
        h('span', { class: `pair-dot${paired ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pair-text' }, text),
        paired && h('button', { class: 'btn ghost small pair-toggle', type: 'button', onclick: () => { state.showQr = !state.showQr; syncPairing(); } }),
        paired && h('button', { class: 'btn ghost small', type: 'button', onclick: newPhone }, 'New phone'),
      ].filter(Boolean)); // replaceChildren would print null as text
    } else {
      phoneRow.querySelector('.pair-text').textContent = text; // keeps focus on the buttons
    }
    const toggle = phoneRow.querySelector('.pair-toggle');
    if (toggle) toggle.textContent = state.showQr ? 'Hide QR' : 'Show QR';
    if (showQrBox) {
      const p = ensurePairing();
      const url = pairUrl(config.baseUrl || location.origin, p);
      if (qrFor === url + paired) return;
      qrFor = url + paired;
      qrBox.replaceChildren(
        h('div', { class: 'qr', html: qrSvg(url, { label: 'Scan to pair your phone' }) }),
        h('div', { class: 'qr-steps' },
          h('strong', {}, paired ? 'Pair again or add this phone' : 'Scan with your phone’s camera'),
          h('ol', {},
            h('li', {}, 'Open the camera on your phone and point it at this code.'),
            h('li', {}, 'Tap the link — MMBASAP opens. No app or account needed.'),
            h('li', {}, 'Keep that page open; messages from here pop up there.')),
          h('span', { class: 'hint', html: `${icon('lock')}<span>Message text is end-to-end encrypted — the key is only in this code.</span>` })));
    }
  }

  // ---------------------------------------------------- channels
  function chooseChannel(id) {
    const c = channels.find((x) => x.id === id);
    if (!c || !c.enabled) return;
    if (c.owner && !ownerSignedIn()) { openOwnerDialog(() => chooseChannel(id)); return; }
    state.channel = id;
    prefs.set('channel', id);
    syncChannel();
  }
  function syncChannel() {
    for (const [id, b] of channelBtns) b.setAttribute('aria-checked', id === state.channel ? 'true' : 'false');
    channelHelp.textContent = {
      whatsapp: 'Opens WhatsApp on your phone with everything filled in — you tap Send. Sent from your own number.',
      sms: 'Opens Messages on your phone with everything filled in — you tap Send. Files go as a download link.',
      'auto-sms': 'Sent automatically by the owner’s phone (SMS Gateway). Files go as a download link.',
    }[state.channel] || '';
    dryNote.hidden = !(state.channel === 'auto-sms' && dryRun);
    syncPairing();
    if (viaPhone()) pollRoom();
    preview();
    syncSend();
  }

  // ---------------------------------------------------- composing
  const uploading = () => state.files.some((f) => f.status === 'uploading');
  const doneFiles = () => state.files.filter((f) => f.status === 'done');

  function syncExpiry() {
    for (const b of expiryRow.children) b.setAttribute('aria-checked', b.dataset.days === String(state.expiresInDays) ? 'true' : 'false');
  }

  function preview() {
    const files = state.files.filter((f) => f.status !== 'error');
    const clean = cleanText(text.value);
    const hasContent = clean || files.length;
    const placeholderLink = `${config.baseUrl}/s/XXXXXXXXXX`;
    expiryField.hidden = !files.length;
    previewLabel.textContent = state.channel === 'whatsapp' ? 'Filled into WhatsApp' : state.channel === 'sms' ? 'Filled into Messages' : 'The SMS';
    if (!hasContent) {
      previewBody.textContent = '';
      previewBody.classList.add('empty');
      previewBody.dataset.placeholder = 'Your message will appear here exactly as it will be sent.';
      previewMeta.textContent = '';
      return;
    }
    previewBody.classList.remove('empty');
    if (state.channel === 'auto-sms') {
      const sms = composeSms({ text: clean, files, link: placeholderLink });
      previewBody.textContent = sms.body;
      const seg = segments(sms.body);
      previewMeta.textContent = `${seg.parts} SMS${seg.encoding === 'ucs2' ? ' (Unicode)' : ''}${sms.mode === 'link' ? ' · sent as a link' : ''}`;
    } else if (state.channel === 'sms') {
      const body = [clean, files.length ? placeholderLink : ''].filter(Boolean).join('\n');
      previewBody.textContent = body;
      const seg = segments(body);
      previewMeta.textContent = `${seg.parts} SMS${files.length ? ' · files as a link' : ''}`;
    } else {
      previewBody.textContent = clean || '(no text)';
      previewMeta.textContent = files.length ? `+ ${files.length} file${files.length > 1 ? 's' : ''}, shared from your phone` : '';
    }
  }

  function phoneCheck(showError) {
    const v = phone.value.trim();
    if (!v) { phoneHelp.textContent = ''; phoneHelp.className = 'help'; return null; }
    const n = normalizePhone(v);
    if (n.ok) {
      phoneHelp.textContent = `Sends to ${prettyNumber(n.e164)}`;
      phoneHelp.className = 'help ok';
      return n.e164;
    }
    phoneHelp.textContent = showError ? n.error : '';
    phoneHelp.className = showError ? 'help bad' : 'help';
    return null;
  }

  function syncSend() {
    const ready = (text.value.trim() || doneFiles().length) && phone.value.trim();
    sendBtn.disabled = state.sending || uploading() || !ready;
    const label = state.channel === 'auto-sms' ? (dryRun ? 'Send (dry run)' : 'Send SMS automatically') : 'Send to my phone';
    sendBtn.querySelector('span').textContent = state.sending ? 'Sending…' : uploading() ? 'Uploading…' : label;
  }

  // ---------------------------------------------------- files
  function renderFiles() {
    fileList.replaceChildren(...state.files.map((f) => {
      const pct = Math.round((f.progress || 0) * 100);
      const meta = f.status === 'uploading' ? `${pct}%` : f.status === 'error' ? f.error : formatBytes(f.size);
      const remove = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${f.name}`, html: icon('x'), onclick: () => removeFile(f) });
      const retry = f.status === 'error' && f.file
        ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Retry ${f.name}`, html: icon('retry'), onclick: () => upload(f) })
        : null;
      return h('li', { class: `file ${f.status}` },
        h('span', { class: 'file-icon', html: icon(f.status === 'error' ? 'warn' : 'file') }),
        h('span', { class: 'file-name', title: f.name }, f.name),
        h('span', { class: 'file-meta' }, meta),
        retry, remove,
        f.status === 'uploading' ? h('span', { class: 'file-bar', style: `--p:${pct}%` }) : null);
    }));
  }
  function removeFile(f) {
    f.xhr?.abort();
    state.files = state.files.filter((x) => x !== f);
    renderFiles(); preview(); syncSend();
  }
  /** Moves the progress bar of one row without rebuilding the list (so its buttons stay clickable). */
  function showProgress(f) {
    const i = state.files.indexOf(f);
    const row = fileList.children[i];
    if (!row) return;
    const pct = Math.round((f.progress || 0) * 100);
    row.querySelector('.file-meta').textContent = `${pct}%`;
    row.querySelector('.file-bar')?.style.setProperty('--p', `${pct}%`);
  }
  async function upload(f) {
    Object.assign(f, { status: 'uploading', progress: 0, error: '' });
    renderFiles(); syncSend();
    const p = ensurePairing();
    f.roomId = p.roomId;
    try {
      await registerRoom(p);
      const { res, body } = await api('/api/upload-url', { method: 'POST', json: { name: f.name, type: f.type, size: f.size, roomId: p.roomId } });
      if (!res.ok) throw new Error(body.error || 'Couldn’t start the upload');
      if (!state.files.includes(f)) return; // removed meanwhile
      await putFile(body.upload, f.file, (pr) => { f.progress = pr; showProgress(f); }, (xhr) => { f.xhr = xhr; });
      Object.assign(f, { fileId: body.fileId, status: 'done' });
    } catch (err) {
      if (err.aborted || !state.files.includes(f)) return;
      Object.assign(f, { status: 'error', error: err.message });
    } finally {
      f.xhr = null;
    }
    renderFiles(); preview(); syncSend();
  }
  function addFiles(list) {
    const max = limits.maxFiles || 5;
    const maxBytes = limits.maxFileBytes || 100 * 1024 * 1024;
    for (const file of list) {
      if (state.files.length >= max) { toast(`You can attach up to ${max} files.`, { tone: 'error' }); break; }
      if (file.size > maxBytes) { toast(`“${file.name}” is over ${formatBytes(maxBytes)}.`, { tone: 'error' }); continue; }
      if (!file.size) { toast(`“${file.name}” is empty.`, { tone: 'error' }); continue; }
      const f = { file, name: file.name || 'pasted-file', size: file.size, type: file.type };
      state.files.push(f);
      upload(f);
    }
    preview(); syncSend();
  }

  // ---------------------------------------------------- status
  let statusKey = '';
  function showStatus(line, sub, tone, iconName, extra) {
    const key = [line, sub, tone, extra].join('|');
    if (!statusBox.hidden && key === statusKey) return; // no repeated screen-reader announcements
    statusKey = key;
    statusBox.hidden = false;
    statusBox.className = `status ${tone}`;
    statusBox.replaceChildren(
      h('span', { class: 'status-icon', html: icon(iconName) }),
      h('div', { class: 'status-text' }, h('strong', {}, line), sub ? h('span', {}, sub) : null, extra ? h('span', { class: 'status-extra' }, extra) : null));
  }
  function showPhoneStatus(item) {
    const app = item.channel === 'whatsapp' ? 'WhatsApp' : 'Messages';
    const button = item.channel === 'whatsapp' ? 'Open WhatsApp chat' : 'Open Messages';
    const to = `To ${prettyNumber(item.to)}`;
    if (item.status === 'opened') return showStatus(`Opened in ${app} on your phone ✓`, `${to} · tap Send there if you haven’t yet`, 'ok', 'check');
    if (item.status === 'received') return showStatus('On your phone ✓', `${to} · tap “${button}” there, then Send`, 'ok', 'phone');
    if (item.status === 'sending') return showStatus('Sending to your phone…', to, 'busy', 'clock');
    if (!state.phoneSeenAt) return showStatus('Scan the QR code with your phone to receive it', to, 'busy', 'phone');
    const slow = Date.now() - Date.parse(item.createdAt) > SLOW_PHONE_MS;
    return showStatus(slow ? 'Still waiting — open MMBASAP on your phone' : 'Waiting for your phone…', to, 'busy', 'phone');
  }
  function showAutoStatus(share, extra = '') {
    const s = dryRun && share.status !== 'sending' && share.status !== 'failed'
      ? { text: 'Dry run — printed in the terminal, not sent to any phone', tone: 'busy', icon: 'warn' }
      : AUTO_STATUS[share.status] || AUTO_STATUS.queued;
    const waitedLong = share.status === 'queued' && Date.now() - new Date(share.createdAt).getTime() > SLOW_PHONE_MS;
    showStatus(waitedLong ? 'Still waiting — is the owner’s phone online with SMS Gateway running?' : s.text,
      share.status === 'failed' && share.error ? share.error : `To ${share.to}`, s.tone, s.icon, extra);
  }

  function trackPhone(item) {
    clearTimeout(state.pollTimer);
    state.current = { kind: 'phone', tracking: true, ...item };
    showPhoneStatus(state.current);
    pollRoom();
    const started = Date.now();
    const stop = () => { if (state.current?.id === item.id) state.current.tracking = false; };
    const tick = async () => {
      if (state.current?.id !== item.id || state.pairing?.roomId !== item.roomId) return stop();
      try {
        const { res, body } = await api(`/api/rooms/${item.roomId}/messages/${item.id}`);
        if (state.current?.id !== item.id || state.pairing?.roomId !== item.roomId) return stop();
        if (res.ok) {
          if (body.phoneSeenAt) setPhoneSeen(body.phoneSeenAt);
          if (body.message.status !== state.current.status) {
            state.current.status = body.message.status;
            updateLocalHistory(item.id, { status: body.message.status });
          }
          showPhoneStatus(state.current);
          if (body.message.status === 'opened') return stop();
        } else if (res.status === 404) {
          return stop();
        }
      } catch { /* keep trying */ }
      if (Date.now() - started < POLL_FOR_MS) state.pollTimer = setTimeout(tick, POLL_MS);
      else stop();
    };
    state.pollTimer = setTimeout(tick, POLL_MS);
  }

  function trackAuto(share) {
    clearTimeout(state.pollTimer);
    state.current = { kind: 'auto', id: share.id };
    showAutoStatus(share);
    if (share.status === 'delivered' || share.status === 'failed') return;
    const started = Date.now();
    const tick = async () => {
      if (state.current?.id !== share.id) return;
      try {
        const { res, body } = await api(`/api/shares/${share.id}/status`);
        if (res.ok && body.share) {
          showAutoStatus(body.share, body.checkError || '');
          const prev = serverItems.find((x) => x.id === body.share.id);
          if (!prev || prev.status !== body.share.status || prev.error !== body.share.error) upsertServerHistory(body.share);
          if (body.share.status === 'delivered' || body.share.status === 'failed') return;
        }
      } catch { /* keep trying */ }
      if (Date.now() - started < 3 * 60 * 1000) state.pollTimer = setTimeout(tick, POLL_MS);
    };
    state.pollTimer = setTimeout(tick, POLL_MS);
  }

  // ---------------------------------------------------- sending
  async function sendViaPhone(to, sentText, sentFiles) {
    const p = ensurePairing();
    const files = sentFiles.filter((f) => f.roomId === p.roomId).map((f) => ({ id: f.fileId, name: f.name, type: f.type || '', size: f.size }));
    if (!cleanText(sentText) && !files.length) throw new Error('Write something or attach a file first.');
    await registerRoom(p);
    let link = '';
    if (files.length) {
      const { res, body } = await api('/api/links', { method: 'POST', json: { roomId: p.roomId, files, expiresInDays: state.expiresInDays } });
      if (!res.ok) throw Object.assign(new Error(body.error || 'Couldn’t prepare the files.'), { code: body.code });
      link = body.link;
    }
    const id = randomId(10);
    const sealed = await sealJson(p.key, { v: 1, channel: state.channel, to, text: cleanText(sentText), files, link, sentAt: new Date().toISOString() }, messageAad(p.roomId, id));
    const item = { id, roomId: p.roomId, channel: state.channel, to, createdAt: new Date().toISOString(), status: 'sending' };
    showPhoneStatus(item);
    const { res, body } = await api(`/api/rooms/${p.roomId}/messages`, { method: 'POST', json: { id, ...sealed, fileIds: files.map((f) => f.id) } });
    if (!res.ok) throw Object.assign(new Error(body.error || 'Couldn’t send to your phone.'), { code: body.code });
    item.status = 'waiting';
    addLocalHistory({ ...item, preview: cleanText(sentText).slice(0, 90), files: files.map((f) => f.name) });
    if (!state.phoneSeenAt) { state.showQr = true; syncPairing(); }
    trackPhone(item);
    toast(state.phoneSeenAt ? 'Sent to your phone' : 'Saved — scan the QR to get it on your phone', { tone: 'ok' });
  }

  async function sendAuto(to, sentText, sentFiles) {
    const files = sentFiles.map((f) => ({ id: f.fileId, name: f.name, type: f.type, size: f.size }));
    showAutoStatus({ status: 'sending', to, createdAt: new Date().toISOString() });
    const { res, body } = await api('/api/send', { method: 'POST', json: { to, text: sentText, files, expiresInDays: state.expiresInDays } });
    if (body.share) { upsertServerHistory(body.share); trackAuto(body.share); }
    if (!res.ok) throw Object.assign(new Error(body.error || 'Couldn’t send.'), { code: body.code, shown: Boolean(body.share) });
    toast(dryRun ? 'Dry run: printed in the terminal, not sent' : `Handed to the owner’s phone for ${to}`, { tone: dryRun ? undefined : 'ok' });
  }

  async function doSend() {
    if (sendBtn.disabled) return;
    const to = phoneCheck(true);
    if (!to) { phone.focus(); return; }
    // Stop following the previous message, so its updates can't overwrite this one's result.
    clearTimeout(state.pollTimer);
    if (state.current) state.current.tracking = false;
    state.current = null;
    state.sending = true;
    syncSend();
    // What is being sent now; anything typed or attached meanwhile stays for the next message.
    const sentText = text.value;
    const sentFiles = doneFiles();
    try {
      if (viaPhone()) await sendViaPhone(to, sentText, sentFiles);
      else await sendAuto(to, sentText, sentFiles);
      prefs.set('lastTo', phone.value.trim());
      if (text.value === sentText) { text.value = ''; prefs.set('draft', ''); }
      state.files = state.files.filter((f) => !sentFiles.includes(f));
      renderFiles(); preview();
    } catch (err) {
      if (err.code === 'upload_expired' || err.code === 'upload_missing') {
        for (const f of sentFiles) Object.assign(f, { status: 'error', error: 'Expired — tap retry to upload again' });
        renderFiles(); preview();
      }
      toast(err.message, { tone: 'error', ms: 8000 });
      if (!err.shown) showStatus('Not sent', err.message, 'bad', 'warn');
    } finally {
      state.sending = false;
      syncSend();
    }
  }

  // ---------------------------------------------------- history
  let localItems = prefs.get('history', []);
  let historyKey = null;
  let serverItems = [];
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function addLocalHistory(item) {
    localItems = [item, ...localItems.filter((x) => x.id !== item.id)].slice(0, 20);
    prefs.set('history', localItems);
    renderHistory();
  }
  function updateLocalHistory(id, patch) {
    localItems = localItems.map((x) => (x.id === id ? { ...x, ...patch } : x));
    prefs.set('history', localItems);
    renderHistory();
  }
  /** After a reload, refresh the pills of recent phone sends that were still in flight. */
  async function recheckLocalHistory() {
    const day = Date.now() - 24 * 60 * 60 * 1000;
    for (const item of localItems) {
      if (item.status === 'opened' || item.status === 'expired' || !item.roomId) continue;
      if (Date.parse(item.createdAt) < day) {
        if (item.status === 'waiting' || item.status === 'sending' || item.status === 'received') updateLocalHistory(item.id, { status: 'expired' });
        continue;
      }
      try {
        const { res, body } = await api(`/api/rooms/${item.roomId}/messages/${item.id}`);
        if (res.ok) updateLocalHistory(item.id, { status: body.message.status });
        else if (res.status === 404) updateLocalHistory(item.id, { status: 'expired' });
      } catch { /* try next time */ }
    }
  }
  function upsertServerHistory(share) {
    serverItems = [share, ...serverItems.filter((s) => s.id !== share.id)].slice(0, 20);
    renderHistory();
  }
  async function loadServerHistory() {
    serverItems = [];
    if (ownerSignedIn()) {
      try {
        const { res, body } = await api('/api/history');
        if (res.ok) serverItems = body.shares || [];
      } catch { /* fine */ }
    }
    renderHistory();
  }
  function renderHistory() {
    const rows = [
      ...localItems.map((x) => ({ id: x.id, to: x.to, createdAt: x.createdAt, channel: x.channel, what: [x.preview, x.files?.length ? (x.files.length === 1 ? x.files[0] : `${x.files.length} files`) : ''].filter(Boolean).join(' · '), pill: PHONE_PILL[x.status] || PHONE_PILL.waiting })),
      ...serverItems.map((s) => {
        const st = AUTO_STATUS[s.status] || AUTO_STATUS.queued;
        const what = [s.text ? s.text.replace(/\s+/g, ' ').slice(0, 90) : '', s.files?.length ? (s.files.length === 1 ? s.files[0].name : `${s.files.length} files`) : ''].filter(Boolean).join(' · ');
        return { id: s.id, to: s.to, createdAt: s.createdAt, channel: 'auto-sms', what, pill: dryRun && s.status !== 'failed' ? ['busy', 'Dry run'] : [st.tone, s.status === 'queued' ? 'Waiting' : st.text] };
      }),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
    const key = rows.map((r) => `${r.id}|${r.pill.join('/')}`).join(',');
    if (key === historyKey) return; // nothing visible changed: keep the buttons (and focus) as they are
    historyKey = key;
    history.hidden = rows.length === 0;
    const label = { whatsapp: 'WhatsApp', sms: 'SMS', 'auto-sms': 'Auto SMS' };
    historyList.replaceChildren(...rows.map((r) => h('li', { class: 'history-item' },
      h('button', { class: 'history-to', type: 'button', title: 'Send to this number again', onclick: () => { phone.value = r.to; phoneCheck(false); syncSend(); phone.focus(); } }, r.to),
      h('span', { class: 'history-what' }, h('span', { class: 'history-ch' }, label[r.channel] || ''), r.what || '—'),
      h('span', { class: `pill ${r.pill[0]}` }, r.pill[1]),
      h('time', { datetime: r.createdAt }, when(r.createdAt)))));
    const numbers = [...new Set(rows.map((r) => r.to))].slice(0, 4);
    recentRow.replaceChildren(...numbers.map((n) => h('button', {
      class: 'mini-chip', type: 'button', onclick: () => { phone.value = n; phoneCheck(false); syncSend(); },
    }, n.replace(/^\+91/, ''))));
  }

  // ---------------------------------------------------- events
  text.addEventListener('input', () => { prefs.set('draft', text.value); preview(); syncSend(); });
  text.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    const pasted = [...(dt?.files || [])];
    if (!pasted.length) return;
    // Excel/Word/Sheets copy text *and* a picture of it: keep the text then. Real files get attached.
    const types = [...(dt.types || [])];
    const officeCopy = (types.includes('text/html') || types.includes('text/rtf')) && pasted.every((f) => f.type.startsWith('image/'));
    if (!officeCopy) { e.preventDefault(); addFiles(pasted); }
  });
  phone.addEventListener('input', () => { phoneCheck(false); syncSend(); });
  phone.addEventListener('blur', () => phoneCheck(true));
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  sendBtn.addEventListener('click', doSend);
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return; // the sign-in dialog handles its own keys
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRoom(); });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; dropMask.classList.add('on'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropMask.classList.remove('on'); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dropMask.classList.remove('on');
    addFiles([...e.dataTransfer.files]);
  });

  if (state.channel === 'auto-sms' && !ownerSignedIn()) state.channel = 'whatsapp';
  syncExpiry();
  syncChannel();
  phoneCheck(false);
  renderHistory();
  loadServerHistory();
  recheckLocalHistory();
  (text.value ? phone : text).focus();
}

// ------------------------------------------------------------------- boot
function blocker(message, detail) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('div', { class: 'auth-gate' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-logo', html: logoSvg() }), h('h1', {}, 'MMBASAP'), h('p', { class: 'auth-intro' }, message),
    detail ? h('div', { class: 'auth-missing' }, detail) : null,
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))));
}

async function start() {
  try {
    await loadConfig();
  } catch {
    blocker('Can’t reach the MMBASAP server. Check your connection and try again.');
    return;
  }
  const config = getConfig();
  if (config.setupMissing?.length) {
    blocker('This MMBASAP isn’t set up yet.', `Add these in Vercel and redeploy: ${config.setupMissing.join(', ')}.`);
    return;
  }
  if (!window.isSecureContext || !crypto.subtle) {
    blocker('MMBASAP needs a secure (https) address to encrypt messages for your phone.');
    return;
  }
  renderApp();
}

start();
