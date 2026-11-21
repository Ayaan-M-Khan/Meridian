/**
 * Backups of your data as one JSON file, and restoring from one.
 *
 * Included: settings, your tools (names, budgets, on/off), usage you logged or your scripts reported, tasks and their
 * results, assistant conversations, and alerts. Left out on purpose: your password, API keys and ingest tokens (so a
 * backup file is safe to keep anywhere), and anything the app reads again on its own (synced API usage, usage and
 * sessions from AI apps on this computer).
 */
import { db, tx, getSettings, setRaw, addEvent } from './db.js';
import { adapters } from './adapters/index.js';
import { HttpError, nowIso } from './util.js';
import { nextRun } from './automations.js';

export const BACKUP_FORMAT = 'ai-command-center-backup';
const KEPT_USAGE_SOURCES = ['manual', 'webhook', 'app'];

export function makeBackup(appVersion = null) {
  const settings = getSettings();
  return {
    format: BACKUP_FORMAT,
    version: 1,
    app_version: appVersion,
    exported_at: nowIso(),
    settings,
    integrations: db.prepare('SELECT id, adapter, name, budget_usd, enabled, created_at FROM integrations ORDER BY id').all(),
    usage_daily: db.prepare(`SELECT * FROM usage_daily WHERE source IN (${KEPT_USAGE_SOURCES.map(() => '?').join(',')})`).all(...KEPT_USAGE_SOURCES),
    tasks: db.prepare("SELECT * FROM tasks WHERE kind IS NULL OR kind != 'session' ORDER BY id").all(),
    task_progress: db.prepare("SELECT p.* FROM task_progress p JOIN tasks t ON t.id = p.task_id WHERE t.kind IS NULL OR t.kind != 'session'").all(),
    assistant_threads: db.prepare('SELECT * FROM assistant_threads ORDER BY id').all(),
    notifications: db.prepare('SELECT id, kind, severity, title, body, dedupe_key, read, created_at FROM notifications ORDER BY id DESC LIMIT 500').all(),
    automations: db.prepare('SELECT id, name, prompt, mode, folder, schedule, enabled, created_at FROM automations ORDER BY id').all(),
  };
}

const arr = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `This backup’s ${name} isn’t a list.`);
  return v;
};
const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

/** Copies only the columns this version of the app has, so a backup from an older or newer version still loads. */
function insertRows(table, rows, skip = []) {
  if (!rows.length) return;
  const have = cols(table);
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const keys = Object.keys(r).filter((k) => have.has(k) && !skip.includes(k));
    if (!keys.length) continue;
    db.prepare(`INSERT OR IGNORE INTO ${table}(${keys.join(', ')}) VALUES(${keys.map(() => '?').join(', ')})`).run(
      ...keys.map((k) => (r[k] !== null && typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])),
    );
  }
}

/**
 * Replaces your tools, tasks, conversations, alerts and settings with a backup's. Your account and the Claude API key
 * stay as they are. Tools that need a key come back without one and say so.
 */
export function restoreBackup(b) {
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new HttpError(400, 'That file isn’t a Meridian backup.');
  if (b.version !== 1) throw new HttpError(400, 'This backup was made by a newer version of Meridian. Update the app first.');
  const integrations = arr(b.integrations, 'tools').filter((i) => i && Number.isInteger(i.id) && adapters[i.adapter]);
  const counts = { tools: integrations.length, tasks: arr(b.tasks, 'tasks').length, conversations: arr(b.assistant_threads, 'conversations').length };

  tx(() => {
    db.prepare('DELETE FROM integrations').run(); // usage, tasks, progress and events go with them
    db.prepare('DELETE FROM assistant_threads').run();
    db.prepare('DELETE FROM notifications').run();
    const now = nowIso();
    const ins = db.prepare('INSERT INTO integrations(id, adapter, name, budget_usd, enabled, status, last_error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
    for (const i of integrations) {
      const a = adapters[i.adapter];
      const needsKey = Boolean(a.credential);
      const status = needsKey ? 'error' : a.sync ? 'pending' : 'tracked';
      ins.run(i.id, i.adapter, String(i.name ?? a.name).slice(0, 80), Number.isFinite(i.budget_usd) ? i.budget_usd : null, i.enabled === 0 ? 0 : 1, status,
        needsKey ? 'Restored from a backup, which doesn’t include keys. Add the key again on this tool’s page.' : null, i.created_at ?? now);
    }
    const ids = new Set(integrations.map((i) => i.id));
    insertRows('usage_daily', arr(b.usage_daily, 'usage').filter((u) => ids.has(u.integration_id) && KEPT_USAGE_SOURCES.includes(u.source)));
    const tasks = arr(b.tasks, 'tasks').filter((t) => ids.has(t.integration_id) && t.kind !== 'session');
    // A task that was running when the backup was made isn't running now.
    insertRows('tasks', tasks.map((t) => (t.status === 'running' || t.status === 'queued'
      ? { ...t, status: 'failed', error: 'Was still running when this backup was made.', finished_at: t.finished_at ?? now }
      : t)));
    const taskIds = new Set(tasks.map((t) => t.id));
    insertRows('task_progress', arr(b.task_progress, 'progress').filter((p) => taskIds.has(p.task_id)));
    insertRows('assistant_threads', arr(b.assistant_threads, 'conversations'));
    insertRows('notifications', arr(b.notifications, 'alerts'));
    db.prepare('DELETE FROM automations').run();
    for (const a of arr(b.automations, 'automations')) {
      try {
        const schedule = typeof a.schedule === 'string' ? JSON.parse(a.schedule) : a.schedule;
        const next = a.enabled ? nextRun(schedule)?.toISOString() ?? null : null;
        if (!['task', 'team', 'compare'].includes(a.mode) || !next && a.enabled) continue;
        db.prepare('INSERT INTO automations(name, prompt, mode, folder, schedule, enabled, next_run_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
          .run(String(a.name).slice(0, 80), String(a.prompt).slice(0, 4000), a.mode, a.mode === 'team' && typeof a.folder === 'string' ? a.folder : null,
            JSON.stringify(schedule), a.enabled ? 1 : 0, next, a.created_at ?? now);
      } catch {
        /* skip a malformed automation rather than fail the whole restore */
      }
    }
    if (b.settings && typeof b.settings === 'object') {
      const s = { ...getSettings(), ...b.settings };
      setRaw('settings', s);
    }
    setRaw('summary_cache', undefined);
    setRaw('summary_ai_attempt', undefined);
  });
  addEvent(null, 'connection', `Restored a backup from ${String(b.exported_at ?? 'an unknown date').slice(0, 10)}: ${counts.tools} tools, ${counts.tasks} tasks, ${counts.conversations} conversations`);
  return counts;
}
