import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { sha256, randomToken, safeEqual } from './crypto.js';
import { HttpError, nowIso } from './util.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'acc_session';
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

let setupCode = null;

/** First run: a one-time code printed to the console, so nobody else on the network can claim the account. */
export function issueSetupCode() {
  setupCode = userCount() === 0 ? randomToken(6) : null;
  return setupCode;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function startSession(req, res, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_DAYS * 86_400_000,
  );
  setCookie(req, res, token, SESSION_DAYS * 86_400);
}

export function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    )
    .get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = user;
  next();
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 10) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes, then try again.');
  recent.push(now);
  attempts.set(ip, recent);
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[\w.@-]{3,64}$/.test(username.trim()))
    throw new HttpError(400, 'Username must be 3–64 letters, numbers, or . _ @ -');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200)
    throw new HttpError(400, 'Password must be at least 10 characters.');
}

export function authRoutes(app) {
  app.get('/api/auth/status', (req, res) => {
    res.json({ setupRequired: userCount() === 0, user: currentUser(req) });
  });

  app.post('/api/auth/setup', async (req, res) => {
    if (userCount() > 0) throw new HttpError(409, 'An account already exists. Sign in instead.');
    const { username, password, setupCode: code } = req.body ?? {};
    if (!setupCode || !safeEqual(code ?? '', setupCode))
      throw new HttpError(403, 'That setup code is wrong. Copy it from the server console.');
    validateCredentials(username, password);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users(username, pass_hash, created_at) VALUES(?, ?, ?)')
      .run(username.trim(), await hashPassword(password), nowIso());
    setupCode = null;
    startSession(req, res, Number(lastInsertRowid));
    res.json({ ok: true });
  });

  app.post('/api/auth/login', async (req, res) => {
    throttle(req.ip);
    const { username, password } = req.body ?? {};
    const row =
      typeof username === 'string'
        ? db.prepare('SELECT id, pass_hash FROM users WHERE username = ?').get(username.trim())
        : null;
    const ok = row && typeof password === 'string' && (await verifyPassword(password, row.pass_hash));
    if (!ok) throw new HttpError(401, 'Username or password is incorrect.');
    startSession(req, res, row.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });
}
