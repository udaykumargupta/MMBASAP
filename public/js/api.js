// Talking to the server: config, the owner's passcode sign-in, and fetch
// with the owner's session token. Pair-your-phone needs no sign-in; the
// token only unlocks Auto SMS. Any 401 on an owner call signs out.
import { h } from './ui.js';

const TOKEN_KEY = 'mmbasap_jwt';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
let config = { setupMissing: [], channels: [], limits: {}, owner: { available: false } };
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
/** True when the owner's Auto SMS is usable here: no sign-in needed, or a live session. */
export function ownerSignedIn() {
  if (!config.owner?.available) return false;
  if (!config.owner.signInRequired) return true;
  const c = token && claimsOf(token);
  return Boolean(c && c.exp * 1000 > Date.now());
}

/** fetch() for our API (adds the owner token when there is one). Returns { res, body }. */
export async function api(path, { method = 'GET', json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  if (res.status === 401 && token) signOut({ expired: true });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

export const onSignOut = (fn) => signOutListeners.add(fn);
export function signOut({ expired = false } = {}) {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  for (const fn of signOutListeners) fn({ expired });
}

/** The owner's passcode form. Calls onSignedIn() once the server accepts it. */
export function passcodeForm({ onSignedIn }) {
  const error = h('div', { class: 'auth-error', role: 'alert' });
  const input = h('input', {
    class: 'field', type: 'password', autocomplete: 'current-password', required: true,
    placeholder: 'Owner passcode', 'aria-label': 'Owner passcode',
  });
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  const form = h('form', { class: 'auth-form' }, input, button);
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
  return { el: h('div', { class: 'passcode' }, form, error), focus: () => input.focus() };
}
