// Sign-in and security, end to end over HTTP: password rules, two-step verification, sessions, and Google sign-in
// against a stand-in for Google that signs tokens with a test key. Runs in its own process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-security-'));
process.env.ACC_DATA_DIR = path.join(tmp, 'data');
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const { db } = await import('../server/db.js');
const { startServer } = await import('../server/app.js');
const { passwordProblem, resetThrottleForTests, deviceOf } = await import('../server/auth.js');
const { base32Encode, codeAt, currentStep, verifyCode } = await import('../server/totp.js');
const { setGoogleFetchForTests, verifyIdToken } = await import('../server/google-auth.js');

const srv = await startServer({ port: 0 });
after(() => {
  srv.close();
  setGoogleFetchForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${srv.port}`;

/** A browser: its own cookie jar. */
function browser() {
  let cookie = '';
  const call = async (method, url, body, { ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'x-acc-request': '1', 'content-type': 'application/json', 'user-agent': ua, cookie }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers, setCookie: set };
  };
  return { call, has: () => Boolean(cookie) };
}
const PASSWORD = 'Correct-Horse-Battery-42';

test('authenticator codes match the RFC 6238 test vectors, and a code works only once', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeAt(secret, Math.floor(2000000000 / 30)), '279037');
  const now = 1_111_111_109_000;
  const step = verifyCode(secret, '081804', { now });
  assert.equal(step, Math.floor(1111111109 / 30));
  assert.equal(verifyCode(secret, '081804', { now, after: step }), null, 'the same code can’t be used twice');
  assert.equal(verifyCode(secret, '12345', { now }), null);
});

test('new passwords: long enough, not common, not the username', () => {
  assert.match(passwordProblem('short-pw', 'me'), /12 characters/);
  assert.match(passwordProblem('password1234'.replace('1234', ''), 'me') ?? 'x', /12 characters|common/);
  assert.match(passwordProblem('aicommandcenter', 'me'), /common/);
  assert.match(passwordProblem('aaaaaaaaaaaaaaa', 'me'), /common/);
  assert.match(passwordProblem('my-name-is-ayaan-123', 'ayaan'), /username/);
  assert.equal(passwordProblem(PASSWORD, 'owner'), null);
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140 Electron/45.3.4 Safari'), 'Desktop app on Windows');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/140.0'), 'Firefox on macOS');
});

test('security headers are sent on every response', async () => {
  const res = await fetch(`${base}/api/auth/status`);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('setup, sign-in, two-step verification, recovery codes, sessions and password change', async () => {
  const a = browser();
  assert.equal((await a.call('POST', '/api/auth/setup', { username: 'owner', password: 'too-short', setupCode: srv.setupCode })).status, 400);
  const made = await a.call('POST', '/api/auth/setup', { username: 'owner', password: PASSWORD, setupCode: srv.setupCode, remember: true });
  assert.equal(made.status, 200);
  assert.match(made.setCookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/, '“keep me signed in” lasts 30 days');

  // Wrong username and wrong password get the same answer.
  const b = browser();
  const wrongUser = await b.call('POST', '/api/auth/login', { username: 'nobody', password: PASSWORD });
  const wrongPass = await b.call('POST', '/api/auth/login', { username: 'owner', password: 'not the password' });
  assert.equal(wrongUser.status, 401);
  assert.deepEqual(wrongUser.body, wrongPass.body);
  const plain = await b.call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD });
  assert.equal(plain.status, 200);
  assert.doesNotMatch(plain.setCookie, /Max-Age/, 'without “keep me signed in”, the cookie ends with the app');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'security' AND title = 'New sign-in'").get().n >= 2, 'each sign-in raises an alert');

  // Two-step verification.
  const start = await a.call('POST', '/api/security/2fa/start');
  assert.equal(start.status, 200);
  assert.match(start.body.uri, /^otpauth:\/\/totp\/AI%20Command%20Center%3Aowner\?secret=[A-Z2-7]+&issuer=AI%20Command%20Center/);
  assert.match(start.body.qr, /^<svg/);
  const secret = start.body.secret.replace(/\s/g, '');
  const now = currentStep();
  assert.equal((await a.call('POST', '/api/security/2fa/confirm', { code: '000000', password: PASSWORD })).status, 400);
  assert.equal((await a.call('POST', '/api/security/2fa/confirm', { code: codeAt(secret, now), password: 'wrong' })).status, 403);
  const on = await a.call('POST', '/api/security/2fa/confirm', { code: codeAt(secret, now), password: PASSWORD });
  assert.equal(on.status, 200);
  assert.equal(on.body.recovery_codes.length, 10);
  const stored = db.prepare('SELECT totp_secret_enc, recovery_hashes FROM users').get();
  assert.ok(!stored.totp_secret_enc.includes(secret), 'the secret is stored encrypted');
  assert.ok(!stored.recovery_hashes.includes(on.body.recovery_codes[0]), 'recovery codes are stored as hashes');

  resetThrottleForTests();
  const c = browser();
  const first = await c.call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD });
  assert.equal(first.body.twoFactor, true);
  assert.equal(c.has(), false, 'no session before the second step');
  assert.equal((await c.call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: codeAt(secret, now) })).status, 401, 'the code used to turn it on can’t be used again');
  const ok = await c.call('POST', '/api/auth/login/verify', { challenge: first.body.challenge, code: codeAt(secret, now + 1) });
  assert.equal(ok.status, 200);
  assert.equal(c.has(), true);

  // A recovery code works once.
  const d = browser();
  const ch = (await d.call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD })).body.challenge;
  const rec = await d.call('POST', '/api/auth/login/verify', { challenge: ch, code: on.body.recovery_codes[3].toLowerCase() });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.recovery, true);
  const e = browser();
  const ch2 = (await e.call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD })).body.challenge;
  assert.equal((await e.call('POST', '/api/auth/login/verify', { challenge: ch2, code: on.body.recovery_codes[3] })).status, 401);

  // Sessions: listed, one ended, then everyone else signed out by a password change.
  const s = await a.call('GET', '/api/security');
  assert.equal(s.body.two_factor, true);
  assert.equal(s.body.recovery_left, 9);
  assert.ok(s.body.sessions.length >= 4);
  assert.equal(s.body.sessions.filter((x) => x.current).length, 1);
  assert.equal(s.body.sessions[0].device, 'Chrome on Windows');
  const other = s.body.sessions.find((x) => !x.current);
  assert.equal((await a.call('POST', `/api/security/sessions/${other.id}/end`)).status, 200);
  assert.equal((await a.call('POST', '/api/security/password', { current: 'wrong', next: 'Another-Long-Password-9' })).status, 403, 'a wrong password is refused without signing you out');
  assert.equal((await a.call('POST', '/api/security/password', { current: PASSWORD, next: 'short' })).status, 400);
  const changed = await a.call('POST', '/api/security/password', { current: PASSWORD, next: 'Another-Long-Password-9' });
  assert.equal(changed.status, 200);
  assert.ok(changed.body.signed_out >= 2);
  assert.equal((await c.call('GET', '/api/security')).status, 401, 'other sessions are signed out');
  assert.equal((await a.call('GET', '/api/security')).status, 200, 'this one stays');

  // Turning it off needs the password and a code.
  assert.equal((await a.call('POST', '/api/security/2fa/disable', { password: 'Another-Long-Password-9', code: '123456' })).status, 400);
  const off = await a.call('POST', '/api/security/2fa/disable', { password: 'Another-Long-Password-9', code: codeAt(secret, currentStep() + 1) === codeAt(secret, now + 1) ? on.body.recovery_codes[5] : codeAt(secret, currentStep() + 1) });
  assert.equal(off.status, 200);
});

test('Google sign-in: client checks, linking, then signing in, with every token checked', async () => {
  // A stand-in for Google: its signing key, its token endpoint and its published keys.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const CLIENT = '1234567890-abcdefg.apps.googleusercontent.com';
  let claims = {};
  let lastToken = null;
  const sign = (c, key = privateKey) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(c)).toString('base64url');
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  setGoogleFetchForTests(async (url, opts) => {
    if (url.includes('/certs')) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url.includes('/token')) {
      lastToken = new URLSearchParams(opts.body);
      return new Response(JSON.stringify({ id_token: sign(claims), access_token: 'x' }));
    }
    throw new Error(`unexpected ${url}`);
  });

  resetThrottleForTests();
  const a = browser();
  assert.equal((await a.call('POST', '/api/auth/login', { username: 'owner', password: 'Another-Long-Password-9' })).status, 200);
  assert.equal((await a.call('PUT', '/api/security/google-client', { client_id: 'not-a-client', client_secret: 'GOCSPX-abcdefghijkl' })).status, 400);
  const saved = await a.call('PUT', '/api/security/google-client', { client_id: CLIENT, client_secret: 'GOCSPX-abcdefghijklmnop' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.configured, true);
  assert.equal(JSON.stringify(db.prepare("SELECT value FROM settings WHERE key = 'google_oauth'").get()).includes('GOCSPX-abcdefghijklmnop'), false, 'the client secret is stored encrypted');
  assert.equal((await fetch(`${base}/api/auth/status`).then((r) => r.json())).google, false, 'no button until an account is linked');

  // Link.
  const link = await a.call('POST', '/api/security/google/link');
  const url = new URL(link.body.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('redirect_uri'), `${base}/api/auth/google/callback`);
  const state = url.searchParams.get('state');
  claims = { iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-1001', email: 'owner@example.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, nonce: url.searchParams.get('nonce') };
  assert.equal((await a.call('POST', '/api/auth/google/poll', { flow: link.body.flow })).body.status, 'pending');
  const cb = await fetch(`${base}/api/auth/google/callback?state=${state}&code=abc`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Linked owner@example\.com/);
  assert.equal(cb.headers.get('set-cookie'), null, 'the browser tab never gets a session');
  assert.equal(lastToken.get('code_verifier').length > 40, true, 'PKCE verifier sent to Google');
  const verifierHash = crypto.createHash('sha256').update(lastToken.get('code_verifier')).digest('base64url');
  assert.equal(verifierHash, url.searchParams.get('code_challenge'));
  assert.equal((await a.call('POST', '/api/auth/google/poll', { flow: link.body.flow })).body.status, 'linked');
  assert.equal((await fetch(`${base}/api/auth/google/callback?state=${state}&code=abc`)).status, 400, 'a callback works once');

  // Sign in with Google from a new window.
  assert.equal((await fetch(`${base}/api/auth/status`).then((r) => r.json())).google, true);
  const b = browser();
  const start = await b.call('POST', '/api/auth/google/start', { remember: false });
  const u2 = new URL(start.body.url);
  claims = { ...claims, nonce: u2.searchParams.get('nonce') };
  await fetch(`${base}/api/auth/google/callback?state=${u2.searchParams.get('state')}&code=def`);
  assert.equal((await browser().call('POST', '/api/auth/google/poll', { flow: 'someone-else' })).body.status, 'expired', 'only the window holding the flow key gets the session');
  assert.equal((await b.call('POST', '/api/auth/google/poll', { flow: start.body.flow })).body.status, 'done');
  assert.equal(b.has(), true);
  assert.equal((await b.call('GET', '/api/security')).body.sessions.find((x) => x.current).method, 'google');

  // Every check on the token: wrong nonce, wrong audience, unverified email, forged signature, unlinked account.
  const tryWith = async (mutate, key) => {
    const w = browser();
    const st = await w.call('POST', '/api/auth/google/start', {});
    const uu = new URL(st.body.url);
    claims = mutate({ ...claims, nonce: uu.searchParams.get('nonce') });
    if (key) {
      setGoogleFetchForTests(async (url2) => (url2.includes('/certs') ? new Response(JSON.stringify({ keys: [jwk] })) : new Response(JSON.stringify({ id_token: sign(claims, key) }))));
    }
    const page = await fetch(`${base}/api/auth/google/callback?state=${uu.searchParams.get('state')}&code=x`);
    const poll = await w.call('POST', '/api/auth/google/poll', { flow: st.body.flow });
    return { page: page.status, poll: poll.body, signedIn: w.has() };
  };
  for (const [what, mutate] of [['nonce', (c) => ({ ...c, nonce: 'other' })], ['audience', (c) => ({ ...c, aud: 'other.apps.googleusercontent.com' })], ['email', (c) => ({ ...c, email_verified: false })], ['issuer', (c) => ({ ...c, iss: 'https://evil.example' })], ['expiry', (c) => ({ ...c, exp: 1000 })], ['unlinked', (c) => ({ ...c, sub: 'g-9999' })]]) {
    const r = await tryWith(mutate);
    assert.equal(r.page, 400, what);
    assert.equal(r.poll.status, 'error', what);
    assert.equal(r.signedIn, false, what);
  }
  const forged = await tryWith((c) => c, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  assert.equal(forged.signedIn, false, 'a token not signed by Google’s key is refused');
  assert.match(forged.poll.error, /signature/);
  await assert.rejects(verifyIdToken('not.a.token', { clientId: CLIENT, nonce: 'n' }));

  // Unlinking needs the password.
  assert.equal((await a.call('POST', '/api/security/google/unlink', { password: 'nope' })).status, 403);
  assert.equal((await a.call('POST', '/api/security/google/unlink', { password: 'Another-Long-Password-9' })).body.linked, false);
});
