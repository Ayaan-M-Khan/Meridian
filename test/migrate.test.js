// The rename to Meridian moves the app's folder, keeping everything, and never loses or overwrites data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveAppFolder } from '../electron/migrate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-migrate-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function setup({ legacyData = true, current = null } = {}) {
  const dir = path.join(tmp, String(n++));
  const legacy = path.join(dir, 'AI Command Center');
  const cur = path.join(dir, 'Meridian');
  if (legacyData) {
    fs.mkdirSync(path.join(legacy, 'data'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'data', 'acc.db'), 'my data');
    fs.mkdirSync(path.join(legacy, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'Local Storage', 'prefs'), 'theme');
  }
  if (current === 'empty') fs.mkdirSync(cur, { recursive: true });
  if (current === 'profile') {
    fs.mkdirSync(cur, { recursive: true });
    fs.writeFileSync(path.join(cur, 'Cookies'), 'x');
  }
  if (current === 'data') {
    fs.mkdirSync(path.join(cur, 'data'), { recursive: true });
    fs.writeFileSync(path.join(cur, 'data', 'acc.db'), 'newer data');
  }
  return { legacy, cur };
}
const read = (p) => fs.readFileSync(p, 'utf8');

test('the whole old folder moves to the new name, sign-in and settings included', () => {
  const { legacy, cur } = setup();
  assert.equal(moveAppFolder(legacy, cur), 'moved');
  assert.equal(read(path.join(cur, 'data', 'acc.db')), 'my data');
  assert.equal(read(path.join(cur, 'Local Storage', 'prefs')), 'theme');
  assert.equal(fs.existsSync(legacy), false);
});

test('an empty new folder is replaced; a new profile gets the data moved into it', () => {
  const a = setup({ current: 'empty' });
  assert.equal(moveAppFolder(a.legacy, a.cur), 'moved');
  assert.equal(read(path.join(a.cur, 'data', 'acc.db')), 'my data');
  const b = setup({ current: 'profile' });
  assert.equal(moveAppFolder(b.legacy, b.cur), 'moved-data');
  assert.equal(read(path.join(b.cur, 'data', 'acc.db')), 'my data');
  assert.equal(read(path.join(b.cur, 'Cookies')), 'x', 'nothing in the new folder is touched');
});

test('nothing is overwritten: if the new folder already has data, the old one is left alone', () => {
  const { legacy, cur } = setup({ current: 'data' });
  assert.equal(moveAppFolder(legacy, cur), 'already-moved');
  assert.equal(read(path.join(cur, 'data', 'acc.db')), 'newer data');
  assert.equal(read(path.join(legacy, 'data', 'acc.db')), 'my data');
});

test('a fresh install, or the same folder, does nothing', () => {
  const { legacy, cur } = setup({ legacyData: false });
  assert.equal(moveAppFolder(legacy, cur), 'nothing-to-move');
  assert.equal(moveAppFolder(cur, cur), 'same');
});
