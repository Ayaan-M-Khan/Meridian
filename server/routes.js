import { db, tx, getSettings, setRaw, addEvent } from './db.js';
import { adapters, catalog } from './adapters/index.js';
import { encrypt, secretHint, sha256, randomToken } from './crypto.js';
import { syncIntegration } from './sync.js';
import { buildState, publicSettings } from './state.js';
import { demoState } from './demo.js';
import { refreshSummary, SUMMARY_KEY_AAD } from './summary.js';
import { evaluateAlerts } from './alerts.js';
import { parseUsage, upsertUsage } from './ingest.js';
import { AdapterError, HttpError, nowIso } from './util.js';

function getIntegration(id) {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'That tool no longer exists.');
  return row;
}

function cleanName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 80) throw new HttpError(400, 'Name must be 1–80 characters.');
  return v.trim();
}

function cleanBudget(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, 'Budget must be a dollar amount from 0 to 1,000,000.');
  return n || null;
}

function cleanSecret(v) {
  if (typeof v !== 'string' || v.trim().length < 8 || v.length > 500) throw new HttpError(400, 'Paste the full key.');
  return v.trim();
}

async function testSecret(adapter, secret) {
  if (!adapter.test) return null;
  try {
    return await adapter.test({ secret });
  } catch (err) {
    throw new HttpError(400, err instanceof AdapterError ? err.message : `Connection test failed: ${err.message}`);
  }
}

function setSecret(id, secret) {
  db.prepare('UPDATE integrations SET secret_enc = ?, secret_hint = ? WHERE id = ?').run(encrypt(secret, id), secretHint(secret), id);
}

function issueIngestToken(id) {
  const token = `acc_${randomToken(24)}`;
  db.prepare('UPDATE integrations SET ingest_hash = ? WHERE id = ?').run(sha256(token), id);
  return token;
}

export function apiRoutes(app) {
  app.get('/api/state', (req, res) => res.json(buildState()));
  app.get('/api/demo', (req, res) => res.json(demoState()));
  app.get('/api/catalog', (req, res) => res.json(catalog()));

  app.post('/api/integrations', async (req, res) => {
    const { adapter: adapterId, name, secret, budget_usd } = req.body ?? {};
    const adapter = adapters[adapterId];
    if (!adapter) throw new HttpError(400, 'Choose a tool from the list.');
    const clean = { name: cleanName(name ?? adapter.name), budget: cleanBudget(budget_usd) };
    let key = null;
    let test = null;
    if (adapter.credential) {
      key = cleanSecret(secret);
      test = await testSecret(adapter, key);
    }
    const id = tx(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO integrations(adapter, name, budget_usd, status, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(adapter.id, clean.name, clean.budget, adapter.sync ? 'pending' : 'tracked', nowIso());
      const newId = Number(lastInsertRowid);
      if (key) setSecret(newId, key);
      return newId;
    });
    const ingestToken = issueIngestToken(id);
    addEvent(id, 'connection', `${clean.name} was added`);
    if (adapter.sync) await syncIntegration(id);
    evaluateAlerts();
    refreshSummary().catch((err) => console.error('[acc] summary:', err));
    res.status(201).json({ id, ingest_token: ingestToken, test });
  });

  app.patch('/api/integrations/:id', async (req, res) => {
    const row = getIntegration(req.params.id);
    const body = req.body ?? {};
    if ('name' in body) db.prepare('UPDATE integrations SET name = ? WHERE id = ?').run(cleanName(body.name), row.id);
    if ('budget_usd' in body) db.prepare('UPDATE integrations SET budget_usd = ? WHERE id = ?').run(cleanBudget(body.budget_usd), row.id);
    if ('enabled' in body) db.prepare('UPDATE integrations SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, row.id);
    if ('secret' in body) {
      const adapter = adapters[row.adapter];
      if (!adapter?.credential) throw new HttpError(400, 'This tool does not use a key.');
      const key = cleanSecret(body.secret);
      await testSecret(adapter, key);
      setSecret(row.id, key);
      await syncIntegration(row.id);
    }
    evaluateAlerts();
    res.json({ ok: true });
  });

  app.delete('/api/integrations/:id', (req, res) => {
    const row = getIntegration(req.params.id);
    db.prepare('DELETE FROM integrations WHERE id = ?').run(row.id);
    refreshSummary().catch((err) => console.error('[acc] summary:', err));
    res.json({ ok: true });
  });

  app.post('/api/integrations/:id/sync', async (req, res) => {
    const row = getIntegration(req.params.id);
    const result = await syncIntegration(row.id);
    evaluateAlerts();
    res.json(result);
  });

  app.post('/api/integrations/:id/ingest-token', (req, res) => {
    const row = getIntegration(req.params.id);
    res.json({ ingest_token: issueIngestToken(row.id) });
  });

  app.post('/api/integrations/:id/manual-usage', (req, res) => {
    const row = getIntegration(req.params.id);
    const u = parseUsage(req.body ?? {}, 0);
    if ([u.input_tokens, u.output_tokens, u.requests, u.cost_usd].every((v) => v == null))
      throw new HttpError(400, 'Enter at least one of tokens, requests or cost.');
    upsertUsage(row.id, u, 'manual');
    evaluateAlerts();
    res.json({ ok: true });
  });

  app.post('/api/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
    res.json({ ok: true });
  });

  app.post('/api/notifications/:id/read', (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body ?? {};
    const s = getSettings();
    const intIn = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
      return n;
    };
    if ('usage_warn_pct' in body) s.usage_warn_pct = intIn(body.usage_warn_pct, 1, 99, 'Warning level');
    if ('monthly_ceiling_usd' in body) s.monthly_ceiling_usd = cleanBudget(body.monthly_ceiling_usd);
    if ('sync_minutes' in body) s.sync_minutes = intIn(body.sync_minutes, 5, 1440, 'Sync interval');
    if ('summary_interval_hours' in body) s.summary_interval_hours = intIn(body.summary_interval_hours, 1, 168, 'Summary interval');
    if ('spike_multiplier' in body) {
      const n = Number(body.spike_multiplier);
      if (!(n >= 1.2 && n <= 20)) throw new HttpError(400, 'Spike threshold must be between 1.2× and 20×.');
      s.spike_multiplier = n;
    }
    if (body.notify && typeof body.notify === 'object') {
      for (const k of Object.keys(s.notify)) if (k in body.notify) s.notify[k] = Boolean(body.notify[k]);
    }
    setRaw('settings', s);
    if ('summary_key' in body) {
      if (body.summary_key) {
        const key = cleanSecret(body.summary_key);
        setRaw('summary_key_enc', encrypt(key, SUMMARY_KEY_AAD));
        setRaw('summary_key_hint', secretHint(key));
      } else {
        setRaw('summary_key_enc', undefined);
        setRaw('summary_key_hint', undefined);
      }
    }
    evaluateAlerts();
    res.json(publicSettings());
  });

  app.post('/api/summary/refresh', async (req, res) => res.json(await refreshSummary()));
}
