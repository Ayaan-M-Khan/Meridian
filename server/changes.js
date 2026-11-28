/**
 * What a task changed in the folder it worked in.
 *
 * When a task that may change files starts (an assistant task given a folder, or an AI team working in one), the app
 * reads the folder: each file's size, time and contents, keeping the text of text files. When the task ends it reads
 * the folder again and keeps the difference: which files were added, changed or deleted, with a line-by-line diff of
 * text files. It only reads files. It runs no programs (not even git), so nothing written into the folder can make it
 * run one, and it never follows links out of the folder. Changes you or another program made in the folder while the
 * task ran are included; the task panel says so.
 *
 * Put back undoes a task's changes: each changed file gets its exact earlier contents (kept when the task ended), each
 * file it added is deleted, and each file it deleted comes back. A file is touched only if it's still exactly as the
 * task left it (by checksum), so anything you changed since is left alone. It writes only inside the task's folder,
 * never through a link, and never into .git or the other folders that aren't read.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { addEvent, db, tx } from './db.js';
import { HttpError, nowIso } from './util.js';

/** Folders that hold generated or downloaded files, not the work itself. They're not read. */
export const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.gradle', '.idea', '.vs',
  'dist', 'coverage', 'target',
]);

export const LIMITS = {
  files: 20_000, // files looked at per folder
  dirs: 5_000, // folders looked into
  hashBytes: 8 * 1024 * 1024, // larger files are compared by size and time only
  textBytes: 512 * 1024, // larger text files are listed without a diff
  totalText: 24 * 1024 * 1024, // text kept in memory while a task runs
  listed: 500, // files listed per task
  diffLines: 3_000, // diff lines kept per file
  diffBytes: 2 * 1024 * 1024, // diff text kept per task
  maxEdits: 2_000, // past this many edits in one file, the diff shows the changed part replaced as a whole
  keepBytes: 8 * 1024 * 1024, // earlier copies kept per task, so its changes can be put back
  newDirs: 200, // folders a task created, removed again by Put back once they're empty
};

/**
 * Files that often hold passwords, keys or tokens (.env, private keys, credential files). They're still listed when
 * they change, found by their checksum, but their text is never kept, so no diff of them lands in the app's data or
 * in a backup.
 */
export const isSecretFile = (rel) => {
  const name = rel.split('/').pop().toLowerCase();
  return /^\.env(\.|$)/.test(name) || ['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd'].includes(name)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name) || /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ppk)$/.test(name)
    // A whole word in the name ("client_secret.json", "aws-credentials"), not part of one ("tokenizer.js").
    || /(^|[._-])(secrets?|credentials?|passwords?|passwd|tokens?)([._-]|$)/.test(name);
};

// The order the folder is read in, as one comparable string: a folder's files before its subfolders, each by name.
// A NUL between parts sorts below any character a name can have, so comparing keys compares part by part.
const orderKey = (rel) => {
  const parts = rel.split('/');
  return parts.map((p, i) => `${i === parts.length - 1 ? '0' : '1'}${p}`).join('\0');
};

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Reads a folder: every file's size and time, a checksum of its contents, and the text of text files. */
export async function snapshot(root, limits = LIMITS) {
  const files = new Map();
  const folders = new Set();
  let textLeft = limits.totalText;
  let dirs = 0;
  let stopped = false;
  let lastKey = null;
  const stack = [''];
  while (stack.length && !stopped) {
    const rel = stack.pop();
    if (++dirs > limits.dirs) {
      stopped = true;
      break;
    }
    let entries;
    try {
      entries = await fs.promises.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
    } catch {
      continue; // a folder that can't be read is skipped both times, so it never shows as changed
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never followed: a link (or junction) could lead out of the folder
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) {
          subdirs.push(r);
          folders.add(r);
        }
        continue;
      }
      if (!e.isFile()) continue;
      if (files.size >= limits.files) {
        stopped = true;
        break;
      }
      const full = path.join(root, ...r.split('/'));
      let st;
      try {
        st = await fs.promises.lstat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const entry = { size: st.size, mtime: st.mtimeMs, hash: null, text: null, exact: false, binary: false, large: st.size > limits.hashBytes, secret: isSecretFile(r) };
      if (!entry.large) {
        try {
          const buf = await fs.promises.readFile(full);
          entry.hash = crypto.createHash('sha1').update(buf).digest('hex');
          entry.binary = isBinary(buf);
          if (!entry.binary && !entry.secret && buf.length <= limits.textBytes && buf.length <= textLeft) {
            entry.text = buf.toString('utf8');
            // Put back writes this text: only when it turns back into exactly these bytes (valid UTF-8).
            entry.exact = Buffer.from(entry.text, 'utf8').equals(buf);
            textLeft -= buf.length;
          }
        } catch {
          /* locked or unreadable right now: compared by size and time */
        }
      }
      files.set(r, entry);
      lastKey = orderKey(r);
    }
    // Pushed in reverse so they're read in name order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  return { root, files, folders, partial: stopped, lastKey: stopped ? lastKey : null, at: nowIso() };
}

const splitLines = (s) => {
  if (!s) return [];
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * Myers' shortest edit script between two lists of lines: '=' keeps a line, '-' removes one from `a`, '+' adds one
 * from `b`. Returns null past `maxD` edits, when a minimal script would cost too much to find.
 */
function editScript(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // the window this round reads: v[-d-1 .. d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;
  const edits = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d];
    const at = (k) => w[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: '=', ax: x - 1, bx: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ op: '+', ax: x, bx: y - 1 });
      else edits.push({ op: '-', ax: x - 1, bx: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

/** The edits between two texts: equal lines at both ends are matched first, then the middle is diffed. */
function edits(a, b, maxD) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  let mid = editScript(am, bm, maxD);
  if (!mid) mid = [...am.map((_, i) => ({ op: '-', ax: i, bx: 0 })), ...bm.map((_, i) => ({ op: '+', ax: am.length, bx: i }))];
  const out = [];
  for (let i = 0; i < pre; i++) out.push({ op: '=', ax: i, bx: i });
  for (const e of mid) out.push({ op: e.op, ax: e.ax + pre, bx: e.bx + pre });
  for (let i = 0; i < suf; i++) out.push({ op: '=', ax: a.length - suf + i, bx: b.length - suf + i });
  return out;
}

/**
 * A unified diff (3 lines of context) between two texts, with the lines added and removed. Line endings are ignored
 * when comparing; a change to line endings alone is reported as such, with no diff.
 */
export function diffText(before, after, { maxLines = LIMITS.diffLines, maxD = LIMITS.maxEdits, context = 3 } = {}) {
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const script = edits(a, b, maxD);
  let added = 0;
  let removed = 0;
  for (const e of script) {
    if (e.op === '+') added++;
    else if (e.op === '-') removed++;
  }
  if (!added && !removed) return { added: 0, removed: 0, diff: null, note: before === after ? null : 'Only line endings changed' };
  const changes = [];
  script.forEach((e, i) => e.op !== '=' && changes.push(i));
  const lines = [];
  let cut = 0;
  let full = false;
  for (let h = 0; h < changes.length; h++) {
    const start = Math.max(0, changes[h] - context);
    let end = changes[h];
    while (h + 1 < changes.length && changes[h + 1] - end <= 2 * context) end = changes[++h];
    end = Math.min(script.length - 1, end + context);
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    for (let j = start; j <= end; j++) {
      const e = script[j];
      if (e.op === '=') {
        body.push(` ${a[e.ax]}`);
        oldCount++;
        newCount++;
      } else if (e.op === '-') {
        body.push(`-${a[e.ax]}`);
        oldCount++;
      } else {
        body.push(`+${b[e.bx]}`);
        newCount++;
      }
    }
    const first = script[start];
    const oldStart = oldCount ? first.ax + 1 : first.ax;
    const newStart = newCount ? first.bx + 1 : first.bx;
    const hunk = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body];
    if (full) {
      cut += hunk.length;
      continue;
    }
    if (lines.length + hunk.length > maxLines) {
      // The diff stops here: as much of this hunk as fits, then a count of what's left out.
      const room = maxLines - lines.length;
      if (room > 1) lines.push(...hunk.slice(0, room));
      cut += hunk.length - Math.max(0, room > 1 ? room : 0);
      full = true;
      continue;
    }
    lines.push(...hunk);
  }
  if (cut) lines.push(`… ${cut.toLocaleString('en-US')} more diff lines not shown`);
  return { added, removed, diff: lines.join('\n'), note: null };
}

/** Which files differ between two readings of a folder. */
export function compare(before, after, limits = LIMITS) {
  const out = [];
  // When a reading stopped early, a path past where it stopped wasn't missing: it just wasn't looked at.
  const seen = (snap, p) => !snap.partial || orderKey(p) <= snap.lastKey;
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  for (const p of paths) {
    const a = before.files.get(p);
    const b = after.files.get(p);
    if (a && b) {
      const same = a.hash && b.hash ? a.hash === b.hash : a.size === b.size && a.mtime === b.mtime;
      if (!same) out.push({ path: p, change: 'changed', a, b });
    } else if (b) {
      if (seen(before, p)) out.push({ path: p, change: 'added', a: null, b });
    } else if (seen(after, p)) {
      out.push({ path: p, change: 'deleted', a, b: null });
    }
  }
  return out;
}

/**
 * The rows kept for a task: each file's change and its diff, within the size limits, with what Put back needs: the
 * file's checksum as the task left it, and (for a changed or deleted text file) its exact earlier contents.
 */
export function describeChanges(list, limits = LIMITS) {
  let budget = limits.diffBytes;
  let keep = limits.keepBytes;
  const rows = [];
  let added = 0;
  let removed = 0;
  for (const c of list) {
    const a = c.a;
    const b = c.b;
    const binary = Boolean((a && a.binary) || (b && b.binary));
    let row = { path: c.path, change: c.change, added: null, removed: null, binary, diff: null, note: null, after_hash: b?.hash ?? null, before_text: null };
    // The earlier copy: never of a file that may hold secrets, a binary file, or text that wouldn't come back byte for byte.
    const size = a?.text != null ? Buffer.byteLength(a.text) : 0;
    if (c.change !== 'added' && a?.text != null && a.exact && !isSecretFile(c.path) && size <= keep) {
      row.before_text = a.text;
      keep -= size;
    }
    const textA = c.change === 'added' ? '' : a?.text;
    const textB = c.change === 'deleted' ? '' : b?.text;
    if (isSecretFile(c.path)) row.note = 'Contents not kept: files like this often hold passwords or keys';
    else if (binary) row.note = 'Binary file';
    else if (textA == null || textB == null) row.note = 'Too large to compare line by line';
    else {
      const d = diffText(textA, textB, { maxLines: limits.diffLines, maxD: limits.maxEdits });
      row = { ...row, added: d.added, removed: d.removed, note: d.note };
      added += d.added;
      removed += d.removed;
      if (d.diff) {
        if (d.diff.length <= budget) {
          row.diff = d.diff;
          budget -= d.diff.length;
        } else {
          row.note = 'Diff left out: this task’s changes are too large to keep them all';
        }
      }
    }
    rows.push(row);
  }
  return { rows, added, removed };
}

const active = new Map(); // task id -> the folder's reading when the task started

/**
 * Reads the task's folder before it starts. Resolves once the reading is done, so the task starts afterwards and
 * every change it makes is seen. Never throws: a folder that can't be read just means no list of changes.
 */
export async function trackChanges(taskId, folder) {
  if (!folder) return;
  try {
    active.set(taskId, await snapshot(folder));
  } catch (err) {
    console.error('[acc] change tracking:', err.message);
  }
}

/** Reads the folder again when the task ends and keeps what changed. Returns the summary, or null. */
export async function recordChanges(taskId) {
  const before = active.get(taskId);
  active.delete(taskId);
  if (!before) return null;
  try {
    const after = await snapshot(before.root);
    const list = compare(before, after);
    const shown = list.slice(0, LIMITS.listed);
    const { rows, added, removed } = describeChanges(shown);
    const partial = before.partial || after.partial;
    // Folders the task created: Put back removes them again once they're empty (only when both readings were whole).
    const newDirs = partial ? [] : [...after.folders].filter((d) => !before.folders.has(d)).slice(0, LIMITS.newDirs);
    const summary = {
      folder: before.root, files: list.length, added, removed, more: list.length - shown.length,
      partial, from: before.at, to: after.at, new_dirs: newDirs,
    };
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) return null; // deleted while it ran
    tx(() => {
      db.prepare('DELETE FROM task_changes WHERE task_id = ?').run(taskId);
      const ins = db.prepare('INSERT INTO task_changes(task_id, path, change, added, removed, binary, diff, note, after_hash, before_text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(taskId, r.path, r.change, r.added, r.removed, r.binary ? 1 : 0, r.diff, r.note, r.after_hash, r.before_text);
      db.prepare('UPDATE tasks SET changes = ? WHERE id = ?').run(JSON.stringify(summary), taskId);
    });
    return summary;
  } catch (err) {
    console.error('[acc] change tracking:', err.message);
    return null;
  }
}

/** Drops a reading without keeping anything, for a task that never ran (handed to another AI before it started). */
export const forgetChanges = (taskId) => active.delete(taskId);

const parse = (s) => {
  try {
    return JSON.parse(s ?? 'null');
  } catch {
    return null;
  }
};
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Why a task's changes can't be put back right now, or null when they can. */
function putBackBlocked(t, summary) {
  if (t.status === 'running' || t.status === 'queued') return 'It’s still running. Put back its changes when it finishes.';
  if (parse(t.detail)?.access === 'git') return 'It ran git, so its work may be committed or pushed. Undo it with git instead.';
  if ([...active.values()].some((s) => samePath(s.root, summary.folder))) return 'Another task is working in this folder. Put back when it finishes.';
  return null;
}

/** Whether one file's change can still be undone, from what was kept; and if not, why. */
function fileState(r) {
  if (r.restored_at) return { can: false, why: null };
  const copy = r.has_copy ?? r.before_text != null;
  if (r.change !== 'added' && !copy) {
    return { can: false, why: isSecretFile(r.path) ? 'files like this often hold passwords or keys, so their contents aren’t kept'
      : r.binary ? 'binary files aren’t kept' : 'its earlier contents aren’t kept (too large, or more than 30 days ago)' };
  }
  if (r.change !== 'deleted' && !r.after_hash) return { can: false, why: 'it’s too large to check it’s unchanged' };
  return { can: true, why: null };
}

/** The task's folder, as long as it's still the same real folder; else null. */
function folderNow(summary) {
  try {
    const root = fs.realpathSync.native(summary.folder);
    return samePath(root, summary.folder) && fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Every changed file of a task, for its panel, and whether its changes can be put back now. */
export function taskChanges(taskId) {
  const t = db.prepare('SELECT changes, detail, status FROM tasks WHERE id = ?').get(Number(taskId));
  const summary = parse(t?.changes);
  if (!summary) return null;
  let blocked = putBackBlocked(t, summary);
  const root = blocked ? null : folderNow(summary);
  if (!blocked && !root) blocked = 'Its folder isn’t there any more, or has moved.';
  // Each file is looked at as it is now, so one you've changed since says so before you choose Put back.
  let budget = 64 * 1024 * 1024;
  const files = db.prepare('SELECT path, change, added, removed, binary, diff, note, after_hash, before_text IS NOT NULL AS has_copy, restored_at FROM task_changes WHERE task_id = ? ORDER BY path')
    .all(Number(taskId)).map((r) => {
      let s = fileState(r);
      if (s.can && root && budget > 0) {
        try {
          const full = target(root, r.path);
          budget -= full && fs.existsSync(full) ? fs.lstatSync(full).size : 0;
          const why = checkNow(root, r);
          if (why) s = { can: false, why };
        } catch {
          /* checked again when putting back */
        }
      }
      return { path: r.path, change: r.change, added: r.added, removed: r.removed, binary: Boolean(r.binary), diff: r.diff, note: r.note, restored_at: r.restored_at, can_put_back: s.can, put_back_note: s.why };
    });
  return { ...summary, list: files, put_back_ready: !blocked && files.some((f) => f.can_put_back), put_back_blocked: blocked };
}

const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** A changed file's full path inside the folder, or null when its recorded path could lead anywhere else. */
function target(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1000 || /[\\\0:]/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || SKIP_DIRS.has(p) || DEVICE.test(p))) return null;
  const full = path.join(root, ...parts);
  if (!isInside(root, full)) return null;
  // Nothing on the way may be a link or junction (which could point out of the folder), or a file.
  for (let dir = path.dirname(full); isInside(root, dir); dir = path.dirname(dir)) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      /* not there now: created as a plain folder when the file comes back */
    }
  }
  return full;
}

const checksum = (full, size) => (size > LIMITS.hashBytes ? null : crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'));

/**
 * Whether one file can be put back now, by looking at it: null when it can (or there's nothing left to do), else why
 * not. It must still be exactly as the task left it.
 */
function checkNow(root, r) {
  const full = target(root, r.path);
  if (!full) return 'its path could lead outside the folder';
  const state = fileState(r);
  if (!state.can) return state.why;
  let st = null;
  try {
    st = fs.lstatSync(full);
  } catch {
    st = null;
  }
  if (st && !st.isFile()) return 'it isn’t a plain file now';
  if (r.change === 'added') return !st || checksum(full, st.size) === r.after_hash ? null : 'it has changed since the task ended';
  if (r.change === 'changed') return !st ? 'it was deleted after the task ended' : checksum(full, st.size) === r.after_hash ? null : 'it has changed since the task ended';
  return st ? 'a file with this name is there again' : null;
}

/** Undoes one file's change. Returns null when done (or already undone), else why it was left alone. */
function putBackFile(root, r) {
  const why = checkNow(root, r);
  if (why) return why;
  const full = target(root, r.path);
  if (r.change === 'added') {
    try {
      fs.unlinkSync(full);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // gone already: nothing to do
    }
    return null;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from(r.before_text, 'utf8'));
  return null;
}

/**
 * Puts back what a task changed in its folder: all of it, or the files in `paths`. Changed files get their earlier
 * contents, added files are deleted (and folders the task created, once empty), deleted files come back. A file you
 * changed since is left alone. Returns what was put back and what was left alone, with why.
 */
export function putBack(taskId, { paths = null } = {}) {
  const t = db.prepare('SELECT id, name, integration_id, changes, detail, status FROM tasks WHERE id = ?').get(Number(taskId));
  if (!t) throw new HttpError(404, 'That task no longer exists.');
  const summary = parse(t.changes);
  if (!summary?.folder) throw new HttpError(400, 'This task didn’t change any files.');
  const blocked = putBackBlocked(t, summary);
  if (blocked) throw new HttpError(409, blocked);
  let root = null;
  try {
    root = fs.realpathSync.native(summary.folder);
    if (!fs.statSync(root).isDirectory()) root = null;
  } catch {
    root = null;
  }
  if (!root) throw new HttpError(400, 'Its folder isn’t there any more.');
  if (!samePath(root, summary.folder)) throw new HttpError(400, 'Its folder has moved or is now a link, so nothing was changed.');
  if (paths != null && (!Array.isArray(paths) || paths.length > LIMITS.listed || paths.some((p) => typeof p !== 'string'))) throw new HttpError(400, 'Choose files from this task’s changes.');
  const want = paths ? new Set(paths) : null;
  const rows = db.prepare('SELECT * FROM task_changes WHERE task_id = ? AND restored_at IS NULL ORDER BY path').all(t.id).filter((r) => !want || want.has(r.path));
  if (want && !rows.length) throw new HttpError(404, 'That file isn’t in this task’s changes, or it was put back already.');
  const done = [];
  const skipped = [];
  for (const r of rows) {
    let why;
    try {
      why = putBackFile(root, r);
    } catch (err) {
      why = `Couldn’t change it: ${err.code === 'EBUSY' || err.code === 'EPERM' ? 'it’s open in another program, or read-only' : err.message}`;
    }
    if (why) skipped.push({ path: r.path, why });
    else done.push(r.path);
  }
  // Folders the task created, deepest first, removed once empty. Ones with anything in them stay.
  if (!want) {
    for (const d of [...(summary.new_dirs ?? [])].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const full = target(root, d);
      try {
        if (full && fs.lstatSync(full).isDirectory() && !fs.readdirSync(full).length) fs.rmdirSync(full);
      } catch {
        /* gone already, or not empty */
      }
    }
  }
  const now = nowIso();
  tx(() => {
    // The earlier copy has done its job once the file is back.
    const mark = db.prepare('UPDATE task_changes SET restored_at = ?, before_text = NULL WHERE task_id = ? AND path = ?');
    for (const p of done) mark.run(now, t.id, p);
    summary.put_back = { at: now, files: (summary.put_back?.files ?? 0) + done.length };
    db.prepare('UPDATE tasks SET changes = ? WHERE id = ?').run(JSON.stringify(summary), t.id);
  });
  if (done.length) addEvent(t.integration_id, 'task_put_back', `Put back ${done.length} file${done.length === 1 ? '' : 's'} changed by “${t.name}”`);
  return { ok: true, put_back: done, skipped };
}

let copiesDropped = 0;
/** Earlier copies kept so a task's changes can be put back are dropped 30 days after it finished; its diffs stay. */
export function dropOldCopies(now = Date.now()) {
  if (now - copiesDropped < 3_600_000) return 0;
  copiesDropped = now;
  const cutoff = new Date(now - 30 * 86_400_000).toISOString();
  return Number(db.prepare(`UPDATE task_changes SET before_text = NULL WHERE before_text IS NOT NULL
    AND task_id IN (SELECT id FROM tasks WHERE COALESCE(finished_at, updated_at) < ?)`).run(cutoff).changes);
}
