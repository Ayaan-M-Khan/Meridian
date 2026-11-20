import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

export const DATA_DIR = path.resolve(process.env.ACC_DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.ACC_DB_PATH || path.join(DATA_DIR, 'acc.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY,
  adapter TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_enc TEXT,
  secret_hint TEXT,
  ingest_hash TEXT,
  budget_usd REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_sync_at TEXT,
  last_error TEXT,
  data_refreshed_at TEXT,
  created_at TEXT NOT NULL
);

-- One row per integration, UTC day, model and source. source: api | local | manual | webhook | app.
-- NULL means "not reported", which the UI shows as unavailable rather than zero.
CREATE TABLE IF NOT EXISTS usage_daily (
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  requests INTEGER,
  cost_usd REAL,
  PRIMARY KEY (integration_id, day, model, source)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  progress REAL,
  started_at TEXT,
  eta TEXT,
  scheduled_for TEXT,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, external_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Progress reports over time, used to estimate when a running task will finish.
CREATE TABLE IF NOT EXISTS task_progress (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  progress REAL NOT NULL
);

-- Conversations with the Claude assistant. messages holds the Messages API transcript as JSON.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Smart routing decisions: which AI got a request and why (router.js). Kept to the last 300.
CREATE TABLE IF NOT EXISTS routing_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  engine TEXT NOT NULL,
  why TEXT,
  preview TEXT
);

-- Saved prompts that run on a schedule (automations.js). schedule: {"every":"day","at":"09:00"}.
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL,
  folder TEXT,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_task_id INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_progress_task ON task_progress(task_id, at);
`);

// Columns added after the first release.
//   tasks.kind     'session' for a CLI session read from its logs; NULL for reported tasks
//   tasks.runner   which AI ran a background task (claude-code, codex, gemini-cli, claude-api)
//   integrations.meta  JSON: signed-in account, CLI version and plan limits for local tools
//   assistant_threads.engine  which AI answered the conversation last
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [col, type] of cols) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
//   tasks.detail   JSON for AI team tasks: the folder, who did each stage, and each stage's output
//   tasks.category / assistant_threads.route   what smart routing decided (router.js)
addColumns('tasks', [['step', 'TEXT'], ['result', 'TEXT'], ['kind', 'TEXT'], ['runner', 'TEXT'], ['detail', 'TEXT'], ['category', 'TEXT']]);
addColumns('integrations', [['meta', 'TEXT']]);
addColumns('assistant_threads', [['engine', 'TEXT'], ['route', 'TEXT']]);
addColumns('automations', [['folder', 'TEXT']]);
//   users: a linked Google account (its stable ID and email), two-step verification (encrypted secret, the last code
//   step used so a code works once, hashes of unused recovery codes), and when the password last changed.
//   sessions: when it started and was last used, the browser it's in, how you signed in, and "keep me signed in".
addColumns('users', [['google_sub', 'TEXT'], ['google_email', 'TEXT'], ['totp_secret_enc', 'TEXT'], ['totp_last_step', 'INTEGER'], ['recovery_hashes', 'TEXT'], ['password_changed_at', 'TEXT']]);
addColumns('sessions', [['created_at', 'INTEGER'], ['last_seen', 'INTEGER'], ['user_agent', 'TEXT'], ['method', 'TEXT'], ['persistent', 'INTEGER']]);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL');
// Sessions from before 0.10 had no "keep me signed in" choice; they were 30-day sessions.
db.prepare('UPDATE sessions SET persistent = 1 WHERE persistent IS NULL').run();
db.prepare("UPDATE integrations SET name = 'Assistant (built in)' WHERE adapter = 'claude-assistant' AND name = 'Claude assistant'").run();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const DEFAULT_SETTINGS = {
  usage_warn_pct: 75,
  monthly_ceiling_usd: null,
  sync_minutes: 30,
  summary_interval_hours: 6,
  spike_multiplier: 2,
  assistant_web_search: false,
  assistant_engine: 'auto',
  summary_mode: 'ai', // 'ai': written by the assistant's AI when one is ready; 'rules': built from your data, no AI

  // Who does each part of an AI team task. 'auto' picks the best-suited AI that's ready.
  team_roles: { planner: 'auto', builder: 'auto', reviewer: 'auto', debugger: 'auto' },
  // The model each AI app uses for runs the app starts, by connection id ('claude-code': 'sonnet'). Empty: its default.
  engine_models: {},
  // Smart routing: your preferred AI per kind of task ('planning': 'codex'). Missing or 'auto': routing decides.
  route_prefs: {},
  // Desktop app only: keep running in the tray when the window closes, start at sign-in, show Windows notifications.
  desktop: { keep_running: false, open_at_login: false, notifications: true, check_updates: true },
  // Your data (privacy.js): delete finished work older than this many days (0 keeps it), whether sessions from AI apps
  // on this computer are listed, and whether they're named after their first message.
  privacy: { retention_days: 0, read_sessions: true, session_titles: true },
  notify: {
    my_task_done: true,
    security: true,
    update: true,
    task_failed: true,
    task_completed: false,
    task_stalled: true,
    task_overdue: true,
    scheduled: true,
    usage_warning: true,
    limit_reached: true,
    connection: true,
    spike: true,
  },
};

export function getRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : undefined;
}

export function setRaw(key, value) {
  if (value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

export function getSettings() {
  const saved = getRaw('settings') ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    notify: { ...DEFAULT_SETTINGS.notify, ...(saved.notify ?? {}) },
    team_roles: { ...DEFAULT_SETTINGS.team_roles, ...(saved.team_roles ?? {}) },
    desktop: { ...DEFAULT_SETTINGS.desktop, ...(saved.desktop ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(saved.privacy ?? {}) },
    engine_models: { ...(saved.engine_models ?? {}) },
    route_prefs: { ...(saved.route_prefs ?? {}) },
  };
}

export function addEvent(integrationId, kind, message) {
  db.prepare('INSERT INTO events(integration_id, kind, message, created_at) VALUES(?, ?, ?, ?)').run(
    integrationId,
    kind,
    message,
    nowIso(),
  );
  db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) - 1000 FROM events)').run();
}

/**
 * Creates a notification once per dedupe key, if that kind is switched on. Returns true when created.
 * In the desktop app, a new one also becomes a Windows notification (see electron/main.js).
 */
export function notify({ kind, severity, title, body, dedupe }) {
  if (getSettings().notify[kind] === false) return false;
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO notifications(kind, severity, title, body, dedupe_key, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    )
    .run(kind, severity, title, body, dedupe ?? null, nowIso());
  if (res.changes > 0 && typeof globalThis.accDesktopNotify === 'function') {
    try {
      globalThis.accDesktopNotify({ kind, severity, title, body });
    } catch (err) {
      console.error('[acc] desktop notification:', err.message);
    }
  }
  return res.changes > 0;
}
