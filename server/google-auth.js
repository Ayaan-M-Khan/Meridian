/**
 * Sign in with Google (OpenID Connect, authorization code flow with PKCE).
 *
 * You register your own OAuth client in Google Cloud (type "Desktop app") and paste its ID and secret into the app.
 * Google's page opens in your normal browser, since Google doesn't allow sign-in inside embedded app windows, and
 * sends you back to this app's local address. The app checks the state, PKCE verifier and nonce, exchanges the code
 * directly with Google, verifies the ID token's signature against Google's published keys, and checks issuer,
 * audience, expiry and that the email is verified. A Google account signs in only after you've linked it to your
 * account here; it never creates one. The window that started sign-in collects the session itself, so the browser
 * tab that finished it never holds one.
 */
import crypto from 'node:crypto';
import { db, getRaw, setRaw } from './db.js';
import { decrypt, encrypt, randomToken, secretHint, sha256 } from './crypto.js';
import { HttpError } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const FLOW_TTL_MS = 10 * 60_000;
const CLIENT_AAD = 'google-oauth-client';

const flows = new Map(); // state -> flow
let fetchImpl = fetch;
export const setGoogleFetchForTests = (f) => (fetchImpl = f ?? fetch);

// ── Your OAuth client ────────────────────────────────────────────────────────────────────────────────────────────
export function googleClient() {
  const c = getRaw('google_oauth');
  if (!c?.client_id || !c.secret_enc) return null;
  try {
    return { id: c.client_id, secret: decrypt(c.secret_enc, CLIENT_AAD), hint: c.secret_hint };
  } catch {
    return null;
  }
}

export function saveGoogleClient({ client_id, client_secret }) {
  const id = String(client_id ?? '').trim();
  const secret = String(client_secret ?? '').trim();
  if (!/^[\w-]{6,120}\.apps\.googleusercontent\.com$/.test(id)) throw new HttpError(400, 'The client ID ends with .apps.googleusercontent.com. Copy it from Google Cloud → Credentials.');
  if (!/^[\w-]{10,120}$/.test(secret)) throw new HttpError(400, 'Paste the client secret shown next to the client ID (it often starts with GOCSPX-).');
  setRaw('google_oauth', { client_id: id, secret_enc: encrypt(secret, CLIENT_AAD), secret_hint: secretHint(secret) });
}
export const removeGoogleClient = () => setRaw('google_oauth', undefined);

export function googleStatus(userId = null) {
  const c = getRaw('google_oauth');
  const linked = db.prepare('SELECT google_email FROM users WHERE google_sub IS NOT NULL' + (userId ? ' AND id = ?' : ' LIMIT 1')).get(...(userId ? [userId] : []));
  return { configured: Boolean(c?.client_id), client_id: c?.client_id ?? null, secret_hint: c?.secret_hint ?? null, linked: Boolean(linked), email: userId ? linked?.google_email ?? null : null };
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────
function prune(now = Date.now()) {
  for (const [k, f] of flows) if (now - f.created > FLOW_TTL_MS) flows.delete(k);
}

/** Google only returns to a loopback address for desktop clients, so this server must be reached on one. */
export function redirectUri(req) {
  const base = process.env.ACC_PUBLIC_URL?.replace(/\/+$/, '');
  if (base) return `${base}/api/auth/google/callback`;
  const host = String(req.get('host') ?? '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(host)) throw new HttpError(400, 'Sign in with Google works on this computer’s own address (127.0.0.1). To use it from elsewhere, set ACC_PUBLIC_URL to your HTTPS address and register it in Google Cloud.');
  return `http://${host}/api/auth/google/callback`;
}

/** Starts sign-in ("login") or linking ("link", while signed in). Returns Google's URL and a flow key the caller keeps. */
export function startGoogleFlow(req, { purpose, userId = null, remember = false }) {
  const client = googleClient();
  if (!client) throw new HttpError(400, 'Sign in with Google isn’t set up. Add your Google client ID in Sign-in & security.');
  if (purpose === 'login' && !googleStatus().linked) throw new HttpError(400, 'No Google account is linked yet. Sign in with your password, then link one in Sign-in & security.');
  prune();
  if (flows.size > 20) throw new HttpError(429, 'Too many sign-ins in progress. Wait a few minutes.');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const key = randomToken(32);
  const redirect = redirectUri(req);
  flows.set(state, { state, verifier, nonce, keyHash: sha256(key), purpose, userId, remember: Boolean(remember), redirect, created: Date.now(), status: 'pending' });
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${AUTH_URL}?${q}`, flow: key };
}

let jwks = null;
async function googleKeys() {
  if (jwks && Date.now() - jwks.at < 3_600_000) return jwks.keys;
  const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error('Couldn’t fetch Google’s signing keys.');
  jwks = { at: Date.now(), keys: (await res.json()).keys ?? [] };
  return jwks.keys;
}

/** Checks the ID token Google returned: signature, issuer, audience, expiry, nonce and a verified email. */
export async function verifyIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) throw new Error('Google sent an unreadable sign-in token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Google’s sign-in token uses an unexpected signature.');
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Google’s sign-in token was signed with an unknown key.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Google’s sign-in token failed its signature check.');
  if (!ISSUERS.includes(claims.iss)) throw new Error('The sign-in token didn’t come from Google.');
  if (claims.aud !== clientId) throw new Error('The sign-in token was meant for a different app.');
  if (!(claims.exp * 1000 > now - 60_000)) throw new Error('The sign-in token has expired. Try again.');
  if (claims.nonce !== nonce) throw new Error('The sign-in didn’t match this request. Try again.');
  if (!claims.sub) throw new Error('Google didn’t say which account signed in.');
  if (claims.email && claims.email_verified !== true) throw new Error('That Google account’s email isn’t verified.');
  return { sub: String(claims.sub), email: claims.email ? String(claims.email) : null };
}

/** Google sends the browser here. Completes the flow; the waiting app window picks up the result. */
export async function finishGoogleFlow({ state, code, error }) {
  const f = flows.get(String(state ?? ''));
  if (!f || f.status !== 'pending' || Date.now() - f.created > FLOW_TTL_MS) return { ok: false, message: 'This sign-in link has expired or was already used. Start again from Meridian.' };
  const fail = (message) => {
    Object.assign(f, { status: 'error', error: message });
    return { ok: false, message };
  };
  if (error) return fail(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google reported a problem: ${String(error).slice(0, 80)}.`);
  const client = googleClient();
  if (!client) return fail('Sign in with Google was turned off while you were signing in.');
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code ?? ''), client_id: client.id, client_secret: client.secret, redirect_uri: f.redirect, grant_type: 'authorization_code', code_verifier: f.verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id_token) return fail(body.error === 'invalid_client' ? 'Google didn’t accept the client ID and secret. Check them in Sign-in & security.' : 'Google didn’t complete the sign-in. Try again.');
    const who = await verifyIdToken(body.id_token, { clientId: client.id, nonce: f.nonce });
    if (f.purpose === 'link') {
      const taken = db.prepare('SELECT id FROM users WHERE google_sub = ? AND id != ?').get(who.sub, f.userId);
      if (taken) return fail('That Google account is already linked to another account here.');
      db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(who.sub, who.email, f.userId);
      Object.assign(f, { status: 'done', email: who.email });
      return { ok: true, message: `Linked ${who.email ?? 'your Google account'}. You can close this tab and return to Meridian.` };
    }
    const user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(who.sub);
    if (!user) return fail(`${who.email ?? 'That Google account'} isn’t linked to Meridian. Sign in with your password, then link it in Sign-in & security.`);
    Object.assign(f, { status: 'done', userId: user.id, email: who.email });
    return { ok: true, message: 'You’re signed in. You can close this tab and return to Meridian.' };
  } catch (err) {
    return fail(err.name === 'TimeoutError' ? 'Google didn’t answer in time. Try again.' : err.message);
  }
}

/** The app window asks whether its sign-in finished. Only the holder of the flow key gets the result. */
export function pollGoogleFlow(key) {
  prune();
  const hash = sha256(String(key ?? ''));
  const f = [...flows.values()].find((x) => crypto.timingSafeEqual(Buffer.from(x.keyHash), Buffer.from(hash)));
  if (!f) return { status: 'expired' };
  if (f.status === 'pending') return { status: 'pending' };
  flows.delete(f.state);
  return f.status === 'done' ? { status: 'done', purpose: f.purpose, userId: f.userId, email: f.email, remember: f.remember } : { status: 'error', error: f.error };
}

export function cancelGoogleFlow(key) {
  const hash = sha256(String(key ?? ''));
  for (const [k, f] of flows) if (f.keyHash === hash) flows.delete(k);
}

/** The page the browser shows when Google sends it back. No scripts, nothing to keep. */
export function callbackPage({ ok, message }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ok ? 'Signed in' : 'Sign-in didn’t finish'} · Meridian</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f8;color:#14161f;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;margin:24px;padding:32px;border:1px solid #dcdfe8;border-radius:12px;background:#fff;box-shadow:0 8px 30px rgba(20,22,31,.08)}
h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#4a5068}.mark{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;margin-bottom:16px;color:#fff;font-weight:700;background:${ok ? '#1f7a4d' : '#b3261e'}}
@media (prefers-color-scheme:dark){body{background:#0e1015;color:#eceef4}main{background:#161922;border-color:#2a2e3a}p{color:#a7adbf}}</style></head>
<body><main><div class="mark">${ok ? '✓' : '!'}</div><h1>${ok ? 'Done' : 'Sign-in didn’t finish'}</h1><p>${esc(message)}</p></main></body></html>`;
}
