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

-- One row per integration, UTC day, model and source. source: api | manual | webhook.
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

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
`);

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
  notify: {
    task_failed: true,
    task_completed: false,
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
  return { ...DEFAULT_SETTINGS, ...saved, notify: { ...DEFAULT_SETTINGS.notify, ...(saved.notify ?? {}) } };
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

/** Creates a notification once per dedupe key, if that kind is switched on. Returns true when created. */
export function notify({ kind, severity, title, body, dedupe }) {
  if (getSettings().notify[kind] === false) return false;
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO notifications(kind, severity, title, body, dedupe_key, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    )
    .run(kind, severity, title, body, dedupe ?? null, nowIso());
  return res.changes > 0;
}
