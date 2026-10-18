// Talking to the server: config, the passcode gate, and an authenticated
// fetch. The session token lives in localStorage and goes out as a Bearer
// header; any 401 signs out and shows the passcode page again.
import { h, icon, logoSvg } from './ui.js';

const TOKEN_KEY = 'mmbasap_jwt';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
let config = { authRequired: false, setupMissing: [], channels: [], limits: {} };
const signOutListeners = new Set();

export async function loadConfig() {
  const res = await fetch('/api/public/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  config = await res.json();
  return config;
}
export const getConfig = () => config;

function claimsOf(t) {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
  } catch {
    return null;
  }
}
/** True when the app can be used: no passcode needed, or a live session token. */
export function signedIn() {
  if (!config.authRequired) return true;
  const c = token && claimsOf(token);
  return Boolean(c && c.exp * 1000 > Date.now());
}

/** fetch() for our API, with the session token. Returns { res, body }. */
export async function api(path, { method = 'GET', json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  if (res.status === 401 && config.authRequired) {
    signOut({ expired: true });
    throw new Error('Your session expired — enter the passcode again.');
  }
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

export const onSignOut = (fn) => signOutListeners.add(fn);
export function signOut({ expired = false } = {}) {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  for (const fn of signOutListeners) fn({ expired });
}

/** Full-screen passcode page. Calls onSignedIn() once the server accepts the passcode. */
export function renderGate(root, { onSignedIn, expired = false }) {
  const error = h('div', { class: 'auth-error', role: 'alert' }, expired ? 'Your session expired. Enter the passcode again.' : '');
  const input = h('input', {
    class: 'field', type: 'password', id: 'passcode', autocomplete: 'current-password', required: true,
    placeholder: 'Passcode', 'aria-label': 'Passcode',
  });
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  const form = h('form', { class: 'auth-form' }, input, button);
  const missing = config.setupMissing?.length
    ? h('div', { class: 'auth-missing' }, `This deployment isn’t set up yet. Add these environment variables and redeploy: ${config.setupMissing.join(', ')}.`)
    : null;
  root.replaceChildren(h('div', { class: 'auth-gate' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'auth-logo', html: logoSvg() }),
      h('h1', {}, 'MMBASAP'),
      h('p', { class: 'auth-intro' }, 'Send text, links and files from this browser to any phone.'),
      missing || form,
      error,
      h('p', { class: 'auth-foot', html: `${icon('lock')}<span>Only someone with the passcode can send from here.</span>` }))));
  if (missing) return;
  input.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: input.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw new Error(body.error || 'Couldn’t sign in. Try again.');
      token = body.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* still works for this tab */ }
      onSignedIn();
    } catch (err) {
      error.textContent = err.message;
      input.select();
    } finally {
      button.disabled = false;
    }
  });
}
