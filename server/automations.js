/**
 * Automations: saved prompts that run on a schedule, as an assistant task, an AI team task or Ask all.
 *
 * Times are in this computer's local time. Runs happen while the app is running (keep it in the tray to be sure).
 * A run that was due while the app was closed is skipped and noted, instead of firing late or many times at once.
 * Each run goes through smart routing like any other request, and its task notifies you when it finishes.
 */
import { db, notify } from './db.js';
import { startClaudeTask } from './runner.js';
import { cleanFolder, startTeamTask } from './team.js';
import { HttpError, nowIso } from './util.js';

export const MODES = { task: 'Assistant task', team: 'AI team', compare: 'Ask all' };
const EVERY = ['hour', 'day', 'weekday', 'week'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LATE_LIMIT_MS = 30 * 60_000;

function cleanSchedule(s) {
  if (!s || typeof s !== 'object' || !EVERY.includes(s.every)) throw new HttpError(400, 'Choose how often it runs.');
  const at = typeof s.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.at) ? s.at : null;
  if (!at) throw new HttpError(400, 'Choose a time, like 09:00.');
  const day = Number(s.day);
  if (s.every === 'week' && !(Number.isInteger(day) && day >= 0 && day <= 6)) throw new HttpError(400, 'Choose a day of the week.');
  return { every: s.every, at, ...(s.every === 'week' ? { day } : {}) };
}

/** The next time a schedule fires after `after`, in this computer's local time. */
export function nextRun(schedule, after = new Date()) {
  const [h, m] = schedule.at.split(':').map(Number);
  if (schedule.every === 'hour') {
    const d = new Date(after);
    d.setMinutes(m, 0, 0);
    if (d <= after) d.setHours(d.getHours() + 1);
    return d;
  }
  for (let i = 0; i < 9; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d <= after) continue;
    const wd = d.getDay();
    if (schedule.every === 'weekday' && (wd === 0 || wd === 6)) continue;
    if (schedule.every === 'week' && wd !== schedule.day) continue;
    return d;
  }
  return null;
}

export function describeSchedule(s) {
  if (s.every === 'hour') return `Every hour at :${s.at.slice(3)}`;
  if (s.every === 'day') return `Every day at ${s.at}`;
  if (s.every === 'weekday') return `Every weekday at ${s.at}`;
  return `Every ${DAYS[s.day]} at ${s.at}`;
}

function clean({ name, prompt, mode, schedule, folder }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new HttpError(400, 'Give it a name of 1–80 characters.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new HttpError(400, 'Write what it should do, up to 4,000 characters.');
  if (!MODES[mode]) throw new HttpError(400, 'Choose how it runs.');
  // Only an AI team works in a folder; the other modes give a text result.
  return { name: name.trim(), prompt: prompt.trim(), mode, schedule: cleanSchedule(schedule), folder: mode === 'team' ? cleanFolder(folder) : null };
}

function row(id) {
  const r = db.prepare('SELECT * FROM automations WHERE id = ?').get(Number(id));
  if (!r) throw new HttpError(404, 'That automation no longer exists.');
  return r;
}

const view = (r) => {
  const schedule = JSON.parse(r.schedule);
  const last = r.last_task_id ? db.prepare('SELECT id, status, finished_at FROM tasks WHERE id = ?').get(r.last_task_id) : null;
  return {
    id: r.id, name: r.name, prompt: r.prompt, mode: r.mode, mode_label: MODES[r.mode], folder: r.folder ?? null, schedule, schedule_text: describeSchedule(schedule),
    enabled: Boolean(r.enabled), next_run_at: r.enabled ? r.next_run_at : null, last_run_at: r.last_run_at, last_error: r.last_error,
    last_task: last ? { id: last.id, status: last.status, finished_at: last.finished_at } : null, created_at: r.created_at,
  };
};

export const listAutomations = () => db.prepare('SELECT * FROM automations ORDER BY enabled DESC, next_run_at').all().map(view);

export function createAutomation(input) {
  const a = clean(input);
  const now = nowIso();
  const next = nextRun(a.schedule)?.toISOString() ?? null;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO automations(name, prompt, mode, folder, schedule, enabled, next_run_at, created_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)')
    .run(a.name, a.prompt, a.mode, a.folder, JSON.stringify(a.schedule), next, now);
  return view(row(lastInsertRowid));
}

export function updateAutomation(id, patch) {
  const cur = row(id);
  const merged = { name: cur.name, prompt: cur.prompt, mode: cur.mode, folder: cur.folder, schedule: JSON.parse(cur.schedule), ...patch };
  const a = clean(merged);
  const enabled = 'enabled' in patch ? (patch.enabled ? 1 : 0) : cur.enabled;
  const next = enabled ? nextRun(a.schedule)?.toISOString() ?? null : null;
  db.prepare('UPDATE automations SET name = ?, prompt = ?, mode = ?, folder = ?, schedule = ?, enabled = ?, next_run_at = ?, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = ?')
    .run(a.name, a.prompt, a.mode, a.folder, JSON.stringify(a.schedule), enabled, next, enabled && !cur.enabled ? 1 : 0, cur.id);
  return view(row(cur.id));
}

export function deleteAutomation(id) {
  db.prepare('DELETE FROM automations WHERE id = ?').run(row(id).id);
}

/** Starts one run now. Scheduled runs also move the next run forward. */
export function runAutomation(id, { scheduled = false, now = new Date() } = {}) {
  const r = row(id);
  const schedule = JSON.parse(r.schedule);
  const next = scheduled ? nextRun(schedule, now)?.toISOString() ?? null : r.next_run_at;
  try {
    const t = r.mode === 'task'
      ? startClaudeTask({ name: r.name, instructions: r.prompt })
      : startTeamTask({ goal: r.prompt, mode: r.mode, name: r.name, folder: r.mode === 'team' ? r.folder : null });
    db.prepare('UPDATE automations SET last_run_at = ?, last_task_id = ?, last_error = NULL, next_run_at = ? WHERE id = ?').run(now.toISOString(), t.id, next, r.id);
    return { ok: true, task_id: t.id, status: t.status };
  } catch (err) {
    db.prepare('UPDATE automations SET last_run_at = ?, last_error = ?, next_run_at = ? WHERE id = ?').run(now.toISOString(), err.message, next, r.id);
    notify({ kind: 'my_task_done', severity: 'err', title: `Automation couldn’t start: ${r.name}`, body: err.message, dedupe: `auto:${r.id}:${now.toISOString().slice(0, 16)}` });
    if (!scheduled) throw err;
    return { ok: false, error: err.message };
  }
}

/** Runs automations that are due. Called every minute by the scheduler. */
export function runDueAutomations(now = new Date()) {
  const due = db.prepare('SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now.toISOString());
  for (const r of due) {
    const late = now.getTime() - Date.parse(r.next_run_at);
    if (late > LATE_LIMIT_MS) {
      const next = nextRun(JSON.parse(r.schedule), now)?.toISOString() ?? null;
      const missed = new Date(r.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      db.prepare('UPDATE automations SET next_run_at = ?, last_error = ? WHERE id = ?').run(next, `Skipped the run due ${missed} because the app wasn’t running then.`, r.id);
      continue;
    }
    runAutomation(r.id, { scheduled: true, now });
  }
}
