// Privacy and data controls, end to end over HTTP. Runs in its own process, since erasing wipes the whole database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-privacy-'));
process.env.ACC_DATA_DIR = path.join(tmp, 'data');
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const { db, getSettings } = await import('../server/db.js');
const { startServer } = await import('../server/app.js');
const { pruneOldData, applySessionPrivacy } = await import('../server/privacy.js');

const srv = await startServer({ port: 0 });
after(() => {
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${srv.port}`;
let cookie = '';
const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'x-acc-request': '1', 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const PASSWORD = 'a long test password';

test('the page loads nothing from other sites: fonts ship with the app and the CSP allows only this origin', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, 'no third-party URLs in the page');
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /googleapis|gstatic|https:/);
  assert.match(csp, /font-src 'self'/);
  const font = await fetch(`${base}/vendor/fonts/inter/inter-latin-wght-normal.woff2`);
  assert.equal(font.status, 200);
  assert.ok((await font.arrayBuffer()).byteLength > 10_000);
  const css = await (await fetch(`${base}/styles.css`)).text();
  assert.match(css, /@font-face[^}]+\/vendor\/fonts\/inter\//);
});

test('your data: an inventory, where it goes, retention, session privacy, and erasing everything', async () => {
  assert.equal((await call('POST', '/api/auth/setup', { username: 'tester', password: PASSWORD, setupCode: srv.setupCode })).status, 200);
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();
  const integ = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('claude-code', 'Claude Code', 'ok', ?)").run(iso(200)).lastInsertRowid);
  const task = (ext, kind, status, daysAgo, name = ext) => db.prepare(
    'INSERT INTO tasks(integration_id, external_id, name, status, kind, result, finished_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(integ, ext, name, status, kind, 'secret result', status === 'running' ? null : iso(daysAgo), iso(daysAgo), iso(daysAgo));
  task('old-done', null, 'completed', 120);
  task('old-running', null, 'running', 120);
  task('new-done', null, 'completed', 2);
  task('session:1', 'session', 'completed', 1, 'fix the login bug in my bank app');
  db.prepare('INSERT INTO assistant_threads(title, messages, created_at, updated_at) VALUES(?, ?, ?, ?)').run('old chat', '[]', iso(100), iso(100));
  db.prepare('INSERT INTO assistant_threads(title, messages, created_at, updated_at) VALUES(?, ?, ?, ?)').run('new chat', '[]', iso(1), iso(1));
  db.prepare("INSERT INTO notifications(kind, severity, title, body, created_at) VALUES('task_failed', 'err', 'old', 'b', ?)").run(iso(100));
  db.prepare("INSERT INTO routing_log(at, kind, category, engine, why, preview) VALUES(?, 'chat', 'code', 'claude-code', 'x', 'my private request')").run(iso(100));

  const inv = await call('GET', '/api/privacy');
  assert.equal(inv.status, 200);
  assert.equal(inv.body.counts.tasks, 3);
  assert.equal(inv.body.counts.sessions, 1);
  assert.equal(inv.body.counts.conversations, 2);
  assert.ok(inv.body.flows.length >= 3 && inv.body.flows.every((f) => f.to && f.what && f.when));
  assert.equal(JSON.stringify(inv.body).includes('secret result'), false, 'the inventory counts things, it never shows content');

  // Retention: only finished work past the cutoff goes; running work stays.
  assert.equal((await call('PUT', '/api/settings', { privacy: { retention_days: 45 } })).status, 400, 'only listed choices');
  assert.equal((await call('PUT', '/api/settings', { privacy: { retention_days: 90 } })).status, 200);
  const left = db.prepare("SELECT external_id FROM tasks WHERE kind IS NULL OR kind != 'session' ORDER BY external_id").all().map((r) => r.external_id);
  assert.deepEqual(left, ['new-done', 'old-running']);
  assert.deepEqual(db.prepare('SELECT title FROM assistant_threads').all().map((r) => r.title), ['new chat']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'old'").get().n, 0, 'the old alert is gone; today’s sign-in alert stays');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routing_log').get().n, 0);
  assert.equal(pruneOldData(0), null, '“keep” deletes nothing');

  // Sessions: renamed without what you typed, then removed.
  assert.equal((await call('PUT', '/api/settings', { privacy: { session_titles: false } })).status, 200);
  assert.equal(db.prepare("SELECT name FROM tasks WHERE kind = 'session'").get().name, 'Claude Code session');
  assert.equal((await call('PUT', '/api/settings', { privacy: { read_sessions: false } })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'session'").get().n, 0);
  assert.equal(getSettings().privacy.read_sessions, false);
  assert.equal(applySessionPrivacy({ read_sessions: true, session_titles: true }), 0);

  // Erasing: needs the word and your password, refuses while work runs, then wipes everything.
  assert.equal((await call('POST', '/api/privacy/erase', { password: PASSWORD, confirm: 'delete' })).status, 400);
  assert.equal((await call('POST', '/api/privacy/erase', { password: 'wrong password', confirm: 'DELETE' })).status, 403, 'a wrong password isn’t a sign-out');
  fs.mkdirSync(path.join(process.env.ACC_DATA_DIR, 'assistant-workspace'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_DATA_DIR, 'assistant-workspace', 'note.txt'), 'x');
  const erased = await call('POST', '/api/privacy/erase', { password: PASSWORD, confirm: 'DELETE' });
  assert.equal(erased.status, 200, JSON.stringify(erased.body));
  assert.match(erased.body.setup_code, /^\S{6,}$/);
  assert.match(erased.headers.get('set-cookie'), /Max-Age=0/);
  for (const t of ['users', 'sessions', 'integrations', 'tasks', 'assistant_threads', 'notifications', 'settings', 'routing_log', 'automations', 'usage_daily', 'events']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} is empty`);
  }
  assert.equal(fs.existsSync(path.join(process.env.ACC_DATA_DIR, 'assistant-workspace')), false);
  assert.equal((await call('GET', '/api/privacy')).status, 401, 'signed out');
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  assert.equal(status.setupRequired, true, 'the app starts over');
  cookie = '';
  assert.equal((await call('POST', '/api/auth/setup', { username: 'again', password: PASSWORD, setupCode: erased.body.setup_code })).status, 200, 'and the new setup code works');
});
