// What an SMS will look like — shared by the browser (live preview and part
// counter) and the server (the text it actually sends), so both always agree.
// Pure functions, no DOM, no Node APIs.
//
//   normalizePhone('98765 43210') → { ok: true, e164: '+919876543210' }
//   segments(text)                → { encoding, length, parts, perPart }
//   composeSms({ text, files, link }) → { mode: 'inline' | 'link', body }

/** Longest text we accept; anything that long goes out as a link anyway. */
export const MAX_TEXT = 10_000;
/** Text up to this many SMS parts is sent as-is so it can be copied straight from the SMS. */
export const MAX_INLINE_PARTS = 3;
const PREVIEW_CHARS = 120;

// GSM 03.38: the basic set costs one septet per character, the extension set two.
const GSM_BASIC = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€\f');

/** How many SMS parts a text needs. Unicode (emoji, Hindi, curly quotes…) switches the whole SMS to UCS-2. */
export function segments(text) {
  const s = String(text ?? '');
  let septets = 0;
  let gsm = true;
  for (const ch of s) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXT.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const parts = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'gsm7', length: septets, parts, perPart: parts > 1 ? 153 : 160 };
  }
  const units = s.length; // UTF-16 code units, which is what UCS-2 counts
  const parts = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'ucs2', length: units, parts, perPart: parts > 1 ? 67 : 70 };
}

/**
 * Indian numbers can be typed any common way (98765 43210, 098765-43210,
 * +91 98765 43210); anything else must be full international (+44…).
 */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Enter a phone number.' };
  const plus = s.startsWith('+');
  const digits = s.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return { ok: false, error: 'Use digits only, like 98765 43210 or +91 98765 43210.' };
  if (!plus && /^0?[6-9]\d{9}$/.test(digits)) return { ok: true, e164: `+91${digits.slice(-10)}` };
  if (/^91[6-9]\d{9}$/.test(digits)) return { ok: true, e164: `+${digits}` };
  if (plus && /^[1-9]\d{7,14}$/.test(digits)) return { ok: true, e164: `+${digits}` };
  return { ok: false, error: 'That doesn’t look like a mobile number. Indian numbers have 10 digits starting with 6–9.' };
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** Line endings normalised, outer blank space removed. */
export const cleanText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * The SMS body. Short text with no files goes inline; long text or any file
 * goes as a preview plus the share link (the link is always the last line, so
 * phones make it tappable).
 */
export function composeSms({ text = '', files = [], link }) {
  const clean = cleanText(text);
  if (!files.length && clean && segments(clean).parts <= MAX_INLINE_PARTS) return { mode: 'inline', body: clean };
  const lines = [];
  if (clean) lines.push(clip(oneLine(clean), PREVIEW_CHARS));
  if (files.length === 1) lines.push(`File: ${clip(oneLine(files[0].name || 'file'), 60)}`);
  else if (files.length > 1) lines.push(`${files.length} files`);
  lines.push(files.length ? `Open: ${link}` : `Read all: ${link}`);
  return { mode: 'link', body: lines.join('\n') };
}

export function formatBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}
