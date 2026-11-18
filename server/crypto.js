import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

let key;

function masterKey() {
  if (key) return key;
  const env = process.env.ACC_MASTER_KEY;
  if (env) {
    key = Buffer.from(env, /^[0-9a-f]{64}$/i.test(env) ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error('ACC_MASTER_KEY must be 32 bytes, as 64 hex characters or base64.');
    return key;
  }
  const file = path.join(DATA_DIR, 'master.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    console.warn(
      `[acc] Created an encryption key at ${file}. Back it up: stored API keys cannot be decrypted without it. ` +
        'To keep it out of the data folder, set ACC_MASTER_KEY instead.',
    );
  }
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  return key;
}

/** AES-256-GCM. The integration id is bound in as associated data, so a ciphertext can't be moved to another row. */
export function encrypt(plain, aad = '') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob, aad = '') {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const secretHint = (s) => (s.length > 12 ? `${s.slice(0, 7)}…${s.slice(-4)}` : '••••');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(sha256(String(a)));
  const y = Buffer.from(sha256(String(b)));
  return crypto.timingSafeEqual(x, y);
}
