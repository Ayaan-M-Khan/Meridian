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

const { snapshot, compare, describeChanges, diffText, LIMITS } = await import('../server/changes.js');

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
