/**
 * Your data: what the app keeps, where it goes, how long it stays, and erasing all of it.
 *
 * Everything the app stores is in one folder on this computer (DATA_DIR). Nothing is sent to the app's makers: there
 * is no analytics, tracking or advertising. Data leaves this computer only to the services you connect, when you use
 * them (see DATA_FLOWS), and to GitHub for the update check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, getRaw, setRaw, getSettings, DATA_DIR } from './db.js';
import { nowIso } from './util.js';

export const RETENTION_CHOICES = [0, 30, 90, 180, 365];

/** Where data goes when you use each part of the app. Shown on the Privacy page, word for word. */
export const DATA_FLOWS = [
  {
    to: 'The AI you use (Anthropic, OpenAI, Google, GitHub or Anysphere)',
    what: 'Your chat messages, task instructions, automation prompts, and the dashboard data the AI asks for to answer (tool names, usage, tasks and their results). With a folder, an AI team reads and changes files in that folder only.',
    when: 'Only when you chat, start a task, an automation runs, or the daily summary is written by AI. Ask all sends the same request to every connected AI, up to six.',
    terms: 'Under your own account with that provider, and its terms and privacy policy.',
  },
  {
    to: 'Usage APIs (Anthropic Admin, OpenAI Admin)',
    what: 'Your API key, to read your organisation’s usage and costs.',
    when: 'On each sync, only for tools you connected with a key.',
    terms: 'Read only. Keys are encrypted on this computer.',
  },
  {
    to: 'Google, if you sign in with Google',
    what: 'Sign-in happens on Google’s own page in your browser. The app receives your Google account’s ID and email, to match it to your account here, and nothing else from Google.',
    when: 'Only when you link a Google account or choose Continue with Google.',
    terms: 'Uses the OAuth client you registered in your own Google Cloud account. Your client secret is encrypted on this computer.',
  },
  {
    to: 'GitHub',
    what: 'A request for the latest release of Meridian. Nothing about you or your data.',
    when: 'Every few hours in the desktop app, or when you press Check now. You can turn it off.',
    terms: 'While the releases are private, it goes through your GitHub CLI sign-in.',
  },
  {
    to: 'Your own scripts',
    what: 'Nothing is sent to them. They can report tasks and usage to this app with an ingest token.',
    when: 'When they call the app.',
    terms: 'Each token works for one tool and can be replaced at any time.',
  },
];

const ownTasks = "(kind IS NULL OR kind != 'session')";

/** Counts of what the app keeps, for the Privacy page. Content itself never leaves this function. */
export function dataInventory() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  let size = null;
  try {
    size = fs.statSync(path.join(DATA_DIR, 'acc.db')).size;
  } catch {
    size = null;
  }
  return {
    folder: path.resolve(DATA_DIR),
    database_bytes: size,
    counts: {
      tools: n('SELECT COUNT(*) AS n FROM integrations'),
      tasks: n(`SELECT COUNT(*) AS n FROM tasks WHERE ${ownTasks}`),
      sessions: n("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'session'"),
      conversations: n('SELECT COUNT(*) AS n FROM assistant_threads'),
      alerts: n('SELECT COUNT(*) AS n FROM notifications'),
      activity: n('SELECT COUNT(*) AS n FROM events'),
      routing: n('SELECT COUNT(*) AS n FROM routing_log'),
      automations: n('SELECT COUNT(*) AS n FROM automations'),
      usage_days: n('SELECT COUNT(DISTINCT day) AS n FROM usage_daily'),
    },
    oldest: db.prepare(`SELECT MIN(created_at) AS at FROM tasks WHERE ${ownTasks}`).get().at ?? null,
    last_pruned: getRaw('last_prune') ?? null,
  };
}

/**
 * Deletes finished tasks, conversations, alerts, activity and routing notes older than `days`. Usage totals (numbers
 * per day, no content) are kept for the charts. Running, queued and scheduled tasks are never touched.
 */
export function pruneOldData(days, now = Date.now()) {
  if (!RETENTION_CHOICES.includes(days) || days === 0) return null;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const out = {};
  tx(() => {
    const old = db.prepare(`SELECT id FROM tasks WHERE ${ownTasks} AND status IN ('completed', 'failed') AND COALESCE(finished_at, updated_at) < ?`).all(cutoff).map((r) => r.id);
    const delProgress = db.prepare('DELETE FROM task_progress WHERE task_id = ?');
    const delTask = db.prepare('DELETE FROM tasks WHERE id = ?');
    for (const id of old) {
      delProgress.run(id);
      delTask.run(id);
    }
    out.tasks = old.length;
    out.conversations = Number(db.prepare('DELETE FROM assistant_threads WHERE updated_at < ?').run(cutoff).changes);
    out.alerts = Number(db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes);
    out.activity = Number(db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes);
    out.routing = Number(db.prepare('DELETE FROM routing_log WHERE at < ?').run(cutoff).changes);
  });
  setRaw('last_prune', { at: new Date(now).toISOString(), days, ...out });
  return out;
}

/** Runs the retention clean-up at most once a day. Called by the scheduler. */
export function maybePrune(now = Date.now()) {
  const days = getSettings().privacy?.retention_days ?? 0;
  if (!days) return null;
  const last = getRaw('last_prune');
  if (last?.at && now - Date.parse(last.at) < 20 * 3_600_000 && last.days === days) return null;
  return pruneOldData(days, now);
}

/** Session rows read from AI apps' logs: removed, or renamed so they don't show what you first typed. */
export function applySessionPrivacy(p) {
  if (p.read_sessions === false) return Number(db.prepare("DELETE FROM tasks WHERE kind = 'session'").run().changes);
  if (p.session_titles === false) {
    return Number(db.prepare("UPDATE tasks SET name = (SELECT i.name FROM integrations i WHERE i.id = tasks.integration_id) || ' session' WHERE kind = 'session'").run().changes);
  }
  return 0;
}

/**
 * Erases everything the app stores: your account, tools and keys, usage, tasks and results, conversations, alerts,
 * automations, settings, and the working folders of runs. The app starts over as if newly installed.
 * The encryption key file stays, since it protects nothing once the data is gone and the running app still uses it.
 */
export function eraseEverything() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  // Foreign-key checks can only be switched outside a transaction; every table is emptied, so order doesn't matter.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      for (const t of tables) db.prepare(`DELETE FROM "${t.replace(/"/g, '')}"`).run();
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  try {
    db.exec('VACUUM'); // so deleted content doesn't linger in the database file's free pages
  } catch {
    /* a busy database is vacuumed on a later start */
  }
  for (const dir of ['assistant-workspace', 'bridge']) {
    try {
      fs.rmSync(path.join(DATA_DIR, dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* a run that still holds a file; the folder holds no data of yours once its run ends */
    }
  }
  return { ok: true, at: nowIso(), tables: tables.length };
}
