import { db, tx, addEvent, notify } from './db.js';
import { sha256, safeEqual } from './crypto.js';
import { evaluateAlerts } from './alerts.js';
import { recordProgress } from './eta.js';
import { HttpError, nowIso } from './util.js';

export const TASK_STATUSES = ['running', 'queued', 'scheduled', 'completed', 'failed'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max, field) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string.`);
  return v.slice(0, max);
};
const time = (v, field) => {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new HttpError(400, `${field} must be an ISO 8601 date-time.`);
  return new Date(t).toISOString();
};
const num = (v, field, { min = 0, max = Infinity } = {}) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be a number from ${min} to ${max}.`);
  return n;
};

export function parseTask(t, i) {
  const at = `tasks[${i}]`;
  if (!t || typeof t !== 'object') throw new HttpError(400, `${at} must be an object.`);
  const id = str(t.id, 200, `${at}.id`);
  const name = str(t.name, 200, `${at}.name`);
  if (!id || !name) throw new HttpError(400, `${at} needs an id and a name.`);
  if (!TASK_STATUSES.includes(t.status)) throw new HttpError(400, `${at}.status must be one of ${TASK_STATUSES.join(', ')}.`);
  return {
    external_id: id,
    name,
    status: t.status,
    description: str(t.description, 2000, `${at}.description`),
    progress: num(t.progress, `${at}.progress`, { max: 100 }),
    started_at: time(t.started_at, `${at}.started_at`),
    eta: time(t.eta, `${at}.eta`),
    scheduled_for: time(t.scheduled_for, `${at}.scheduled_for`),
    finished_at: time(t.finished_at, `${at}.finished_at`) ?? (['completed', 'failed'].includes(t.status) ? nowIso() : null),
    error: str(t.error, 2000, `${at}.error`),
    step: str(t.step, 300, `${at}.step`),
    result: str(t.result, 20000, `${at}.result`),
  };
}

export function parseUsage(u, i) {
  const at = `usage[${i}]`;
  if (!u || typeof u !== 'object' || !DAY.test(u.day ?? '')) throw new HttpError(400, `${at}.day must be YYYY-MM-DD.`);
  return {
    day: u.day,
    model: str(u.model, 120, `${at}.model`) ?? '',
    input_tokens: num(u.input_tokens, `${at}.input_tokens`),
    output_tokens: num(u.output_tokens, `${at}.output_tokens`),
    requests: num(u.requests, `${at}.requests`),
    cost_usd: num(u.cost_usd, `${at}.cost_usd`),
  };
}

export function upsertTask(integration, t) {
  const prev = db.prepare('SELECT id, status FROM tasks WHERE integration_id = ? AND external_id = ?').get(integration.id, t.external_id);
  const now = nowIso();
  // A running task with no start time starts now, so its elapsed time and ETA can be worked out.
  const startedAt = t.started_at ?? (t.status === 'running' && prev?.status !== 'running' ? now : null);
  db.prepare(
    `INSERT INTO tasks(integration_id, external_id, name, description, status, progress, started_at, eta, scheduled_for, finished_at, error, step, result, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration_id, external_id) DO UPDATE SET
       name = excluded.name, description = COALESCE(excluded.description, description), status = excluded.status,
       progress = excluded.progress, started_at = COALESCE(excluded.started_at, started_at), eta = excluded.eta,
       scheduled_for = excluded.scheduled_for, finished_at = excluded.finished_at, error = excluded.error,
       step = excluded.step, result = COALESCE(excluded.result, result), updated_at = excluded.updated_at`,
  ).run(integration.id, t.external_id, t.name, t.description, t.status, t.progress, startedAt, t.eta, t.scheduled_for,
    t.finished_at, t.error, t.step ?? null, t.result ?? null, now, now);

  const taskId = prev?.id ?? db.prepare('SELECT id FROM tasks WHERE integration_id = ? AND external_id = ?').get(integration.id, t.external_id).id;
  if (t.status === 'running') recordProgress(taskId, t.progress, now);
  if (prev?.status !== t.status) announce(integration, taskId, t);
  return taskId;
}

/** Adds the activity-feed entry and any notification for a task that changed status. */
export function announce(integration, taskId, t, { quiet = false } = {}) {
  const verb = { running: 'started', queued: 'queued', scheduled: 'scheduled', completed: 'completed', failed: 'failed' }[t.status];
  addEvent(integration.id, `task_${t.status}`, `${integration.name} ${verb} “${t.name}”${t.status === 'failed' && t.error ? `: ${t.error}` : ''}`);
  if (quiet) return;
  if (t.status === 'failed') {
    notify({ kind: 'task_failed', severity: 'err', title: `Task failed: ${t.name}`, body: `${integration.name}: ${t.error ?? 'No error message was reported.'}`, dedupe: `failed:${taskId}:${t.finished_at}` });
  } else if (t.status === 'completed') {
    notify({ kind: 'task_completed', severity: 'ok', title: `Task completed: ${t.name}`, body: `${integration.name} finished it.`, dedupe: `done:${taskId}:${t.finished_at}` });
  }
}

/** The alert for a background or AI team task you started, when it finishes or fails. */
export function notifyMine(taskId, t, label) {
  if (t.status !== 'completed' && t.status !== 'failed') return;
  const ok = t.status === 'completed';
  const preview = String((ok ? t.result : t.error) ?? '').replace(/[#*`>_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  notify({
    kind: 'my_task_done',
    severity: ok ? 'ok' : 'err',
    title: `${label} ${ok ? 'finished' : 'failed'}: ${t.name}`,
    body: (preview || (ok ? 'The result is on the task.' : 'No error message was reported.')).slice(0, 180),
    dedupe: `mine:${taskId}:${t.finished_at}`,
  });
}

export function upsertUsage(integrationId, u, source) {
  db.prepare(
    `INSERT INTO usage_daily(integration_id, day, model, source, input_tokens, output_tokens, requests, cost_usd)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration_id, day, model, source) DO UPDATE SET
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, requests = excluded.requests, cost_usd = excluded.cost_usd`,
  ).run(integrationId, u.day, u.model, source, u.input_tokens, u.output_tokens, u.requests, u.cost_usd);
}

/** POST /api/ingest/:id with `Authorization: Bearer <ingest token>`. Usage rows set that day's totals; they do not add up. */
export function ingestHandler(req, res) {
  const integration = db.prepare('SELECT id, name, ingest_hash, enabled FROM integrations WHERE id = ?').get(Number(req.params.id));
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!integration?.ingest_hash || !token || !safeEqual(sha256(token), integration.ingest_hash))
    throw new HttpError(401, 'Ingest token is missing or wrong.');
  if (!integration.enabled) throw new HttpError(409, 'This tool is turned off in AI Command Center.');

  const body = req.body ?? {};
  const tasks = Array.isArray(body.tasks) ? body.tasks : body.task ? [body.task] : [];
  const usage = Array.isArray(body.usage) ? body.usage : [];
  if (tasks.length + usage.length === 0) throw new HttpError(400, 'Send a "task", "tasks" or "usage" field.');
  if (tasks.length > 200 || usage.length > 400) throw new HttpError(413, 'Send at most 200 tasks and 400 usage rows per request.');

  const parsedTasks = tasks.map(parseTask);
  const parsedUsage = usage.map(parseUsage);
  tx(() => {
    for (const t of parsedTasks) upsertTask(integration, t);
    for (const u of parsedUsage) upsertUsage(integration.id, u, 'webhook');
  });
  evaluateAlerts();
  res.json({ ok: true, tasks: parsedTasks.length, usage: parsedUsage.length });
}
