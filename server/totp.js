/**
 * Two-step verification with an authenticator app: time-based one-time codes (RFC 6238: HMAC-SHA1, 6 digits,
 * 30-second steps), the same codes Google Authenticator, Microsoft Authenticator, 1Password and others show.
 * Recovery codes let you in once each if you lose the phone; only their hashes are stored.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { sha256 } from './crypto.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-svg');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, as base32. */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const n = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Checks a code, allowing one step either side for clock drift. Returns the step it matched, or null.
 * `after` is the last step already used, so a code can't be used twice.
 */
export function verifyCode(secret, code, { now = Date.now(), after = -1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s, s - 1, s + 1]) {
    if (step <= after) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

/** The link authenticator apps read from the QR code. */
export const otpauthUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent(`AI Command Center:${account}`)}?secret=${secret}&issuer=${encodeURIComponent('AI Command Center')}&algorithm=SHA1&digits=6&period=30`;

/** The QR code as an SVG element, drawn on this computer (the secret never goes to a QR service). */
export function qrSvg(text) {
  const svg = new QRCode({ content: text, padding: 2, width: 200, height: 200, ecl: 'M', join: true, color: '#000000', background: '#ffffff', container: 'svg-viewbox' }).svg();
  return svg.replace(/^<\?xml[^>]*>\s*/, '');
}

/** Ten recovery codes like 7KQ4-M2XP. Returns the codes to show once and the hashes to keep. */
export function newRecoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(normalizeRecovery(c))) };
}
export const normalizeRecovery = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
