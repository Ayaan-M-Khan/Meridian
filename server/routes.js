import { db, tx, getSettings, setRaw, addEvent } from './db.js';
import { adapters, catalog } from './adapters/index.js';
import { encrypt, secretHint, sha256, randomToken } from './crypto.js';
import { syncIntegration } from './sync.js';
import { buildState, publicSettings } from './state.js';
import { demoState, demoStats } from './demo.js';
import { refreshSummary, SUMMARY_KEY_AAD } from './summary.js';
import { evaluateAlerts } from './alerts.js';
import { parseUsage, upsertUsage } from './ingest.js';
import { AdapterError, HttpError, nowIso } from './util.js';
import { startClaudeTask, cancelClaudeTask, retryClaudeTask, followUpTask, runningCount } from './runner.js';
import { ToolInputError } from './assistant-tools.js';
import { chooseEngine, listEngines } from './engine-list.js';
import { LOCAL_ADAPTERS } from './adapters/local.js';
import { openConsole, forgetResolved } from './local/cli.js';
import { createThread, deleteThread, listThreads, sendMessage, stopThread, threadView } from './assistant.js';
import { ROLES, lineupView, startTeamTask, teamRunningCount } from './team.js';
import { makeBackup, restoreBackup } from './backup.js';
import { CATEGORIES, classify, routeTask } from './router.js';
import { buildStats } from './stats.js';
import { createAutomation, deleteAutomation, listAutomations, runAutomation, updateAutomation } from './automations.js';
import { checkForUpdate, installUpdate, updateView } from './updates.js';
import { APP_VERSION } from './version.js';
import { DATA_FLOWS, RETENTION_CHOICES, applySessionPrivacy, dataInventory, eraseEverything, pruneOldData } from './privacy.js';
import { issueSetupCode, verifyPassword } from './auth.js';

const ENGINE_CHOICES = ['auto', 'claude-code', 'codex', 'gemini-cli', 'antigravity-cli', 'copilot-cli', 'cursor-cli', 'claude-api'];

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
  app.get('/api/stats', (req, res) => res.json(buildStats()));
  app.get('/api/demo/stats', (req, res) => res.json(demoStats()));
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
    if (body.engine_models && typeof body.engine_models === 'object') {
      for (const [id, v] of Object.entries(body.engine_models)) {
        if (!LOCAL_ADAPTERS.some((a) => a.id === id)) throw new HttpError(400, 'Unknown AI app.');
        const m = typeof v === 'string' ? v.trim() : '';
        if (m && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/.test(m)) throw new HttpError(400, 'A model name has only letters, numbers, dots, dashes, slashes and colons.');
        if (m) s.engine_models[id] = m;
        else delete s.engine_models[id];
      }
    }
    if (body.route_prefs && typeof body.route_prefs === 'object') {
      for (const [kind, v] of Object.entries(body.route_prefs)) {
        if (!CATEGORIES[kind] || !ENGINE_CHOICES.includes(v)) throw new HttpError(400, 'Choose one of the listed AIs for each kind of task.');
        if (v === 'auto') delete s.route_prefs[kind];
        else s.route_prefs[kind] = v;
      }
    }
    if ('summary_mode' in body) {
      if (!['ai', 'rules'].includes(body.summary_mode)) throw new HttpError(400, 'The summary is written by AI or built from rules.');
      s.summary_mode = body.summary_mode;
    }
    if (body.desktop && typeof body.desktop === 'object') {
      for (const k of Object.keys(s.desktop)) if (k in body.desktop) s.desktop[k] = Boolean(body.desktop[k]);
    }
    let privacyChanged = false;
    if (body.privacy && typeof body.privacy === 'object') {
      const p = body.privacy;
      if ('retention_days' in p) {
        if (!RETENTION_CHOICES.includes(p.retention_days)) throw new HttpError(400, 'Choose how long to keep finished work from the list.');
        s.privacy.retention_days = p.retention_days;
      }
      for (const k of ['read_sessions', 'session_titles']) if (k in p) s.privacy[k] = Boolean(p[k]);
      privacyChanged = true;
    }
    if (body.team_roles && typeof body.team_roles === 'object') {
      for (const [role, v] of Object.entries(body.team_roles)) {
        if (!ROLES[role] || !ENGINE_CHOICES.includes(v)) throw new HttpError(400, 'Choose one of the listed AIs for each role.');
        s.team_roles[role] = v;
      }
    }
    if (body.notify && typeof body.notify === 'object') {
      for (const k of Object.keys(s.notify)) if (k in body.notify) s.notify[k] = Boolean(body.notify[k]);
    }
    setRaw('settings', s);
    if (body.desktop && typeof globalThis.accApplyDesktopSettings === 'function') globalThis.accApplyDesktopSettings(s.desktop);
    if (privacyChanged) {
      applySessionPrivacy(s.privacy);
      if (s.privacy.retention_days) pruneOldData(s.privacy.retention_days);
    }
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

  // ── Automations ──
  app.get('/api/automations', (req, res) => res.json(listAutomations()));
  app.post('/api/automations', (req, res) => res.status(201).json(createAutomation(req.body ?? {})));
  app.patch('/api/automations/:id', (req, res) => res.json(updateAutomation(req.params.id, req.body ?? {})));
  app.delete('/api/automations/:id', (req, res) => {
    deleteAutomation(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/automations/:id/run', (req, res) => res.json(runAutomation(req.params.id)));

  // ── Your data ──
  app.get('/api/privacy', (req, res) => res.json({ ...dataInventory(), flows: DATA_FLOWS, retention_choices: RETENTION_CHOICES, settings: getSettings().privacy, desktop_app: Boolean(globalThis.accDesktop) }));
  app.post('/api/privacy/open-folder', async (req, res) => {
    if (typeof globalThis.accOpenDataFolder !== 'function') throw new HttpError(501, 'Open the folder from your file manager.');
    await globalThis.accOpenDataFolder();
    res.json({ ok: true });
  });
  /** Erases everything after checking your password again. The app then starts over with a new setup code. */
  app.post('/api/privacy/erase', async (req, res) => {
    const { password, confirm } = req.body ?? {};
    if (confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || typeof password !== 'string' || !(await verifyPassword(password, row.pass_hash))) throw new HttpError(401, 'That password isn’t right.');
    const busy = runningCount() + teamRunningCount();
    if (busy) throw new HttpError(409, `${busy} task${busy === 1 ? ' is' : 's are'} running. Cancel ${busy === 1 ? 'it' : 'them'} first, then erase.`);
    eraseEverything();
    res.setHeader('Set-Cookie', 'acc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true, setup_code: issueSetupCode() });
  });

  // ── Updates ──
  app.get('/api/update', (req, res) => res.json(updateView()));
  app.post('/api/update/check', async (req, res) => {
    await checkForUpdate({ force: true });
    res.json(updateView());
  });
  app.post('/api/update/install', async (req, res) => res.json(await installUpdate({ busy: runningCount() + teamRunningCount() })));

  // ── Backups ──
  app.get('/api/backup', (req, res) => {
    const b = makeBackup(APP_VERSION);
    res.setHeader('Content-Disposition', `attachment; filename="ai-command-center-backup-${b.exported_at.slice(0, 10)}.json"`);
    res.json(b);
  });
  app.post('/api/restore', (req, res) => {
    const counts = restoreBackup(req.body);
    evaluateAlerts();
    // Tools that read their data again on their own catch up now instead of on the next tick.
    for (const r of db.prepare('SELECT id, adapter FROM integrations WHERE enabled = 1').all()) {
      if (adapters[r.adapter]?.kind === 'local') syncIntegration(r.id).catch(() => {});
    }
    res.json({ ok: true, ...counts });
  });

  // ── Tasks ──
  app.get('/api/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT id, description, result, detail FROM tasks WHERE id = ?').get(Number(req.params.id));
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const progress = db.prepare('SELECT at, progress FROM task_progress WHERE task_id = ? ORDER BY at').all(t.id);
    let detail = null;
    try {
      detail = t.detail ? JSON.parse(t.detail) : null;
    } catch {
      detail = null;
    }
    res.json({ id: t.id, description: t.description, result: t.result, detail, progress });
  });

  // ── AI team ──
  app.get('/api/team', (req, res) => res.json({ lineup: lineupView({ folder: req.query.folder === '1', text: typeof req.query.text === 'string' && req.query.text.trim() ? req.query.text.slice(0, 4000) : null }) }));

  /** Where a request would go, for the live hint under the command bar. Costs nothing: no AI is asked. */
  app.post('/api/route', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 4000) : '';
    if (!text.trim()) return res.json(null);
    const kind = classify(text);
    if (req.body?.mode === 'team') return res.json({ ...kind, lineup: lineupView({ text }) });
    if ((getSettings().assistant_engine ?? 'auto') !== 'auto') return res.json({ ...kind, fixed: true });
    const r = routeTask(text, { needsTools: true });
    res.json(r && { category: r.category, label: r.label, why: r.why, engine: { id: r.engine.id, label: r.engine.label, vendor: r.engine.vendor } });
  });
  app.post('/api/team-tasks', (req, res) => {
    const t = startTeamTask({ goal: req.body?.goal, folder: req.body?.folder, mode: req.body?.mode ?? 'team' });
    res.status(201).json({ id: t.id, status: t.status, lineup: t.lineup, mode: t.mode });
  });
  /** The desktop app sets globalThis.accPickFolder to show a native folder picker. */
  app.post('/api/pick-folder', async (req, res) => {
    if (typeof globalThis.accPickFolder !== 'function') throw new HttpError(501, 'Type or paste the folder’s full path.');
    res.json({ path: (await globalThis.accPickFolder()) ?? null });
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
  app.post('/api/tasks/:id/follow-up', (req, res) => {
    try {
      res.status(201).json(followUpTask(Number(req.params.id), req.body?.text));
    } catch (err) {
      if (err instanceof ToolInputError) throw new HttpError(400, err.message);
      throw err;
    }
  });

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
