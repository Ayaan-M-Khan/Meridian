import { db } from './db.js';
import { nowIso } from './util.js';

const MIN = 60_000;
const MAX_POINTS_PER_TASK = 200;

/** Stores a progress report, skipping repeats of the same value. */
export function recordProgress(taskId, progress, at = nowIso()) {
  if (progress == null) return;
  const last = db.prepare('SELECT progress FROM task_progress WHERE task_id = ? ORDER BY at DESC LIMIT 1').get(taskId);
  if (last && last.progress === progress) return;
  db.prepare('INSERT INTO task_progress(task_id, at, progress) VALUES(?, ?, ?)').run(taskId, at, progress);
  db.prepare(
    `DELETE FROM task_progress WHERE task_id = ? AND rowid NOT IN
       (SELECT rowid FROM task_progress WHERE task_id = ? ORDER BY at DESC LIMIT ${MAX_POINTS_PER_TASK})`,
  ).run(taskId, taskId);
}

export function progressHistory(taskIds) {
  if (!taskIds.length) return new Map();
  const rows = db
    .prepare(`SELECT task_id, at, progress FROM task_progress WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY at`)
    .all(...taskIds);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.task_id)) out.set(r.task_id, []);
    out.get(r.task_id).push({ t: Date.parse(r.at), p: r.progress });
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** How long finished runs of the same task took, keyed by "integration|name". */
export function pastDurations(tasks) {
  const out = new Map();
  for (const t of tasks) {
    if (t.status !== 'completed' || !t.started_at || !t.finished_at) continue;
    const ms = Date.parse(t.finished_at) - Date.parse(t.started_at);
    if (!(ms > 0)) continue;
    const key = `${t.integration_id}|${t.name}`;
    if (!out.has(key)) out.set(key, []);
    if (out.get(key).length < 5) out.get(key).push(ms);
  }
  return out;
}

/**
 * Works out when a running task should finish, and whether it looks stuck.
 *   eta_at      the finish time the UI shows
 *   eta_source  'reported' (the task said so), 'progress' (extrapolated from its progress reports),
 *               'history' (typical length of earlier runs), or null when there is nothing to go on
 * Nothing here is invented: with no reported ETA, no progress trend and no earlier runs, eta_at stays null.
 */
export function estimate(task, points = [], durations = [], now = Date.now()) {
  const none = { eta_at: null, eta_source: null, stalled: false, overdue: false, longer_than_usual: false, typical_ms: null };
  if (task.status !== 'running') return none;
  const out = { ...none, typical_ms: median(durations) };
  const started = task.started_at ? Date.parse(task.started_at) : null;

  // Progress trend: fit a line through the latest reports and extend it to 100%.
  let pts = points.filter((x) => x.p != null && x.t <= now);
  if (started && (!pts.length || (pts[0].t > started && pts[0].p > 0))) pts = [{ t: started, p: 0 }, ...pts];
  const recent = pts.slice(-8);
  let trendEta = null;
  if (recent.length >= 2) {
    const n = recent.length;
    const mt = recent.reduce((a, x) => a + x.t, 0) / n;
    const mp = recent.reduce((a, x) => a + x.p, 0) / n;
    const num = recent.reduce((a, x) => a + (x.t - mt) * (x.p - mp), 0);
    const den = recent.reduce((a, x) => a + (x.t - mt) ** 2, 0);
    const slope = den > 0 ? num / den : 0; // percent per ms
    const last = recent.at(-1);
    if (slope > 0 && last.p < 100) trendEta = last.t + (100 - last.p) / slope;
  }

  if (task.eta) {
    out.eta_at = task.eta;
    out.eta_source = 'reported';
  } else if (trendEta) {
    out.eta_at = new Date(trendEta).toISOString();
    out.eta_source = 'progress';
  } else if (started && out.typical_ms) {
    const byHistory = started + out.typical_ms;
    if (byHistory > now) {
      out.eta_at = new Date(byHistory).toISOString();
      out.eta_source = 'history';
    }
  }
  if (started && out.typical_ms && now - started > out.typical_ms * 1.5 && now - started > 5 * MIN) out.longer_than_usual = true;

  // Overdue: past the expected finish by a margin (10% of the run, at least 2 minutes).
  if (out.eta_at && out.eta_source !== 'history') {
    const eta = Date.parse(out.eta_at);
    const margin = Math.max(2 * MIN, started ? (eta - started) * 0.1 : 0);
    out.overdue = now > eta + margin;
  }

  // Stalled: only for tasks that report progress regularly, when reports stop for much longer than usual.
  const reports = points.filter((x) => x.t <= now);
  if (reports.length >= 2) {
    const gaps = reports.slice(1).map((x, i) => x.t - reports[i].t);
    const quiet = now - Math.max(reports.at(-1).t, Date.parse(task.updated_at));
    out.stalled = quiet > Math.max(15 * MIN, 3 * (median(gaps) ?? 0));
  }
  return out;
}
