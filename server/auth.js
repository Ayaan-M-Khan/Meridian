/**
 * Your account: sign-in with a password (and two-step verification if you turn it on) or with a linked Google
 * account, sessions, and the security settings.
 *
 * - Passwords are stored as salted scrypt hashes. New passwords need 12+ characters and can't be a common one.
 * - Sign-in takes the same time whether or not the username exists, so usernames can't be probed.
 * - Ten tries per address per 15 minutes; twenty wrong passwords lock the account for 15 minutes from everywhere.
 * - Session cookies are HttpOnly, SameSite=Strict, and Secure over HTTPS. Without "keep me signed in", a session
 *   ends when the app closes or after 12 hours without use; with it, after 30 days.
 * - Each new sign-in raises a "New sign-in" alert, and you can see and end your sessions.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, notify } from './db.js';
import { sha256, randomToken, safeEqual, encrypt, decrypt } from './crypto.js';
import { HttpError, nowIso } from './util.js';
import { APP_VERSION } from './version.js';
import { newRecoveryCodes, newSecret, normalizeRecovery, otpauthUri, qrSvg, verifyCode } from './totp.js';
import {
  cancelGoogleFlow, callbackPage, finishGoogleFlow, googleStatus, pollGoogleFlow, removeGoogleClient, saveGoogleClient, startGoogleFlow,
} from './google-auth.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'acc_session';
const LONG_DAYS = 30;
const SHORT_HOURS = 12;
const TOTP_AAD = 'totp-secret';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Checked against when the username doesn't exist, so a wrong username takes as long as a wrong password.
let dummyHash = null;
const dummy = async () => (dummyHash ??= await hashPassword(randomToken(12)));

export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

let setupCode = null;

/** First run: a one-time code printed to the console, so nobody else on the network can claim the account. */
export function issueSetupCode() {
  setupCode = userCount() === 0 ? randomToken(6) : null;
  return setupCode;
}

// ── Passwords ────────────────────────────────────────────────────────────────────────────────────────────────────
const COMMON = new Set(('password password1 password123 passw0rd 123456789012 1234567890 12345678910 qwertyuiop qwerty123456 letmeinplease '
  + 'iloveyou123 administrator welcome123 trustno1trustno1 abc123abc123 football123 baseball123 monkey123456 dragon123456 sunshine123 '
  + 'princess123 superman123 starwars123 whatever123 changeme123 default12345 aicommandcenter commandcenter').split(' '));

/** Rules for a new password. Returns null when it's fine, or the reason it isn't. */
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)) return 'That password is too common. Pick something only you would use.';
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return 'Don’t include your username in the password.';
  if (new Set(password).size < 6) return 'Use a wider mix of characters.';
  return null;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[\w.@-]{3,64}$/.test(username.trim())) throw new HttpError(400, 'Username must be 3–64 letters, numbers, or . _ @ -');
}

// ── Cookies and sessions ─────────────────────────────────────────────────────────────────────────────────────────
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* a malformed cookie is ignored */
      }
    }
  }
  return out;
}

function setCookie(req, res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** A short, readable description of where a session is, from its browser's user agent. */
export function deviceOf(ua = '') {
  const s = String(ua ?? '');
  if (!s) return 'Unknown device (signed in before 1.0)';
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : 'another system';
  if (/Electron\//.test(s) || /AI ?Command ?Center/i.test(s)) return `Desktop app on ${os}`;
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  return `${browser} on ${os}`;
}

export function startSession(req, res, userId, { method = 'password', remember = false } = {}) {
  const token = randomToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen, user_agent, method, persistent) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
    sha256(token), userId, now + (remember ? LONG_DAYS * 86_400_000 : SHORT_HOURS * 3_600_000), now, now, String(req.get('user-agent') ?? '').slice(0, 300), method, remember ? 1 : 0,
  );
  // Without "keep me signed in", the cookie lasts until the app or browser closes.
  setCookie(req, res, token, remember ? LONG_DAYS * 86_400 : null);
  const where = deviceOf(req.get('user-agent'));
  notify({ kind: 'security', severity: 'info', title: 'New sign-in', body: `${method === 'google' ? 'With Google' : method === 'password+2fa' ? 'With your password and a verification code' : 'With your password'}, from ${where}. If this wasn’t you, change your password and sign out other sessions in Sign-in & security.`, dedupe: `signin:${sha256(token).slice(0, 12)}` });
}

const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];

export function currentUser(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT u.id, u.username, s.expires_at, s.last_seen, s.persistent, s.method, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hash);
  const now = Date.now();
  if (!row || row.expires_at < now) return null;
  // Short sessions stay alive while you use them; record use at most once a minute.
  if (!row.last_seen || now - row.last_seen > 60_000) {
    const expires = row.persistent ? row.expires_at : now + SHORT_HOURS * 3_600_000;
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now, expires, hash);
  }
  return { id: row.id, username: row.username, session: hash, method: row.method ?? 'password', started: row.created_at ?? 0 };
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

// ── Throttling ───────────────────────────────────────────────────────────────────────────────────────────────────
const attempts = new Map(); // ip -> times
const failures = new Map(); // user id -> times of wrong passwords or codes
const WINDOW = 15 * 60_000;
function throttle(key, max = 10) {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW);
  if (recent.length >= max) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes, then try again.');
  recent.push(now);
  attempts.set(key, recent);
}
function lockedOut(userId) {
  const now = Date.now();
  const recent = (failures.get(userId) ?? []).filter((t) => now - t < WINDOW);
  failures.set(userId, recent);
  return recent.length >= 20;
}
const failed = (userId) => userId && failures.set(userId, [...(failures.get(userId) ?? []), Date.now()]);
export const resetThrottleForTests = () => {
  attempts.clear();
  failures.clear();
};

// ── Two-step verification ────────────────────────────────────────────────────────────────────────────────────────
const challenges = new Map(); // challenge token hash -> { userId, remember, created, tries }
const pendingTotp = new Map(); // user id -> { secret, created }

/** A verification code or an unused recovery code. Recovery codes work once. */
function checkSecondFactor(user, code) {
  const secret = decrypt(user.totp_secret_enc, `${TOTP_AAD}:${user.id}`);
  const step = verifyCode(secret, code, { after: user.totp_last_step ?? -1 });
  if (step != null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return 'code';
  }
  const hashes = JSON.parse(user.recovery_hashes ?? '[]');
  const h = sha256(normalizeRecovery(code));
  const i = normalizeRecovery(code).length === 8 ? hashes.indexOf(h) : -1;
  if (i >= 0) {
    hashes.splice(i, 1);
    db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
    notify({ kind: 'security', severity: 'warn', title: 'A recovery code was used', body: `${hashes.length} recovery code${hashes.length === 1 ? '' : 's'} left. Make new ones in Sign-in & security if you’re running low.`, dedupe: `recovery:${h.slice(0, 12)}` });
    return 'recovery';
  }
  return null;
}

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

async function requirePassword(user, password) {
  if (typeof password !== 'string' || !(await verifyPassword(password, user.pass_hash))) {
    failed(user.id);
    throw new HttpError(403, 'That password isn’t right.');
  }
}

// ── Public routes: status, setup, sign-in, Google ────────────────────────────────────────────────────────────────
export function authRoutes(app) {
  app.get('/api/auth/status', (req, res) => {
    const g = googleStatus();
    res.json({ setupRequired: userCount() === 0, user: currentUser(req) ? { username: currentUser(req).username } : null, google: g.configured && g.linked, version: APP_VERSION });
  });

  app.post('/api/auth/setup', async (req, res) => {
    if (userCount() > 0) throw new HttpError(409, 'An account already exists. Sign in instead.');
    throttle(`setup:${req.ip}`);
    const { username, password, setupCode: code, remember } = req.body ?? {};
    if (!setupCode || !safeEqual(code ?? '', setupCode)) throw new HttpError(403, 'That setup code is wrong. Copy it from the server console.');
    validateUsername(username);
    const problem = passwordProblem(password, username.trim());
    if (problem) throw new HttpError(400, problem);
    const { lastInsertRowid } = db.prepare('INSERT INTO users(username, pass_hash, created_at, password_changed_at) VALUES(?, ?, ?, ?)').run(username.trim(), await hashPassword(password), nowIso(), nowIso());
    setupCode = null;
    startSession(req, res, Number(lastInsertRowid), { remember: Boolean(remember) });
    res.json({ ok: true });
  });

  app.post('/api/auth/login', async (req, res) => {
    throttle(req.ip);
    const { username, password, remember } = req.body ?? {};
    const row = typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) : null;
    if (row && lockedOut(row.id)) throw new HttpError(429, 'This account is locked for 15 minutes after too many wrong passwords.');
    const ok = typeof password === 'string' && (await verifyPassword(password, row?.pass_hash ?? (await dummy()))) && Boolean(row);
    if (!ok) {
      failed(row?.id);
      throw new HttpError(401, 'Username or password is incorrect.');
    }
    if (row.totp_secret_enc) {
      const token = randomToken();
      for (const [k, c] of challenges) if (Date.now() - c.created > 5 * 60_000) challenges.delete(k);
      challenges.set(sha256(token), { userId: row.id, remember: Boolean(remember), created: Date.now(), tries: 0 });
      return res.json({ ok: true, twoFactor: true, challenge: token });
    }
    startSession(req, res, row.id, { remember: Boolean(remember) });
    res.json({ ok: true });
  });

  app.post('/api/auth/login/verify', (req, res) => {
    throttle(req.ip);
    const { challenge, code } = req.body ?? {};
    const key = sha256(String(challenge ?? ''));
    const c = challenges.get(key);
    if (!c || Date.now() - c.created > 5 * 60_000) {
      challenges.delete(key);
      throw new HttpError(401, 'That took too long. Sign in again.');
    }
    const user = userRow(c.userId);
    if (!user || lockedOut(user.id)) throw new HttpError(429, 'This account is locked for 15 minutes after too many wrong codes.');
    const used = checkSecondFactor(user, code);
    if (!used) {
      failed(user.id);
      c.tries += 1;
      if (c.tries >= 5) challenges.delete(key);
      throw new HttpError(401, c.tries >= 5 ? 'Too many wrong codes. Sign in again.' : 'That code isn’t right. Use the newest code from your authenticator app, or a recovery code.');
    }
    challenges.delete(key);
    startSession(req, res, user.id, { method: 'password+2fa', remember: c.remember });
    res.json({ ok: true, recovery: used === 'recovery' });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = tokenOf(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // Google: start from the sign-in page, finish in the browser, collect the session in the window that started it.
  app.post('/api/auth/google/start', (req, res) => {
    throttle(`google:${req.ip}`, 20);
    res.json(startGoogleFlow(req, { purpose: 'login', remember: Boolean(req.body?.remember) }));
  });
  app.get('/api/auth/google/callback', async (req, res) => {
    const out = await finishGoogleFlow({ state: req.query.state, code: req.query.code, error: req.query.error });
    res.status(out.ok ? 200 : 400).type('html').send(callbackPage(out));
  });
  app.post('/api/auth/google/poll', (req, res) => {
    const r = pollGoogleFlow(req.body?.flow);
    if (r.status === 'done' && r.purpose === 'login') {
      startSession(req, res, r.userId, { method: 'google', remember: r.remember });
      return res.json({ status: 'done' });
    }
    if (r.status === 'done') return res.json({ status: 'linked', email: r.email });
    res.json({ status: r.status, error: r.error });
  });
  app.post('/api/auth/google/cancel', (req, res) => {
    cancelGoogleFlow(req.body?.flow);
    res.json({ ok: true });
  });
}

// ── Signed-in routes: Sign-in & security ─────────────────────────────────────────────────────────────────────────
export function securityRoutes(app) {
  app.get('/api/security', (req, res) => {
    const u = userRow(req.user.id);
    const sessions = db.prepare('SELECT token_hash, created_at, last_seen, user_agent, method, persistent, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC').all(u.id, Date.now());
    res.json({
      username: u.username,
      can_reset_without_password: req.user.method === 'google' && Date.now() - req.user.started < 10 * 60_000,
      password_changed_at: u.password_changed_at ?? u.created_at,
      two_factor: Boolean(u.totp_secret_enc),
      recovery_left: u.totp_secret_enc ? JSON.parse(u.recovery_hashes ?? '[]').length : null,
      google: googleStatus(u.id),
      sessions: sessions.map((s) => ({
        id: s.token_hash.slice(0, 16),
        current: s.token_hash === req.user.session,
        device: deviceOf(s.user_agent),
        method: s.method ?? 'password',
        created_at: s.created_at ? new Date(s.created_at).toISOString() : null,
        last_seen: s.last_seen ? new Date(s.last_seen).toISOString() : null,
        expires_at: new Date(s.expires_at).toISOString(),
        persistent: Boolean(s.persistent),
      })),
    });
  });

  app.post('/api/security/password', async (req, res) => {
    throttle(`pw:${req.user.id}`);
    const u = userRow(req.user.id);
    const { current, next } = req.body ?? {};
    // A forgotten password: right after signing in with your linked Google account, you can set a new one without it.
    const viaGoogle = req.user.method === 'google' && Date.now() - req.user.started < 10 * 60_000 && !current;
    if (!viaGoogle) await requirePassword(u, current);
    const problem = passwordProblem(next, u.username);
    if (problem) throw new HttpError(400, problem);
    if (await verifyPassword(next, u.pass_hash)) throw new HttpError(400, 'Choose a password you haven’t used here.');
    db.prepare('UPDATE users SET pass_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(next), nowIso(), u.id);
    // Everyone else signed in with the old password is signed out.
    const ended = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, req.user.session).changes;
    notify({ kind: 'security', severity: 'info', title: 'Password changed', body: ended ? `${ended} other session${ended === 1 ? ' was' : 's were'} signed out.` : 'Your other sessions, if any, were signed out.', dedupe: `pw:${Date.now()}` });
    res.json({ ok: true, signed_out: Number(ended) });
  });

  app.post('/api/security/sessions/:id/end', (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'Unknown session.');
    if (req.user.session.startsWith(id)) throw new HttpError(400, 'To end this session, sign out.');
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?').run(req.user.id, id);
    res.json({ ok: true, ended: Number(r.changes) });
  });
  app.post('/api/security/sessions/end-others', (req, res) => {
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, req.user.session);
    res.json({ ok: true, ended: Number(r.changes) });
  });

  // Two-step verification: start (secret + QR), confirm with a code and your password, turn off, new recovery codes.
  app.post('/api/security/2fa/start', (req, res) => {
    const u = userRow(req.user.id);
    if (u.totp_secret_enc) throw new HttpError(400, 'Two-step verification is already on.');
    const secret = newSecret();
    pendingTotp.set(u.id, { secret, created: Date.now() });
    const uri = otpauthUri(secret, u.username);
    res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qrSvg(uri) });
  });
  app.post('/api/security/2fa/confirm', async (req, res) => {
    throttle(`2fa:${req.user.id}`);
    const u = userRow(req.user.id);
    const p = pendingTotp.get(u.id);
    if (!p || Date.now() - p.created > 15 * 60_000) throw new HttpError(400, 'Start again: the setup expired.');
    await requirePassword(u, req.body?.password);
    const step = verifyCode(p.secret, req.body?.code);
    if (step == null) throw new HttpError(400, 'That code doesn’t match. Check the time on your phone, and use the newest code.');
    const { codes, hashes } = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = ?, recovery_hashes = ? WHERE id = ?').run(encrypt(p.secret, `${TOTP_AAD}:${u.id}`), step, JSON.stringify(hashes), u.id);
    pendingTotp.delete(u.id);
    notify({ kind: 'security', severity: 'info', title: 'Two-step verification is on', body: 'Signing in with your password now also needs a code from your authenticator app.', dedupe: `2fa-on:${Date.now()}` });
    res.json({ ok: true, recovery_codes: codes });
  });
  app.post('/api/security/2fa/disable', async (req, res) => {
    throttle(`2fa:${req.user.id}`);
    const u = userRow(req.user.id);
    if (!u.totp_secret_enc) throw new HttpError(400, 'Two-step verification is already off.');
    await requirePassword(u, req.body?.password);
    if (!checkSecondFactor(u, req.body?.code)) throw new HttpError(400, 'That code isn’t right.');
    db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_last_step = NULL, recovery_hashes = NULL WHERE id = ?').run(u.id);
    notify({ kind: 'security', severity: 'warn', title: 'Two-step verification is off', body: 'Signing in now needs only your password.', dedupe: `2fa-off:${Date.now()}` });
    res.json({ ok: true });
  });
  app.post('/api/security/2fa/recovery', async (req, res) => {
    throttle(`2fa:${req.user.id}`);
    const u = userRow(req.user.id);
    if (!u.totp_secret_enc) throw new HttpError(400, 'Turn on two-step verification first.');
    await requirePassword(u, req.body?.password);
    const { codes, hashes } = newRecoveryCodes();
    db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), u.id);
    res.json({ ok: true, recovery_codes: codes });
  });

  // Sign in with Google: your OAuth client, then linking your Google account.
  app.put('/api/security/google-client', (req, res) => {
    saveGoogleClient(req.body ?? {});
    res.json(googleStatus(req.user.id));
  });
  app.delete('/api/security/google-client', (req, res) => {
    removeGoogleClient();
    res.json(googleStatus(req.user.id));
  });
  app.post('/api/security/google/link', (req, res) => {
    res.json(startGoogleFlow(req, { purpose: 'link', userId: req.user.id }));
  });
  app.post('/api/security/google/unlink', async (req, res) => {
    const u = userRow(req.user.id);
    await requirePassword(u, req.body?.password);
    db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?').run(u.id);
    res.json(googleStatus(u.id));
  });
}

