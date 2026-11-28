import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-changes-'));
process.env.ACC_DATA_DIR = path.join(tmp, 'data');
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { snapshot, compare, describeChanges, diffText, LIMITS, trackChanges, recordChanges, taskChanges, putBack, dropOldCopies } = await import('../server/changes.js');
const { db } = await import('../server/db.js');

const put = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, ...rel.split('/'));
    if (text == null) fs.rmSync(f, { force: true });
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
  }
};

test('diffs: unified hunks with context, counts, and line endings ignored', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const b = a.replace('line 5', 'line five').replace('line 18', 'line 18\nline 18b');
  const d = diffText(`${a}\n`, `${b}\n`);
  assert.deepEqual([d.added, d.removed], [2, 1]);
  assert.equal(d.diff, [
    '@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8',
    '@@ -16,5 +16,6 @@', ' line 16', ' line 17', ' line 18', '+line 18b', ' line 19', ' line 20',
  ].join('\n'));
  // Nearby changes share one hunk.
  assert.equal(diffText('a\nb\nc\nd\n', 'A\nb\nc\nD\n').diff.split('\n').filter((l) => l.startsWith('@@')).length, 1);
  // A new file, and a file emptied.
  assert.equal(diffText('', 'x\ny\n').diff, '@@ -0,0 +1,2 @@\n+x\n+y');
  assert.equal(diffText('x\n', '').diff, '@@ -1,1 +0,0 @@\n-x');
  // Windows line endings only: no diff, but said.
  assert.deepEqual(diffText('a\nb\n', 'a\r\nb\r\n'), { added: 0, removed: 0, diff: null, note: 'Only line endings changed' });
  assert.deepEqual(diffText('same\n', 'same\n'), { added: 0, removed: 0, diff: null, note: null });
});

test('diffs: a long diff is cut short with a count, and a huge rewrite still diffs', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const t0 = Date.now();
  const d = diffText(a, b, { maxLines: 100, maxD: 500 });
  assert.ok(Date.now() - t0 < 5000, 'past the edit limit it falls back instead of searching for the shortest diff');
  assert.deepEqual([d.added, d.removed], [3000, 3000]);
  const lines = d.diff.split('\n');
  assert.equal(lines.length, 101);
  assert.match(lines.at(-1), /^… 5,901 more diff lines not shown$/);
  // The shortest diff is found when it's within reach: moving one line is one removal and one addition.
  const moved = diffText('1\n2\n3\n4\n5\n', '2\n3\n4\n5\n1\n');
  assert.deepEqual([moved.added, moved.removed], [1, 1]);
});

test('reading a folder: generated folders, links and binaries are handled, and only differences are kept', async () => {
  const root = path.join(tmp, 'site');
  put(root, {
    'index.html': '<h1>Hi</h1>\n', 'src/app.js': 'let a = 1;\n', 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]),
    'node_modules/dep/index.js': 'dep', '.git/config': '[core]', 'dist/out.js': 'built', 'notes.txt': 'keep\n',
  });
  let linked = false;
  try {
    fs.symlinkSync(path.join(tmp), path.join(root, 'outside'), 'junction');
    linked = true;
  } catch {
    /* links need extra rights on some systems */
  }
  const before = await snapshot(root);
  assert.deepEqual([...before.files.keys()].sort(), ['index.html', 'logo.png', 'notes.txt', 'src/app.js']);
  assert.equal(before.partial, false);
  assert.equal(before.files.get('logo.png').binary, true);
  assert.equal(before.files.get('src/app.js').text, 'let a = 1;\n');
  if (linked) assert.ok(![...before.files.keys()].some((k) => k.startsWith('outside')), 'links out of the folder are never followed');

  put(root, {
    'index.html': '<h1>Hello</h1>\n', 'src/new.js': 'export {};\n', 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9]),
    'notes.txt': null, 'node_modules/dep/index.js': 'changed', 'dist/out.js': 'rebuilt',
  });
  fs.utimesSync(path.join(root, 'src', 'app.js'), new Date(), new Date(Date.now() + 5000)); // touched, same content
  const after = await snapshot(root);
  const list = compare(before, after);
  assert.deepEqual(list.map((c) => `${c.change} ${c.path}`), ['changed index.html', 'changed logo.png', 'deleted notes.txt', 'added src/new.js']);
  const { rows, added, removed } = describeChanges(list);
  assert.deepEqual([added, removed], [2, 2]);
  const png = rows.find((r) => r.path === 'logo.png');
  assert.deepEqual([png.binary, png.diff, png.note], [true, null, 'Binary file']);
  assert.equal(rows.find((r) => r.path === 'notes.txt').diff, '@@ -1,1 +0,0 @@\n-keep');
});

test('files that often hold secrets are listed when they change, but their contents are never kept', async () => {
  const { isSecretFile } = await import('../server/changes.js');
  for (const f of ['.env', 'app/.env.local', 'id_ed25519', 'certs/server.pem', 'client_secret.json', 'aws-credentials', '.npmrc', 'keys/signing.p12']) assert.ok(isSecretFile(f), f);
  for (const f of ['src/environment.ts', 'README.md', 'keyboard.js', 'src/monkey.py', 'src/tokenizer.js', 'ui/passwordStrength.js']) assert.ok(!isSecretFile(f), f);
  const root = path.join(tmp, 'secrets');
  put(root, { '.env': 'API_KEY=old-value\n', 'config.js': 'export default {};\n' });
  const before = await snapshot(root);
  assert.equal(before.files.get('.env').text, null, 'its text isn’t even held while the task runs');
  put(root, { '.env': 'API_KEY=new-secret-value\n', 'config.js': 'export default { debug: true };\n' });
  const { rows } = describeChanges(compare(before, await snapshot(root)));
  const env = rows.find((r) => r.path === '.env');
  assert.equal(env.change, 'changed');
  assert.equal(env.diff, null);
  assert.match(env.note, /passwords or keys/);
  assert.ok(!JSON.stringify(rows).includes('secret-value') && !JSON.stringify(rows).includes('old-value'));
  assert.ok(rows.find((r) => r.path === 'config.js').diff.includes('+export default { debug: true };'));
});

// A finished task that worked in `root`: the folder is read, `work` changes it, and the changes are recorded.
const integ = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('custom-agent', 'Changes test', 'tracked', '2026-01-01')").run().lastInsertRowid);
let n = 0;
async function taskThat(root, work, { access = 'edit' } = {}) {
  const id = Number(db.prepare("INSERT INTO tasks(integration_id, external_id, name, status, detail, created_at, updated_at) VALUES(?, ?, 'Edit the site', 'running', ?, '2026-01-01', '2026-01-01')")
    .run(integ, `t${++n}`, JSON.stringify({ folder: root, access })).lastInsertRowid);
  await trackChanges(id, root);
  work();
  await recordChanges(id);
  db.prepare("UPDATE tasks SET status = 'completed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return id;
}

test('put back: changed files get their exact earlier bytes, added files and new folders go, deleted files come back', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'pb-')));
  put(root, { 'index.html': '<h1>Hi</h1>\r\n<p>café</p>\r\n', 'old.txt': 'bye\n', 'keep.txt': 'same\n' });
  const id = await taskThat(root, () => put(root, {
    'index.html': '<h1>Hello</h1>\n', 'old.txt': null, 'src/new/deep.js': 'export {};\n', 'src/new/other.js': '1\n',
  }));
  const c = taskChanges(id);
  assert.deepEqual(c.list.map((f) => `${f.change} ${f.path} ${f.can_put_back}`), ['changed index.html true', 'deleted old.txt true', 'added src/new/deep.js true', 'added src/new/other.js true']);
  assert.equal(c.put_back_ready, true);
  // One file first, on its own.
  assert.deepEqual(putBack(id, { paths: ['old.txt'] }).put_back, ['old.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'bye\n');
  assert.throws(() => putBack(id, { paths: ['old.txt'] }), /put back already/);
  // Then the rest: Windows line endings and accents come back byte for byte, and the folders the task made go.
  const r = putBack(id);
  assert.deepEqual(r.put_back, ['index.html', 'src/new/deep.js', 'src/new/other.js']);
  assert.ok(fs.readFileSync(path.join(root, 'index.html')).equals(Buffer.from('<h1>Hi</h1>\r\n<p>café</p>\r\n', 'utf8')));
  assert.equal(fs.existsSync(path.join(root, 'src')), false, 'empty folders the task created are removed');
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'same\n');
  assert.deepEqual(taskChanges(id).list.map((f) => Boolean(f.restored_at)), [true, true, true, true]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_changes WHERE task_id = ? AND before_text IS NOT NULL').get(id).n, 0, 'earlier copies are dropped once used');
});

test('put back leaves alone anything changed since, secrets, binaries, git work and running tasks', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'pb2-')));
  put(root, { 'a.txt': 'one\n', 'b.txt': 'two\n', '.env': 'KEY=1\n', 'logo.png': Buffer.from([1, 0, 2]), 'gone.txt': 'x\n' });
  const id = await taskThat(root, () => put(root, {
    'a.txt': 'ONE\n', 'b.txt': 'TWO\n', '.env': 'KEY=2\n', 'logo.png': Buffer.from([1, 0, 3]), 'gone.txt': null, 'made.txt': 'new\n',
  }));
  // You changed some of it after the task ended.
  put(root, { 'b.txt': 'two, edited by you\n', 'gone.txt': 'you made it again\n', 'made.txt': 'you edited this\n' });
  const states = Object.fromEntries(taskChanges(id).list.map((f) => [f.path, f.can_put_back ? 'yes' : f.put_back_note]));
  assert.match(states['.env'], /passwords or keys/);
  assert.match(states['logo.png'], /binary/);
  const r = putBack(id);
  assert.deepEqual(r.put_back, ['a.txt']);
  const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.why]));
  assert.match(why['b.txt'], /changed since the task ended/);
  assert.match(why['made.txt'], /changed since the task ended/);
  assert.match(why['gone.txt'], /there again/);
  assert.match(why['.env'], /passwords or keys/);
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'two, edited by you\n', 'your edit stays');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'KEY=2\n');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');

  // A path recorded as leading out of the folder, or into .git, is never written.
  db.prepare("INSERT INTO task_changes(task_id, path, change, before_text, after_hash) VALUES(?, '../outside.txt', 'deleted', 'pwned', NULL), (?, '.git/hooks/pre-commit', 'deleted', 'pwned', NULL), (?, 'x:stream', 'deleted', 'pwned', NULL)").run(id, id, id);
  const evil = putBack(id);
  assert.deepEqual(evil.put_back, []);
  assert.ok(evil.skipped.filter((s) => /outside the folder/.test(s.why)).length === 3);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);

  // Through a junction: the folder on the way is now a link, so nothing is written through it.
  const link = await taskThat(root, () => put(root, { 'sub/file.txt': 'made\n' }));
  fs.rmSync(path.join(root, 'sub'), { recursive: true });
  let linked = false;
  try {
    fs.symlinkSync(tmp, path.join(root, 'sub'), 'junction');
    linked = true;
  } catch {
    /* links need extra rights on some systems */
  }
  if (linked) {
    db.prepare("UPDATE task_changes SET change = 'deleted', before_text = 'pwned' WHERE task_id = ?").run(link);
    assert.match(putBack(link).skipped[0].why, /outside the folder/);
    assert.equal(fs.existsSync(path.join(tmp, 'file.txt')), false);
  }

  // A git task's work may be committed: undo it with git. A running task can't be put back yet.
  const git = await taskThat(root, () => put(root, { 'c.txt': 'c\n' }), { access: 'git' });
  assert.match(taskChanges(git).put_back_blocked, /with git/);
  assert.throws(() => putBack(git), /with git/);
  const running = await taskThat(root, () => put(root, { 'd.txt': 'd\n' }));
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running);
  assert.throws(() => putBack(running), /still running/);

  // Earlier copies go 30 days after a task finished; its list and diffs stay.
  const old = await taskThat(root, () => put(root, { 'a.txt': 'once more\n' }));
  db.prepare("UPDATE tasks SET finished_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old);
  assert.ok(dropOldCopies(Date.now()) >= 1);
  const kept = taskChanges(old).list[0];
  assert.equal(kept.can_put_back, false);
  assert.ok(kept.diff.includes('+once more'));
});

test('reading a folder stops at its limits without inventing changes past where it stopped', async () => {
  const root = path.join(tmp, 'big');
  const files = {};
  for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `${i}\n`;
  put(root, files);
  const limits = { ...LIMITS, files: 10 };
  const before = await snapshot(root, limits);
  assert.equal(before.files.size, 10);
  assert.equal(before.partial, true);
  // Two files added before the cut-off push two others out of the next reading: those aren't "deleted".
  put(root, { 'a1.txt': 'new\n', 'a2.txt': 'new\n', 'f03.txt': 'changed\n' });
  const after = await snapshot(root, limits);
  const list = compare(before, after);
  assert.deepEqual(list.map((c) => `${c.change} ${c.path}`), ['added a1.txt', 'added a2.txt', 'changed f03.txt']);
  // A diff budget: diffs past it are left out, with a note, but still counted.
  const big = describeChanges(list.map((c) => ({ ...c, change: 'added', a: null })), { ...LIMITS, diffBytes: 20 });
  assert.equal(big.rows.filter((r) => r.diff).length, 1);
  assert.match(big.rows.at(-1).note, /too large to keep them all/);
});
