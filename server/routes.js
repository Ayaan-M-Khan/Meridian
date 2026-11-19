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
import { startClaudeTask, cancelClaudeTask, retryClaudeTask } from './runner.js';
import { ToolInputError } from './assistant-tools.js';
import { chooseEngine, listEngines } from './engine-list.js';
import { LOCAL_ADAPTERS } from './adapters/local.js';
import { openConsole, forgetResolved } from './local/cli.js';
import { createThread, deleteThread, listThreads, sendMessage, stopThread, threadView } from './assistant.js';

const ENGINE_CHOICES = ['auto', 'claude-code', 'codex', 'gemini-cli', 'claude-api'];

function localAdapter(id) {
  const a = LOCAL_ADAPTERS.find((x) => x.id === id);
  if (!a) throw new HttpError(404, 'That app isn’t supported.');
  return a;
}

const connectedRow = (adapterId) => db.prepare('SELECT * FROM integrations WHERE adapter = ? ORDER BY id LIMIT 1').get(adapterId);

/** What the add-tool screen and the sidebar need to know about an app on this computer. */
async function localView(a, { fresh = false } = {}) {
  const st = await a.status({ fresh });
  const row = connectedRow(a.id);
  return {
    id: a.id,
    name: a.name,
    vendor: a.vendor,
    account_kind: a.account,
    installed: st.installed,
    signed_in: st.signed_in,
    version: st.version,
    account: st.account,
    detail: st.detail,
    install: a.cli.install.text,
    install_url: a.cli.install.url,
    login: a.cli.login.text,
    login_help: a.cli.login.help,
    connected_id: row?.id ?? null,
  };
}

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
  app.get('/api/engines', (req, res) => res.json(listEngines()));

  // ── Apps on this computer, signed in with your account ──
  app.get('/api/local', async (req, res) => {
    const fresh = req.query.fresh === '1';
    if (fresh) forgetResolved();
    res.json(await Promise.all(LOCAL_ADAPTERS.map((a) => localView(a, { fresh }))));
  });

  /** Checks the app again (after signing in or installing) and refreshes its connection. */
  app.post('/api/local/:adapter/check', async (req, res) => {
    const a = localAdapter(req.params.adapter);
    forgetResolved();
    a.forgetStatus();
    const view = await localView(a, { fresh: true });
    if (view.connected_id) {
      await syncIntegration(view.connected_id);
      evaluateAlerts();
    }
    res.json(view);
  });

  /** Opens the app's own sign-in in a console window. It signs in with your account in the browser. */
  app.post('/api/local/:adapter/login', async (req, res) => {
    const a = localAdapter(req.params.adapter);
    const cli = a.resolve();
    if (!cli) throw new HttpError(400, `${a.name} isn’t installed yet. Install it first.`);
    a.forgetStatus();
    const opened = openConsole(cli.command, [...cli.prefix, ...a.cli.login.args], { title: `Sign in to ${a.name}` });
    res.json({ opened, command: a.cli.login.text, help: a.cli.login.help });
  });

  app.post('/api/local/:adapter/install', async (req, res) => {
    const a = localAdapter(req.params.adapter);
    const { command, args, text } = a.cli.install;
    const opened = openConsole(command, args, { title: `Installing ${a.name}` });
    res.json({ opened, command: text });
  });

  app.post('/api/integrations', async (req, res) => {
    const { adapter: adapterId, name, secret, budget_usd } = req.body ?? {};
    const adapter = adapters[adapterId];
    if (!adapter || adapter.kind === 'builtin') throw new HttpError(400, 'Choose a tool from the list.');
    if (adapter.kind === 'local' && connectedRow(adapter.id)) throw new HttpError(409, `${adapter.name} is already connected. It’s in the sidebar.`);
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
    // Local apps report on their own; they don't take task reports from scripts, so they get no ingest token.
    const ingestToken = adapter.kind === 'local' ? null : issueIngestToken(id);
    addEvent(id, 'connection', `${clean.name} was added`);
    let sync = null;
    if (adapter.sync) sync = await syncIntegration(id);
    evaluateAlerts();
    refreshSummary().catch((err) => console.error('[acc] summary:', err));
    res.status(201).json({ id, ingest_token: ingestToken, test, status: sync?.status ?? null });
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
    if ('assistant_web_search' in body) s.assistant_web_search = Boolean(body.assistant_web_search);
    if ('assistant_engine' in body) {
      if (!ENGINE_CHOICES.includes(body.assistant_engine)) throw new HttpError(400, 'Choose one of the listed assistants.');
      s.assistant_engine = body.assistant_engine;
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

  // ── Tasks ──
  app.get('/api/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT id, description, result FROM tasks WHERE id = ?').get(Number(req.params.id));
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const progress = db.prepare('SELECT at, progress FROM task_progress WHERE task_id = ? ORDER BY at').all(t.id);
    res.json({ ...t, progress });
  });

  app.post('/api/claude-tasks', (req, res) => {
    const { name, instructions } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new HttpError(400, 'Give the task a name of 1–80 characters.');
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 2000) throw new HttpError(400, 'Write the instructions, up to 2,000 characters.');
    const t = startClaudeTask({ name: name.trim(), instructions: instructions.trim() });
    res.status(201).json({ id: t.id, status: t.status, runner: t.runner });
  });

  const control = (fn) => (req, res) => {
    try {
      res.json(fn(Number(req.params.id)));
    } catch (err) {
      if (err instanceof ToolInputError) throw new HttpError(400, err.message);
      throw err;
    }
  };
  app.post('/api/tasks/:id/cancel', control(cancelClaudeTask));
  app.post('/api/tasks/:id/retry', control(retryClaudeTask));

  // ── Assistant ──
  app.get('/api/assistant/threads', (req, res) => res.json(listThreads()));
  app.post('/api/assistant/threads', (req, res) => res.status(201).json(createThread()));
  app.get('/api/assistant/threads/:id', (req, res) => res.json(threadView(req.params.id)));
  app.delete('/api/assistant/threads/:id', (req, res) => {
    deleteThread(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/assistant/threads/:id/stop', (req, res) => {
    stopThread(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/assistant/threads/:id/messages', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Type a message first.');
    if (text.length > 8000) throw new HttpError(400, 'Keep messages under 8,000 characters.');
    threadView(req.params.id); // 404 before streaming starts
    const engine = req.body?.engine;
    if (engine != null && !ENGINE_CHOICES.includes(engine)) throw new HttpError(400, 'Choose one of the listed assistants.');
    chooseEngine(engine ?? undefined); // a readable error before streaming starts when nothing is ready
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const emit = (ev) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(ev)}\n`);
    };
    try {
      await sendMessage(req.params.id, text.trim(), emit, { engine: engine ?? undefined });
    } catch (err) {
      emit({ type: 'error', message: err instanceof HttpError ? err.message : 'Something went wrong on the server.', unsent: text });
      if (!(err instanceof HttpError)) console.error('[acc] assistant:', err);
    }
    res.end();
  });
}
