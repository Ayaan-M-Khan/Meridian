import { db, getSettings, getRaw } from './db.js';
import { adapters } from './adapters/index.js';
import { estimate, pastDurations, progressHistory } from './eta.js';
import { listEngines } from './engine-list.js';
import { ROLES, lineupView, teamView } from './team.js';
import { lastNDays, nowIso, rowTokens, startOfUtcMonth, sumField, sumNullable, utcDay } from './util.js';

const ACTIVE_WINDOW_MS = 15 * 60_000;

const sumTokens = (rows) => sumNullable(rows.map(rowTokens));
const parseMeta = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

export function publicSettings() {
  const enc = getRaw('summary_key_enc');
  return { ...getSettings(), summary_key_set: Boolean(enc), summary_key_hint: getRaw('summary_key_hint') ?? null };
}

/** The assistant engines and which one is in use, as the UI shows them. */
export function engineState(settings = getSettings()) {
  const engines = listEngines();
  const want = settings.assistant_engine ?? 'auto';
  const current = want === 'auto' ? engines.find((e) => e.ready) ?? null : engines.find((e) => e.id === want && e.ready) ?? null;
  return { engines, engine: current, engine_choice: want };
}

/** One task as the UI and the assistant see it, with its finish estimate and the controls this app can offer. */
export function taskViewOf(t, history, durations, adapterOf, now = new Date()) {
  const builtin = adapterOf.get(t.integration_id) === 'claude-assistant';
  const session = t.kind === 'session';
  // An interactive CLI session has no set end, so it never gets a finish estimate.
  const est = session
    ? estimate({ ...t, status: 'completed' })
    : estimate(t, history.get(t.id) ?? [], durations.get(`${t.integration_id}|${t.name}`) ?? [], now.getTime());
  return {
    id: t.id,
    integration_id: t.integration_id,
    tool_name: t.tool_name,
    external_id: t.external_id,
    name: t.name,
    description: t.description,
    status: t.status,
    progress: t.progress,
    step: t.step ?? null,
    started_at: t.started_at,
    eta: t.eta,
    ...est,
    scheduled_for: t.scheduled_for,
    finished_at: t.finished_at,
    error: t.error,
    has_result: Boolean(t.result),
    updated_at: t.updated_at,
    kind: session ? 'session' : t.kind === 'team' ? 'team' : 'task',
    runner: builtin ? t.runner ?? 'claude-api' : null,
    runner_label: !builtin ? null : t.runner === 'team' ? 'AI team' : adapters[t.runner]?.engine?.label ?? 'Claude API',
    team: t.kind === 'team' ? teamView(t) : null,
    controls: !builtin ? [] : t.status === 'running' || t.status === 'queued' ? ['cancel'] : ['retry'],
  };
}

/** Everything the UI renders, in one payload. The demo payload (demo.js) has the same shape. */
export function buildState(now = new Date()) {
  const settings = getSettings();
  const today = utcDay(now);
  const monthStart = utcDay(startOfUtcMonth(now));
  const days = lastNDays(30, now);
  const from = days[0] < monthStart ? days[0] : monthStart;

  const ints = db.prepare('SELECT * FROM integrations ORDER BY id').all();
  const usage = db.prepare('SELECT * FROM usage_daily WHERE day >= ?').all(from);
  const tasks = db
    .prepare(`SELECT t.*, i.name AS tool_name FROM tasks t JOIN integrations i ON i.id = t.integration_id ORDER BY t.updated_at DESC LIMIT 500`)
    .all();
  const feed = db
    .prepare(`SELECT e.id, e.kind, e.message, e.created_at, i.name AS tool_name FROM events e LEFT JOIN integrations i ON i.id = e.integration_id ORDER BY e.id DESC LIMIT 40`)
    .all();
  const notifications = db.prepare('SELECT id, kind, severity, title, body, read, created_at FROM notifications ORDER BY id DESC LIMIT 100').all();

  const history = progressHistory(tasks.filter((t) => t.status === 'running' && t.kind !== 'session').map((t) => t.id));
  const durations = pastDurations(tasks.filter((t) => t.kind !== 'session'));
  const adapterOf = new Map(ints.map((i) => [i.id, i.adapter]));

  const tools = ints.map((i) => {
    const a = adapters[i.adapter];
    const rows = usage.filter((r) => r.integration_id === i.id);
    const mtd = rows.filter((r) => r.day >= monthStart);
    const td = rows.filter((r) => r.day === today);
    const own = tasks.filter((t) => t.integration_id === i.id);
    const running = own.find((t) => t.status === 'running');
    const lastTask = own[0];
    const lastUsageDay = rows.filter((r) => (rowTokens(r) ?? 0) > 0 || (r.requests ?? 0) > 0).map((r) => r.day).sort().pop() ?? null;
    const costMtd = sumField(mtd, 'cost_usd');
    const meta = parseMeta(i.meta);
    const sessionsRunning = own.filter((t) => t.kind === 'session' && t.status === 'running').length;
    return {
      id: i.id,
      name: i.name,
      adapter: i.adapter,
      adapter_name: a?.name ?? i.adapter,
      vendor: a?.vendor ?? 'Unknown',
      kind: a?.kind ?? 'manual',
      account: meta?.account ?? null,
      account_kind: a?.account ?? null,
      version: meta?.version ?? null,
      limits: meta?.limits ?? null,
      engine: a?.engine ? { id: a.id, label: a.engine.label, via: a.engine.via } : null,
      replaced_by: a?.replacedBy ? { id: a.replacedBy, name: adapters[a.replacedBy]?.name ?? a.replacedBy } : null,
      cli: a?.cli ? { install: a.cli.install.text, install_url: a.cli.install.url, login: a.cli.login.text, login_help: a.cli.login.help } : null,
      sessions_running: sessionsRunning,
      can_sync: Boolean(a?.sync),
      enabled: Boolean(i.enabled),
      status: !i.enabled ? 'disabled' : a?.sync ? i.status : 'tracked',
      last_sync_at: i.last_sync_at,
      last_error: i.last_error,
      data_refreshed_at: i.data_refreshed_at,
      secret_hint: i.secret_hint,
      has_ingest: Boolean(i.ingest_hash),
      capabilities: a?.capabilities ?? {},
      notes: a?.notes ?? [],
      active: Boolean(running) || Boolean(lastTask && now - Date.parse(lastTask.updated_at) < ACTIVE_WINDOW_MS),
      current_activity: running?.name ?? null,
      last_activity_at: lastTask?.updated_at ?? null,
      last_usage_day: lastUsageDay,
      cost_mtd: costMtd,
      cost_today: sumField(td, 'cost_usd'),
      tokens_mtd: sumTokens(mtd),
      tokens_today: sumTokens(td),
      input_tokens_mtd: sumField(mtd, 'input_tokens'),
      output_tokens_mtd: sumField(mtd, 'output_tokens'),
      requests_mtd: sumField(mtd, 'requests'),
      budget_usd: i.budget_usd,
      budget_pct: i.budget_usd > 0 && costMtd != null ? (costMtd / i.budget_usd) * 100 : null,
    };
  });

  const enabled = tools.filter((t) => t.enabled);
  const enabledIds = new Set(enabled.map((t) => t.id));
  // The assistant's own Claude requests are also in an Anthropic Admin integration's figures; count them once.
  const hasAnthropicApi = enabled.some((t) => t.adapter === 'anthropic');
  const counted = enabled.filter((t) => !(hasAnthropicApi && t.adapter === 'claude-assistant'));
  const isToday = (iso) => iso?.startsWith(today);
  const count = (status) => tasks.filter((t) => t.status === status && enabledIds.has(t.integration_id)).length;

  const stats = {
    connected: enabled.length,
    active: enabled.filter((t) => t.active).length,
    needs_attention: enabled.filter((t) => t.status === 'error').length,
    running: count('running'),
    queued: count('queued'),
    scheduled: count('scheduled'),
    completed_today: tasks.filter((t) => t.status === 'completed' && t.kind !== 'session' && isToday(t.finished_at)).length,
    failed_today: tasks.filter((t) => t.status === 'failed' && isToday(t.finished_at)).length,
    sessions_running: tasks.filter((t) => t.kind === 'session' && t.status === 'running' && enabledIds.has(t.integration_id)).length,
    cost_today: sumNullable(enabled.map((t) => t.cost_today)),
    cost_mtd: sumNullable(enabled.map((t) => t.cost_mtd)),
    tokens_today: sumNullable(counted.map((t) => t.tokens_today)),
    tokens_mtd: sumNullable(counted.map((t) => t.tokens_mtd)),
    requests_mtd: sumNullable(counted.map((t) => t.requests_mtd)),
    tools_reporting_cost: enabled.filter((t) => t.cost_mtd != null).length,
    ceiling_usd: settings.monthly_ceiling_usd,
  };

  const series = enabled
    .map((t) => {
      const rows = usage.filter((r) => r.integration_id === t.id);
      return {
        id: t.id,
        name: t.name,
        cost: days.map((d) => sumField(rows.filter((r) => r.day === d), 'cost_usd')),
        tokens: days.map((d) => sumTokens(rows.filter((r) => r.day === d))),
      };
    })
    .filter((s) => s.cost.some((v) => v != null) || s.tokens.some((v) => v != null));

  const models = new Map();
  for (const r of usage) {
    if (r.day < monthStart || !r.model || !enabledIds.has(r.integration_id)) continue;
    const m = models.get(r.model) ?? { model: r.model, tokens: null, cost_usd: null, requests: null };
    m.tokens = sumNullable([m.tokens, rowTokens(r)]);
    m.cost_usd = sumNullable([m.cost_usd, r.cost_usd]);
    m.requests = sumNullable([m.requests, r.requests]);
    models.set(r.model, m);
  }

  const taskView = tasks.map((t) => taskViewOf(t, history, durations, adapterOf, now));

  const upcoming = taskView
    .filter((t) => (t.status === 'scheduled' || t.status === 'queued') && enabledIds.has(t.integration_id))
    .sort((a, b) => (a.scheduled_for ?? '9999').localeCompare(b.scheduled_for ?? '9999'));

  return {
    demo: false,
    generated_at: nowIso(),
    stats,
    tools,
    usage: { days, series, by_model: [...models.values()].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)) },
    tasks: taskView,
    upcoming,
    feed,
    notifications,
    unread: notifications.filter((n) => !n.read).length,
    summary: getRaw('summary_cache') ?? null,
    settings: publicSettings(),
    ...engineState(settings),
    team: { lineup: lineupView({ settings }), roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { title: r.title, does: r.does }])) },
  };
}
