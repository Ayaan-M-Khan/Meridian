import { db, tx, getSettings, addEvent, notify, DATA_DIR } from './db.js';
import { adapters } from './adapters/index.js';
import { workspaceDir } from './adapters/local.js';
import { decrypt } from './crypto.js';
import { evaluateAlerts } from './alerts.js';
import { maybeRefreshSummary } from './summary.js';
import { pruneSessions } from './auth.js';
import { runDueAutomations } from './automations.js';
import { maybeCheckForUpdate } from './updates.js';
import { maybePrune } from './privacy.js';
import { AdapterError, addDays, nowIso, startOfUtcDay, startOfUtcMonth, utcDay } from './util.js';

const inFlight = new Map();
const LOCAL_SYNC_MINUTES = 2; // local logs are cheap to read, so local tools stay close to live
const SESSION_ACTIVE_MS = 3 * 60_000; // a session written to in the last 3 minutes counts as running
const MAX_SESSIONS = 60;

/** Pulls month-to-date usage (and the 8 days before today, for spike checks) and replaces the stored rows. */
export function syncIntegration(id) {
  if (!inFlight.has(id)) inFlight.set(id, runSync(id).finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}

/** Installed and signed in: ok. Installed only: signin. Not found: missing. */
export const localStatusOf = (st) => (!st?.installed ? 'missing' : !st.signed_in ? 'signin' : 'ok');

/** Sessions read from a CLI's logs become tasks of kind 'session'. They are not announced in the feed. */
function saveSessions(integrationId, sessions, now = Date.now(), { titles = true, label = 'AI app' } = {}) {
  const cutoff = now - 30 * 86_400_000;
  const keep = sessions
    .filter((s) => s.last_at && Date.parse(s.last_at) >= cutoff)
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
    .slice(0, MAX_SESSIONS);
  const up = db.prepare(
    `INSERT INTO tasks(integration_id, external_id, name, description, status, progress, started_at, finished_at, kind, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'session', ?, ?)
     ON CONFLICT(integration_id, external_id) DO UPDATE SET
       name = excluded.name, description = excluded.description, status = excluded.status, started_at = excluded.started_at,
       finished_at = excluded.finished_at, kind = 'session', updated_at = excluded.updated_at`,
  );
  const ids = [];
  for (const s of keep) {
    const running = now - Date.parse(s.last_at) < SESSION_ACTIVE_MS;
    const detail = [s.where && `in ${s.where}`, s.model, s.tokens ? `${s.tokens.toLocaleString('en-US')} tokens` : null].filter(Boolean).join(' · ');
    const ext = `session:${s.id}`;
    ids.push(ext);
    // With session names off, a session is listed without what you first typed in it.
    up.run(integrationId, ext, titles ? String(s.name).slice(0, 200) : `${label} session`, detail || null, running ? 'running' : 'completed', s.started_at, running ? null : s.last_at, s.started_at ?? s.last_at, s.last_at);
  }
  const stale = db.prepare("SELECT id, external_id FROM tasks WHERE integration_id = ? AND kind = 'session'").all(integrationId).filter((t) => !ids.includes(t.external_id));
  const del = db.prepare('DELETE FROM tasks WHERE id = ?');
  for (const t of stale) del.run(t.id);
}

async function runSync(id) {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
  const adapter = adapters[row?.adapter];
  if (!row || !adapter?.sync) return { ok: false, error: 'This tool has nothing to sync.' };
  const isLocal = adapter.kind === 'local';
  const source = isLocal ? 'local' : 'api';

  const monthStart = startOfUtcMonth();
  const eightDaysAgo = addDays(startOfUtcDay(), -8);
  const since = monthStart < eightDaysAgo ? monthStart : eightDaysAgo;

  try {
    const secret = isLocal ? null : decrypt(row.secret_enc, row.id);
    const out = await adapter.sync({ secret, since, workspace: workspaceDir(DATA_DIR) });
    const status = isLocal ? localStatusOf(out.localStatus) : 'ok';
    tx(() => {
      db.prepare('DELETE FROM usage_daily WHERE integration_id = ? AND source = ? AND day >= ?').run(id, source, utcDay(since));
      const ins = db.prepare(
        `INSERT INTO usage_daily(integration_id, day, model, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, cost_usd)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of out.rows) {
        ins.run(id, r.day, r.model ?? '', source, r.input_tokens ?? null, r.output_tokens ?? null, r.cache_read_tokens ?? null,
          r.cache_write_tokens ?? null, r.requests ?? null, r.cost_usd ?? null);
      }
      const privacy = getSettings().privacy ?? {};
      if (out.sessions && privacy.read_sessions !== false) saveSessions(id, out.sessions, Date.now(), { titles: privacy.session_titles !== false, label: row.name });
      db.prepare('UPDATE integrations SET status = ?, last_sync_at = ?, last_error = NULL, data_refreshed_at = ?, meta = ? WHERE id = ?').run(
        status, nowIso(), out.dataRefreshedAt ?? null, out.meta ? JSON.stringify(out.meta) : row.meta, id);
    });
    if (row.status === 'error') addEvent(id, 'connection', `${row.name} reconnected`);
    if (isLocal && status !== row.status && row.status !== 'pending') {
      addEvent(id, 'connection', status === 'ok' ? `${row.name} is signed in and ready` : status === 'signin' ? `${row.name} is no longer signed in` : `${row.name} was not found on this computer`);
    }
    return { ok: true, rows: out.rows.length, status };
  } catch (err) {
    const message = err instanceof AdapterError ? err.message : `Sync failed: ${err.message}`;
    if (!(err instanceof AdapterError)) console.error(`[acc] sync ${row.name}:`, err);
    db.prepare("UPDATE integrations SET status = 'error', last_sync_at = ?, last_error = ? WHERE id = ?").run(nowIso(), message, id);
    if (row.status !== 'error') addEvent(id, 'connection', `${row.name} sync failed: ${message}`);
    notify({ kind: 'connection', severity: 'err', title: `${row.name} could not sync`, body: message, dedupe: `conn:${id}:${utcDay()}` });
    return { ok: false, error: message };
  }
}

async function tick() {
  const minutes = getSettings().sync_minutes;
  const due = db
    .prepare('SELECT id, adapter, last_sync_at FROM integrations WHERE enabled = 1')
    .all()
    .filter((r) => {
      const a = adapters[r.adapter];
      if (!a?.sync) return false;
      const every = a.kind === 'local' ? LOCAL_SYNC_MINUTES : minutes;
      return !r.last_sync_at || Date.now() - Date.parse(r.last_sync_at) >= every * 60_000 - 5_000;
    });
  for (const r of due) await syncIntegration(r.id);
  try {
    runDueAutomations();
  } catch (err) {
    console.error('[acc] automations:', err);
  }
  evaluateAlerts();
  try {
    maybePrune();
  } catch (err) {
    console.error('[acc] retention:', err);
  }
  maybeCheckForUpdate(getSettings());
  await maybeRefreshSummary();
  pruneSessions();
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('[acc] scheduler:', err));
  run();
  setInterval(run, 60_000).unref();
}
