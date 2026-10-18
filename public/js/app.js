// MMBASAP's one page: two cards. "What to send" (text, links, files) and
// "Deliver to" (channel + phone number), a live preview of the exact SMS, and
// the delivery status after sending. Recent sends sit underneath.
import { h, icon, logoSvg, toast } from './ui.js';
import { api, getConfig, loadConfig, onSignOut, renderGate, signedIn, signOut } from './api.js';
import { composeSms, formatBytes, normalizePhone, segments, MAX_TEXT } from './sms.js';

const root = document.getElementById('app');
const POLL_MS = 2500;
const POLL_FOR_MS = 3 * 60 * 1000;
const SLOW_PHONE_MS = 30 * 1000;

const STATUS = {
  sending: { text: 'Sending…', tone: 'busy', icon: 'clock' },
  queued: { text: 'Waiting for your phone to send it', tone: 'busy', icon: 'phone' },
  sent: { text: 'Sent from your phone', tone: 'ok', icon: 'check' },
  delivered: { text: 'Delivered', tone: 'ok', icon: 'check' },
  failed: { text: 'Not sent', tone: 'bad', icon: 'warn' },
};

// ------------------------------------------------------------------ theme
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f4f5f8' : '#0e1014';
  try { localStorage.setItem('mmbasap.theme', t); } catch { /* ignore */ }
}
const theme = () => document.documentElement.dataset.theme;

// ------------------------------------------------------------------- prefs
const prefs = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`mmbasap.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`mmbasap.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ----------------------------------------------------------------- uploads
/** PUT with progress (fetch can't report upload progress). */
function putFile(target, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method || 'PUT', target.url);
    for (const [k, v] of Object.entries(target.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? 'File too large' : `Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload blocked or network down'));
    xhr.send(file);
  });
}

// --------------------------------------------------------------------- app
function renderApp() {
  const config = getConfig();
  const limits = config.limits || {};
  const state = {
    files: [], // { key, file, name, size, type, fileId, progress, status: 'uploading'|'done'|'error', error }
    channel: 'sms',
    expiresInDays: prefs.get('expiry', 7),
    sending: false,
    current: null, // the share being tracked
    pollTimer: null,
  };

  // --------------------------------------------------------- header
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Switch theme', title: 'Switch theme' });
  const syncThemeBtn = () => { themeBtn.innerHTML = icon(theme() === 'light' ? 'moon' : 'sun'); };
  themeBtn.addEventListener('click', () => { setTheme(theme() === 'light' ? 'dark' : 'light'); syncThemeBtn(); });
  syncThemeBtn();
  const outBtn = config.authRequired
    ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Lock', title: 'Lock (sign out)', html: icon('logout'), onclick: () => signOut() })
    : null;
  const header = h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: logoSvg() }), 'MMBASAP'),
    h('div', { class: 'topbar-actions' }, themeBtn, outBtn)));

  // ---------------------------------------------------- card 1: what
  const text = h('textarea', {
    class: 'field textarea', id: 'text', rows: '9', maxlength: String(MAX_TEXT),
    placeholder: 'Paste a link, type a note, or drop files here…', 'aria-label': 'What to send',
  });
  text.value = prefs.get('draft', '');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, id: 'file-input' });
  const attachBtn = h('button', { class: 'btn ghost', type: 'button', html: `${icon('clip')}<span>Attach files</span>`, onclick: () => fileInput.click() });
  const fileHint = h('span', { class: 'hint' }, `Up to ${limits.maxFiles || 5} files, ${formatBytes(limits.maxFileBytes || 25 * 1024 * 1024)} each`);
  const fileList = h('ul', { class: 'file-list', 'aria-label': 'Attached files' });
  const sendCard = h('section', { class: 'card', 'aria-labelledby': 'what-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'what-title' }, h('span', { class: 'step' }, '1'), 'What to send'),
      h('span', { class: 'from' }, 'From this browser')),
    text,
    h('div', { class: 'attach-row' }, attachBtn, fileHint, fileInput),
    fileList);

  // ---------------------------------------------------- card 2: where
  const channelRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Deliver by' },
    (config.channels || []).map((c) => h('button', {
      class: 'chip', type: 'button', role: 'radio', disabled: !c.enabled,
      'aria-checked': c.id === state.channel ? 'true' : 'false', title: c.enabled ? '' : `${c.label} is coming soon`,
    }, c.label, c.note ? h('span', { class: 'chip-note' }, c.note) : null)));
  const phone = h('input', {
    class: 'field', id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
    placeholder: '98765 43210', 'aria-describedby': 'phone-help',
  });
  phone.value = prefs.get('lastTo', '');
  const phoneHelp = h('div', { class: 'help', id: 'phone-help' });
  const recentRow = h('div', { class: 'recent', 'aria-label': 'Recent numbers' });
  const expiryRow = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Link works for' },
    (limits.expiryDays || [1, 7]).map((d) => h('button', {
      type: 'button', role: 'radio', 'data-days': String(d), 'aria-checked': d === state.expiresInDays ? 'true' : 'false',
      onclick: () => { state.expiresInDays = d; prefs.set('expiry', d); syncExpiry(); },
    }, d === 1 ? '1 day' : `${d} days`)));
  const expiryField = h('div', { class: 'field-group' }, h('span', { class: 'label' }, 'Link works for'), expiryRow);
  const previewBody = h('pre', { class: 'preview-body', 'aria-live': 'polite' });
  const previewMeta = h('div', { class: 'preview-meta' });
  const dryRun = (config.channels || []).find((c) => c.id === 'sms')?.provider === 'console';
  const sendLabel = dryRun ? 'Send (dry run)' : 'Send SMS';
  const sendBtn = h('button', { class: 'btn primary send', type: 'button', html: `${icon('send')}<span>${sendLabel}</span>` });
  const dryNote = dryRun
    ? h('div', { class: 'dry-run', role: 'note', html: `${icon('warn')}<span><strong>Dry run — nothing reaches a phone.</strong> Messages are only printed in the terminal running MMBASAP. Add your SMS Gateway login (SMSGATE_USER, SMSGATE_PASS) to .env and restart to send for real.</span>` })
    : null;
  const statusBox = h('div', { class: 'status', hidden: true, role: 'status' });
  const deliverCard = h('section', { class: 'card', 'aria-labelledby': 'where-title' },
    h('div', { class: 'card-head' }, h('h2', { id: 'where-title' }, h('span', { class: 'step' }, '2'), 'Deliver to')),
    dryNote,
    channelRow,
    h('div', { class: 'field-group' }, h('label', { class: 'label', for: 'phone' }, 'Phone number'), phone, phoneHelp, recentRow),
    expiryField,
    h('div', { class: 'preview' }, h('div', { class: 'preview-head' }, h('span', { class: 'label' }, 'The SMS'), previewMeta), previewBody),
    sendBtn,
    h('div', { class: 'kbd-hint' }, navigator.platform?.includes('Mac') ? '⌘ + Enter to send' : 'Ctrl + Enter to send'),
    statusBox);

  // ---------------------------------------------------- history
  const historyList = h('ul', { class: 'history-list' });
  const history = h('section', { class: 'history', 'aria-labelledby': 'history-title', hidden: true },
    h('h2', { id: 'history-title' }, 'Recent'), historyList);

  const dropMask = h('div', { class: 'drop-mask', 'aria-hidden': 'true' }, h('div', {}, 'Drop to attach'));
  root.replaceChildren(header, h('main', { class: 'main' },
    h('div', { class: 'intro' }, h('h1', {}, 'Send to any phone'), h('p', {}, 'Type or paste here, attach files, and it arrives as an SMS from your phone.')),
    h('div', { class: 'cards' }, sendCard, deliverCard),
    history), dropMask);
  root.removeAttribute('aria-busy');

  // ---------------------------------------------------- behaviour
  const uploading = () => state.files.some((f) => f.status === 'uploading');

  function syncExpiry() {
    for (const b of expiryRow.children) b.setAttribute('aria-checked', b.dataset.days === String(state.expiresInDays) ? 'true' : 'false');
  }

  function preview() {
    const link = `${config.baseUrl}/s/XXXXXXXXXX`;
    const files = state.files.filter((f) => f.status !== 'error');
    const sms = composeSms({ text: text.value, files, link });
    const hasContent = text.value.trim() || files.length;
    expiryField.hidden = !hasContent || sms.mode !== 'link';
    if (!hasContent) {
      previewBody.textContent = '';
      previewBody.classList.add('empty');
      previewBody.dataset.placeholder = 'Your message will appear here exactly as it will be sent.';
      previewMeta.textContent = '';
      return;
    }
    previewBody.classList.remove('empty');
    previewBody.textContent = sms.body;
    const seg = segments(sms.body);
    const note = sms.mode === 'link' ? (files.length ? ' · files go as a link' : ' · long text goes as a link') : '';
    previewMeta.textContent = `${seg.parts} SMS${seg.encoding === 'ucs2' ? ' (Unicode)' : ''}${note}`;
  }

  function phoneCheck(showError) {
    const v = phone.value.trim();
    if (!v) { phoneHelp.textContent = ''; phoneHelp.className = 'help'; return null; }
    const n = normalizePhone(v);
    if (n.ok) {
      phoneHelp.textContent = `Sends to ${n.e164.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2')}`;
      phoneHelp.className = 'help ok';
      return n.e164;
    }
    phoneHelp.textContent = showError ? n.error : '';
    phoneHelp.className = showError ? 'help bad' : 'help';
    return null;
  }

  function syncSend() {
    const ready = (text.value.trim() || state.files.some((f) => f.status === 'done')) && phone.value.trim();
    sendBtn.disabled = state.sending || uploading() || !ready;
    sendBtn.querySelector('span').textContent = state.sending ? 'Sending…' : uploading() ? 'Uploading…' : sendLabel;
  }

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
    state.files = state.files.filter((x) => x !== f);
    renderFiles(); preview(); syncSend();
  }

  async function upload(f) {
    Object.assign(f, { status: 'uploading', progress: 0, error: '' });
    renderFiles(); syncSend();
    try {
      const { res, body } = await api('/api/upload-url', { method: 'POST', json: { name: f.name, type: f.type, size: f.size } });
      if (!res.ok) throw new Error(body.error || 'Couldn’t start the upload');
      await putFile(body.upload, f.file, (p) => { f.progress = p; renderFiles(); });
      Object.assign(f, { fileId: body.fileId, status: 'done' });
    } catch (err) {
      Object.assign(f, { status: 'error', error: err.message });
    }
    renderFiles(); preview(); syncSend();
  }

  function addFiles(list) {
    const max = limits.maxFiles || 5;
    const maxBytes = limits.maxFileBytes || 25 * 1024 * 1024;
    for (const file of list) {
      if (state.files.length >= max) { toast(`You can attach up to ${max} files.`, { tone: 'error' }); break; }
      if (file.size > maxBytes) { toast(`“${file.name}” is over ${formatBytes(maxBytes)}.`, { tone: 'error' }); continue; }
      if (!file.size) { toast(`“${file.name}” is empty.`, { tone: 'error' }); continue; }
      const f = { key: crypto.randomUUID?.() || String(Math.random()), file, name: file.name || 'pasted-file', size: file.size, type: file.type };
      state.files.push(f);
      upload(f);
    }
    preview(); syncSend();
  }

  function showStatus(share, extra = '') {
    const s = dryRun && share.status !== 'sending' && share.status !== 'failed'
      ? { text: 'Dry run — printed in the terminal, not sent to any phone', tone: 'busy', icon: 'warn' }
      : STATUS[share.status] || STATUS.queued;
    const waitedLong = share.status === 'queued' && Date.now() - new Date(share.createdAt).getTime() > SLOW_PHONE_MS;
    const line = waitedLong ? 'Still waiting — is your phone online with the SMS Gateway app running?' : s.text;
    statusBox.hidden = false;
    statusBox.className = `status ${s.tone}`;
    statusBox.replaceChildren(
      h('span', { class: 'status-icon', html: icon(s.icon) }),
      h('div', { class: 'status-text' },
        h('strong', {}, line),
        h('span', {}, share.status === 'failed' && share.error ? share.error : `To ${share.to}${share.mode === 'link' ? ' · ' : ''}`,
          share.mode === 'link' && share.status !== 'failed' ? h('a', { href: share.link, target: '_blank', rel: 'noopener' }, 'open the share page') : null),
        extra ? h('span', { class: 'status-extra' }, extra) : null));
  }

  function track(share) {
    clearTimeout(state.pollTimer);
    state.current = share;
    showStatus(share);
    if (share.status === 'delivered' || share.status === 'failed') return;
    const started = Date.now();
    const tick = async () => {
      if (state.current?.id !== share.id) return;
      try {
        const { res, body } = await api(`/api/shares/${share.id}/status`);
        if (res.ok && body.share) {
          state.current = body.share;
          showStatus(body.share, body.checkError || '');
          updateHistoryItem(body.share);
          if (body.share.status === 'delivered' || body.share.status === 'failed') return;
        }
      } catch { /* keep trying */ }
      if (Date.now() - started < POLL_FOR_MS) state.pollTimer = setTimeout(tick, POLL_MS);
      else showStatus(state.current, 'No delivery report yet — operators sometimes don’t send one.');
    };
    state.pollTimer = setTimeout(tick, POLL_MS);
  }

  async function doSend() {
    if (sendBtn.disabled) return;
    const to = phoneCheck(true);
    if (!to) { phone.focus(); return; }
    state.sending = true;
    syncSend();
    showStatus({ status: 'sending', to, createdAt: new Date().toISOString() });
    try {
      const files = state.files.filter((f) => f.status === 'done').map((f) => ({ id: f.fileId, name: f.name, type: f.type, size: f.size }));
      const { res, body } = await api('/api/send', {
        method: 'POST', json: { channel: state.channel, to, text: text.value, files, expiresInDays: state.expiresInDays },
      });
      if (body.share) { addHistory(body.share); track(body.share); }
      if (!res.ok) {
        if (!body.share) statusBox.hidden = true;
        toast(body.error || 'Couldn’t send.', { tone: 'error', ms: 8000 });
        return;
      }
      prefs.set('lastTo', phone.value.trim());
      prefs.set('draft', '');
      text.value = '';
      state.files = [];
      renderFiles(); preview();
      toast(dryRun ? 'Dry run: printed in the terminal, not sent' : `Handed to your phone for ${to}`, { tone: dryRun ? undefined : 'ok' });
    } catch (err) {
      statusBox.hidden = true;
      toast(err.message, { tone: 'error' });
    } finally {
      state.sending = false;
      syncSend();
    }
  }

  // ---------------------------------------------------- history
  let historyItems = [];
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function renderHistory() {
    history.hidden = historyItems.length === 0;
    historyList.replaceChildren(...historyItems.map((s) => {
      const st = STATUS[s.status] || STATUS.queued;
      const what = s.text ? s.text.replace(/\s+/g, ' ').slice(0, 90) : '';
      const filesNote = s.files.length ? `${s.files.length === 1 ? s.files[0].name : `${s.files.length} files`}` : '';
      return h('li', { class: 'history-item' },
        h('button', { class: 'history-to', type: 'button', title: 'Send to this number again', onclick: () => { phone.value = s.to; phoneCheck(false); syncSend(); phone.focus(); } }, s.to),
        h('span', { class: 'history-what' }, [what, filesNote].filter(Boolean).join(' · ') || '—'),
        h('span', { class: `pill ${dryRun ? 'busy' : st.tone}` }, dryRun && s.status !== 'failed' ? 'Dry run' : s.status === 'queued' ? 'Waiting' : s.status === 'sending' ? 'Sending' : st.text),
        h('time', { datetime: s.createdAt }, when(s.createdAt)));
    }));
    const numbers = [...new Set(historyItems.map((s) => s.to))].slice(0, 4);
    recentRow.replaceChildren(...numbers.map((n) => h('button', {
      class: 'mini-chip', type: 'button', onclick: () => { phone.value = n; phoneCheck(false); syncSend(); },
    }, n.replace(/^\+91/, ''))));
  }
  function addHistory(share) { historyItems = [share, ...historyItems.filter((s) => s.id !== share.id)].slice(0, 20); renderHistory(); }
  function updateHistoryItem(share) { historyItems = historyItems.map((s) => (s.id === share.id ? share : s)); renderHistory(); }
  api('/api/history').then(({ res, body }) => { if (res.ok) { historyItems = body.shares || []; renderHistory(); } }).catch(() => {});

  // ---------------------------------------------------- events
  text.addEventListener('input', () => { prefs.set('draft', text.value); preview(); syncSend(); });
  text.addEventListener('paste', (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  });
  phone.addEventListener('input', () => { phoneCheck(false); syncSend(); });
  phone.addEventListener('blur', () => phoneCheck(true));
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  sendBtn.addEventListener('click', doSend);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  });
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

  phoneCheck(false);
  preview();
  syncSend();
  (text.value ? phone : text).focus();
}

// ------------------------------------------------------------------- boot
function blocker(message) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('div', { class: 'auth-gate' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-logo', html: logoSvg() }), h('h1', {}, 'MMBASAP'), h('p', { class: 'auth-intro' }, message),
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))));
}

function showGate(expired = false) {
  root.removeAttribute('aria-busy');
  renderGate(root, { expired, onSignedIn: renderApp });
}

async function start() {
  try {
    await loadConfig();
  } catch {
    blocker('Can’t reach the MMBASAP server. Check your connection and try again.');
    return;
  }
  onSignOut(({ expired }) => showGate(expired));
  if (getConfig().setupMissing?.length || !signedIn()) showGate();
  else renderApp();
}

start();
