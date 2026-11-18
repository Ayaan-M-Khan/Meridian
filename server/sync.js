import { db, tx, getSettings, addEvent, notify } from './db.js';
import { adapters } from './adapters/index.js';
import { decrypt } from './crypto.js';
import { evaluateAlerts } from './alerts.js';
import { maybeRefreshSummary } from './summary.js';
import { pruneSessions } from './auth.js';
import { AdapterError, addDays, nowIso, startOfUtcDay, startOfUtcMonth, utcDay } from './util.js';

const inFlight = new Map();

/** Pulls month-to-date usage (and the 8 days before today, for spike checks) and replaces the stored API rows. */
export function syncIntegration(id) {
  if (!inFlight.has(id)) inFlight.set(id, runSync(id).finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}

async function runSync(id) {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
  const adapter = adapters[row?.adapter];
  if (!row || !adapter?.sync) return { ok: false, error: 'This tool has nothing to sync.' };

  const monthStart = startOfUtcMonth();
  const eightDaysAgo = addDays(startOfUtcDay(), -8);
  const since = monthStart < eightDaysAgo ? monthStart : eightDaysAgo;

  try {
    const secret = decrypt(row.secret_enc, row.id);
    const { rows, dataRefreshedAt } = await adapter.sync({ secret, since });
    tx(() => {
      db.prepare("DELETE FROM usage_daily WHERE integration_id = ? AND source = 'api' AND day >= ?").run(id, utcDay(since));
      const ins = db.prepare(
        `INSERT INTO usage_daily(integration_id, day, model, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, cost_usd)
         VALUES(?, ?, ?, 'api', ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(id, r.day, r.model ?? '', r.input_tokens ?? null, r.output_tokens ?? null, r.cache_read_tokens ?? null,
          r.cache_write_tokens ?? null, r.requests ?? null, r.cost_usd ?? null);
      }
      db.prepare("UPDATE integrations SET status = 'ok', last_sync_at = ?, last_error = NULL, data_refreshed_at = ? WHERE id = ?").run(
        nowIso(), dataRefreshedAt ?? null, id);
    });
    if (row.status === 'error') addEvent(id, 'connection', `${row.name} reconnected`);
    return { ok: true, rows: rows.length };
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
    .filter((r) => adapters[r.adapter]?.sync && (!r.last_sync_at || Date.now() - Date.parse(r.last_sync_at) >= minutes * 60_000));
  for (const r of due) await syncIntegration(r.id);
  evaluateAlerts();
  await maybeRefreshSummary();
  pruneSessions();
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('[acc] scheduler:', err));
  run();
  setInterval(run, 60_000).unref();
}
