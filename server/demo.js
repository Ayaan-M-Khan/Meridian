import { adapters } from './adapters/index.js';
import { DEFAULT_SETTINGS } from './db.js';
import { lastNDays, startOfUtcMonth, utcDay } from './util.js';

/** Sample statistics in the same shape as buildStats(), for demo mode. */
export function demoStats(now = new Date()) {
  const days = lastNDays(30, now);
  const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
  const daily = days.map((day, i) => ({ day, tokens: Math.round((4 + 2.4 * Math.sin(i / 2.2) + (i % 4)) * 1_100_000), requests: 60 + ((i * 17) % 45) }));
  const busiest = daily.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  return {
    demo: true,
    generated_at: now.toISOString(),
    totals: { tokens_mtd: 167_500_000, requests_mtd: 40_016, runs_mtd: 46, success_pct: 91.3, team_runs: 9, team_median_ms: 11 * 60_000, busiest_day: busiest },
    share: [
      { id: 7, name: 'Claude Code', adapter: 'claude-code', vendor: 'Anthropic', tokens: 96_200_000, share: 57.4 },
      { id: 8, name: 'Codex', adapter: 'codex', vendor: 'OpenAI', tokens: 31_400_000, share: 18.7 },
      { id: 1, name: 'Claude API', adapter: 'anthropic', vendor: 'Anthropic', tokens: 22_100_000, share: 13.2 },
      { id: 2, name: 'OpenAI API', adapter: 'openai', vendor: 'OpenAI', tokens: 12_600_000, share: 7.5 },
      { id: 3, name: 'Nightly research agent', adapter: 'custom-agent', vendor: 'Your own', tokens: 5_200_000, share: 3.1 },
    ],
    cache: [
      { id: 7, name: 'Claude Code', adapter: 'claude-code', vendor: 'Anthropic', cache_pct: 96.8, cache_read: 88_900_000 },
      { id: 8, name: 'Codex', adapter: 'codex', vendor: 'OpenAI', cache_pct: 61.2, cache_read: 17_300_000 },
      { id: 1, name: 'Claude API', adapter: 'anthropic', vendor: 'Anthropic', cache_pct: 42.5, cache_read: 8_100_000 },
    ],
    daily,
    performance: [
      { id: 'claude-code', label: 'Claude Code', vendor: 'Anthropic', runs: 24, ok: 23, failed: 1, reviews: 2, approved: 2, reviewed: 9, passed: 7, success_pct: 95.8, median_ms: 4.2 * 60_000, passed_review_pct: 77.8 },
      { id: 'codex', label: 'Codex', vendor: 'OpenAI', runs: 19, ok: 18, failed: 1, reviews: 9, approved: 7, reviewed: 0, passed: 0, success_pct: 94.7, median_ms: 2.1 * 60_000, passed_review_pct: null },
      { id: 'copilot-cli', label: 'GitHub Copilot', vendor: 'GitHub', runs: 8, ok: 8, failed: 0, reviews: 0, approved: 0, reviewed: 0, passed: 0, success_pct: 100, median_ms: 40_000, passed_review_pct: null },
      { id: 'gemini-cli', label: 'Gemini CLI', vendor: 'Google', runs: 3, ok: 0, failed: 3, reviews: 0, approved: 0, reviewed: 0, passed: 0, success_pct: 0, median_ms: null, passed_review_pct: null },
    ],
    asks: {
      total: 58,
      by_category: [
        { category: 'code', label: 'Coding', count: 21 }, { category: 'writing', label: 'Writing', count: 13 }, { category: 'planning', label: 'Planning', count: 9 },
        { category: 'debug', label: 'Debugging', count: 7 }, { category: 'quick', label: 'Quick question', count: 5 }, { category: 'research', label: 'Research', count: 3 },
      ],
      by_engine: [
        { id: 'claude-code', label: 'Claude Code', vendor: 'Anthropic', count: 31 }, { id: 'codex', label: 'Codex', vendor: 'OpenAI', count: 17 }, { id: 'copilot-cli', label: 'GitHub Copilot', vendor: 'GitHub', count: 10 },
      ],
    },
    recent_routes: [
      { at: ago(12), kind: 'chat', category: 'Debugging', engine: 'claude-code', engine_label: 'Claude Code', why: 'Debugging: Claude Code is one of the strongest for debugging.', preview: 'Why does the invoice export crash on empty rows?' },
      { at: ago(55), kind: 'team', category: 'Planning', engine: 'claude-code', engine_label: 'Claude Code', why: 'Planning: Codex plans, Claude Code builds, Codex reviews, GitHub Copilot debugs.', preview: 'Plan and build the onboarding checklist' },
      { at: ago(130), kind: 'chat', category: 'Quick question', engine: 'copilot-cli', engine_label: 'GitHub Copilot', why: 'Quick question: GitHub Copilot is one of the strongest for quick answers.', preview: 'What does HTTP 429 mean?' },
      { at: ago(300), kind: 'task', category: 'Planning', engine: 'claude-code', engine_label: 'Claude Code', why: 'Planning: Claude Code is good at planning. Skipped Codex: 91% of its plan limit used.', preview: 'Draft the Q3 roadmap' },
    ],
  };
}

/** Sample data in the same shape as buildState(). Every payload carries demo: true and the UI labels it. */
export function demoState(now = new Date()) {
  const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
  const ahead = (min) => new Date(now.getTime() + min * 60_000).toISOString();
  const days = lastNDays(30, now);
  const monthStart = utcDay(startOfUtcMonth(now));
  const wave = (base, amp, i, seed) => Math.max(0, base + amp * Math.sin(i / 2.3 + seed) + ((i * 7 + seed * 13) % 5) * amp * 0.15);

  const claudeCost = days.map((_, i) => +wave(3.1, 1.4, i, 1).toFixed(2));
  const openaiCost = days.map((_, i) => +wave(2.2, 0.9, i, 2).toFixed(2));
  const agentCost = days.map((_, i) => +wave(0.6, 0.3, i, 3).toFixed(2));
  claudeCost[29] = null; // today is not reported yet by the provider
  const tokensOf = (costs, perDollar) => costs.map((c) => (c == null ? null : Math.round(c * perDollar)));
  const mtd = (arr) => arr.reduce((a, v, i) => (days[i] >= monthStart && v != null ? a + v : a), 0);

  const base = (id, adapter, name, extra) => ({
    id, adapter, name,
    adapter_name: adapters[adapter].name,
    vendor: adapters[adapter].vendor,
    kind: adapters[adapter].kind,
    account: null,
    account_kind: adapters[adapter].account ?? null,
    version: null,
    limits: null,
    engine: adapters[adapter].engine ? { id: adapter, label: adapters[adapter].engine.label, via: adapters[adapter].engine.via, model: null, model_hint: adapters[adapter].engine.modelHint ?? null } : null,
    replaced_by: null,
    cli: adapters[adapter].cli
      ? { install: adapters[adapter].cli.install.text, install_url: adapters[adapter].cli.install.url, login: adapters[adapter].cli.login.text, login_help: adapters[adapter].cli.login.help }
      : null,
    sessions_running: 0,
    can_sync: Boolean(adapters[adapter].sync),
    enabled: true,
    capabilities: adapters[adapter].capabilities,
    notes: adapters[adapter].notes,
    has_ingest: adapters[adapter].kind !== 'local',
    last_error: null, data_refreshed_at: null, secret_hint: null, last_sync_at: null,
    active: false, current_activity: null, last_activity_at: null, last_usage_day: null,
    cost_mtd: null, cost_today: null, tokens_mtd: null, tokens_today: null,
    input_tokens_mtd: null, output_tokens_mtd: null, requests_mtd: null, budget_usd: null, budget_pct: null,
    ...extra,
  });

  const claudeMtd = mtd(claudeCost), openaiMtd = mtd(openaiCost), agentMtd = mtd(agentCost);
  const ccTokens = days.map((_, i) => Math.round(wave(5.2, 2.6, i, 4) * 1_000_000));
  const cxTokens = days.map((_, i) => (i % 3 === 0 ? null : Math.round(wave(1.4, 0.8, i, 5) * 1_000_000)));
  const sumMtd = (arr) => arr.reduce((a, v, i) => (days[i] >= monthStart && v != null ? a + v : a), 0);
  const tools = [
    base(7, 'claude-code', 'Claude Code', {
      status: 'ok', last_sync_at: ago(1), data_refreshed_at: ago(1), version: '2.1.96',
      account: { email: 'you@example.com', plan: 'max', method: 'claude.ai', org: null },
      active: true, current_activity: 'Refactor billing module', last_activity_at: ago(1), last_usage_day: days[29], sessions_running: 1,
      tokens_mtd: sumMtd(ccTokens), tokens_today: ccTokens[29], input_tokens_mtd: Math.round(sumMtd(ccTokens) * 0.02), output_tokens_mtd: Math.round(sumMtd(ccTokens) * 0.03),
      requests_mtd: Math.round(sumMtd(ccTokens) / 90_000),
    }),
    base(8, 'codex', 'Codex', {
      status: 'ok', last_sync_at: ago(1), data_refreshed_at: ago(1), version: '0.58.0',
      account: { email: null, plan: null, method: 'ChatGPT', org: null },
      limits: { primary: { used_percent: 38, window_minutes: 300, resets_at: ahead(130) }, secondary: { used_percent: 61, window_minutes: 10080, resets_at: ahead(60 * 52) }, plan: 'plus', observed_at: ago(25) },
      last_activity_at: ago(25), last_usage_day: days[28],
      tokens_mtd: sumMtd(cxTokens), tokens_today: null, requests_mtd: Math.round(sumMtd(cxTokens) / 60_000),
    }),
    base(1, 'anthropic', 'Claude API', {
      status: 'ok', secret_hint: 'sk-ant-…8f2c', last_sync_at: ago(12), data_refreshed_at: ago(190),
      active: true, current_activity: 'Summarize support tickets', last_activity_at: ago(2), last_usage_day: days[28],
      cost_mtd: claudeMtd, cost_today: null, tokens_mtd: Math.round(claudeMtd * 210_000), tokens_today: null,
      input_tokens_mtd: Math.round(claudeMtd * 170_000), output_tokens_mtd: Math.round(claudeMtd * 40_000), requests_mtd: Math.round(claudeMtd * 260),
      budget_usd: 150, budget_pct: (claudeMtd / 150) * 100,
    }),
    base(2, 'openai', 'OpenAI API', {
      status: 'ok', secret_hint: 'sk-admi…41aa', last_sync_at: ago(9),
      active: true, current_activity: 'Classify inbound leads', last_activity_at: ago(4), last_usage_day: days[29],
      cost_mtd: openaiMtd, cost_today: openaiCost[29], tokens_mtd: Math.round(openaiMtd * 380_000), tokens_today: Math.round(openaiCost[29] * 380_000),
      input_tokens_mtd: Math.round(openaiMtd * 300_000), output_tokens_mtd: Math.round(openaiMtd * 80_000), requests_mtd: Math.round(openaiMtd * 410),
      budget_usd: Math.max(10, Math.round(openaiMtd / 0.82)), budget_pct: 82,
    }),
    base(3, 'custom-agent', 'Nightly research agent', {
      status: 'tracked', active: true, current_activity: 'Weekly competitor digest', last_activity_at: ago(1), last_usage_day: days[29],
      cost_mtd: agentMtd, cost_today: agentCost[29], tokens_mtd: Math.round(agentMtd * 250_000), tokens_today: Math.round(agentCost[29] * 250_000),
      requests_mtd: Math.round(agentMtd * 90),
    }),
    base(4, 'cursor-cli', 'Cursor', { status: 'signin', account: null }),
    base(5, 'copilot-cli', 'GitHub Copilot', { status: 'ok', version: '1.0.2', account: { email: null, user: 'octo-dev', plan: null, method: 'GitHub account', org: null }, last_sync_at: ago(1) }),
    base(6, 'anthropic', 'Claude API (side project)', {
      status: 'error', secret_hint: 'sk-ant-…09bd', last_sync_at: ago(31),
      last_error: 'Anthropic rejected the key. Use an Admin API key (sk-ant-admin…); regular API keys cannot read usage.',
    }),
  ];

  const T = (id, tool, name, status, extra = {}) => ({
    id, integration_id: tool, tool_name: tools.find((t) => t.id === tool).name, external_id: `demo-${id}`, name, status,
    description: null, progress: null, step: null, started_at: null, eta: null,
    eta_at: null, eta_source: null, stalled: false, overdue: false, longer_than_usual: false, typical_ms: null,
    scheduled_for: null, finished_at: null, error: null, has_result: false,
    updated_at: ago(5), kind: 'task', runner: null, runner_label: null, team: null, controls: [], ...extra,
  });
  const stage = (key, label, role, engine, engine_label, status, extra = {}) => ({ key, label, role, engine, engine_label, status, started_at: null, finished_at: null, verdict: undefined, note: undefined, error: undefined, ...extra });
  const tasks = [
    T(12, 7, 'Landing page copy for the billing launch', 'running', {
      kind: 'team', runner: 'team', runner_label: 'AI team', controls: ['cancel'], progress: 58, step: 'Reviewing · Codex', started_at: ago(9), eta_at: ahead(6), eta_source: 'progress', updated_at: ago(1),
      description: 'Write landing page copy for the new billing feature: a headline, three benefit sections and an FAQ.',
      team: { folder: null, stages: [
        stage('plan', 'Plan', 'planner', 'codex', 'Codex', 'done', { started_at: ago(9), finished_at: ago(8) }),
        stage('build', 'Build', 'builder', 'claude-code', 'Claude Code', 'done', { started_at: ago(8), finished_at: ago(2) }),
        stage('review', 'Review', 'reviewer', 'codex', 'Codex', 'running', { started_at: ago(2) }),
        stage('debug', 'Debug', 'debugger', 'gemini-cli', 'Gemini CLI', 'pending'),
        stage('fix', 'Fix', 'builder', 'claude-code', 'Claude Code', 'pending'),
        stage('check', 'Final check', 'reviewer', 'codex', 'Codex', 'pending'),
      ] },
    }),
    T(10, 7, 'Refactor billing module', 'running', { kind: 'session', description: 'in billing-service · claude-opus-5-5 · 3,412,880 tokens', started_at: ago(42), updated_at: ago(1) }),
    T(11, 8, 'Write migration for invoices table', 'completed', { kind: 'session', description: 'in billing-service · gpt-5-codex · 812,400 tokens', started_at: ago(70), finished_at: ago(25), updated_at: ago(25) }),
    T(1, 3, 'Weekly competitor digest', 'running', { description: 'Collect pricing pages from 14 competitors and summarize changes since last week.', progress: 64, step: 'Comparing pricing pages', started_at: ago(18), eta: ahead(9), eta_at: ahead(9), eta_source: 'reported', updated_at: ago(1) }),
    T(2, 1, 'Summarize support tickets', 'running', { description: 'Group yesterday’s 212 tickets by theme and draft a summary for the support lead.', progress: 30, started_at: ago(6), eta_at: ahead(14), eta_source: 'progress', updated_at: ago(2) }),
    T(3, 2, 'Classify inbound leads', 'running', { description: 'Score new sign-ups by company size and intent.', progress: 45, started_at: ago(50), stalled: true, typical_ms: 30 * 60_000, longer_than_usual: true, updated_at: ago(24) }),
    T(4, 3, 'Draft monthly usage report', 'scheduled', { scheduled_for: ahead(48), description: 'Compile this month’s numbers into a shareable doc.', updated_at: ago(300) }),
    T(5, 1, 'Re-index product docs', 'queued', { description: 'Waiting for the digest run to finish.', updated_at: ago(20) }),
    T(6, 3, 'Backfill CRM notes', 'scheduled', { scheduled_for: ahead(60 * 9), updated_at: ago(600) }),
    T(7, 1, 'Release notes draft', 'completed', { started_at: ago(140), finished_at: ago(122), progress: 100, updated_at: ago(122) }),
    T(8, 2, 'Tag last week’s feedback', 'completed', { started_at: ago(260), finished_at: ago(231), progress: 100, updated_at: ago(231) }),
    T(9, 3, 'Scrape partner directory', 'failed', { started_at: ago(95), finished_at: ago(88), error: 'Target site returned HTTP 429 after 40 pages.', updated_at: ago(88) }),
  ];

  const series = [
    { id: 7, name: 'Claude Code', cost: days.map(() => null), tokens: ccTokens },
    { id: 8, name: 'Codex', cost: days.map(() => null), tokens: cxTokens },
    { id: 1, name: 'Claude API', cost: claudeCost, tokens: tokensOf(claudeCost, 210_000) },
    { id: 2, name: 'OpenAI API', cost: openaiCost, tokens: tokensOf(openaiCost, 380_000) },
    { id: 3, name: 'Nightly research agent', cost: agentCost, tokens: tokensOf(agentCost, 250_000) },
  ];

  const notifications = [
    { id: 1, kind: 'usage_warning', severity: 'warn', title: 'OpenAI API is at 82% of its monthly budget', body: 'Spending so far is close to the budget you set for this month.', read: 0, created_at: ago(40) },
    { id: 2, kind: 'connection', severity: 'err', title: 'Claude API (side project) could not sync', body: tools[5].last_error, read: 0, created_at: ago(31) },
    { id: 3, kind: 'task_failed', severity: 'err', title: 'Task failed: Scrape partner directory', body: 'Nightly research agent: Target site returned HTTP 429 after 40 pages.', read: 0, created_at: ago(88) },
    { id: 4, kind: 'limit_reached', severity: 'err', title: 'Cursor reached its monthly budget', body: '$20.00 spent of the $20.00 budget you set.', read: 1, created_at: ago(60 * 26) },
    { id: 5, kind: 'scheduled', severity: 'info', title: 'Starting soon: Draft monthly usage report', body: 'Nightly research agent is scheduled to run it within the hour.', read: 1, created_at: ago(10) },
  ];

  const feed = [
    { id: 9, kind: 'task_running', message: 'Nightly research agent started “Weekly competitor digest”', created_at: ago(18), tool_name: 'Nightly research agent' },
    { id: 8, kind: 'task_running', message: 'Claude API started “Summarize support tickets”', created_at: ago(6), tool_name: 'Claude API' },
    { id: 7, kind: 'connection', message: 'Claude API (side project) sync failed: Anthropic rejected the key.', created_at: ago(31), tool_name: 'Claude API (side project)' },
    { id: 6, kind: 'task_failed', message: 'Nightly research agent failed “Scrape partner directory”: Target site returned HTTP 429 after 40 pages.', created_at: ago(88), tool_name: 'Nightly research agent' },
    { id: 5, kind: 'task_completed', message: 'Claude API completed “Release notes draft”', created_at: ago(122), tool_name: 'Claude API' },
    { id: 4, kind: 'task_completed', message: 'OpenAI API completed “Tag last week’s feedback”', created_at: ago(231), tool_name: 'OpenAI API' },
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const enabled = tools;
  const sum = (k) => enabled.reduce((a, t) => (t[k] == null ? a : a + t[k]), 0);
  return {
    demo: true,
    generated_at: now.toISOString(),
    stats: {
      connected: tools.length, active: tools.filter((t) => t.active).length, needs_attention: 1,
      running: 5, queued: 1, scheduled: 2, completed_today: 2, failed_today: 1, sessions_running: 1,
      cost_today: sum('cost_today'), cost_mtd: sum('cost_mtd'), tokens_today: sum('tokens_today'), tokens_mtd: sum('tokens_mtd'),
      requests_mtd: sum('requests_mtd'), tools_reporting_cost: 4, ceiling_usd: 300,
    },
    tools,
    usage: {
      days,
      series,
      by_model: [
        { model: 'claude-opus-5-5', tokens: Math.round(claudeMtd * 150_000), cost_usd: claudeMtd * 0.7, requests: Math.round(claudeMtd * 160) },
        { model: 'gpt-5-mini', tokens: Math.round(openaiMtd * 380_000), cost_usd: null, requests: Math.round(openaiMtd * 410) },
        { model: 'claude-haiku-5-5', tokens: Math.round(claudeMtd * 60_000), cost_usd: claudeMtd * 0.3, requests: Math.round(claudeMtd * 100) },
      ],
    },
    tasks,
    upcoming: tasks.filter((t) => t.status === 'scheduled' || t.status === 'queued')
      .sort((a, b) => (a.scheduled_for ?? '9999').localeCompare(b.scheduled_for ?? '9999')),
    feed,
    notifications,
    unread: notifications.filter((n) => !n.read).length,
    summary: {
      source: 'demo',
      generated_at: ago(7),
      text: 'Three tasks are running: the competitor digest is about two-thirds done and should finish in under ten minutes. Two tasks finished today and the partner directory scrape failed after the site rate-limited it. The OpenAI API is at 82% of its monthly budget, and the side-project Claude key was rejected, so that account is not syncing. Today’s Claude spending is not reported yet, which is normal for a few hours.',
    },
    settings: { ...DEFAULT_SETTINGS, monthly_ceiling_usd: 300, summary_key_set: false, summary_key_hint: null },
    desktop_app: Boolean(globalThis.accDesktop),
    task_kinds: { code: 'Coding', debug: 'Debugging', writing: 'Writing', research: 'Research', analysis: 'Analysis', planning: 'Planning', quick: 'Quick question', general: 'General' },
    engines: [
      { id: 'claude-code', label: 'Claude Code', via: 'your Claude account', vendor: 'Anthropic', kind: 'cli', integration_id: 7, ready: true, reason: null },
      { id: 'claude-api', label: 'Claude API', via: 'your Claude API key', vendor: 'Anthropic', kind: 'api', integration_id: null, ready: false, reason: 'Add a Claude API key in Settings.' },
      { id: 'codex', label: 'Codex', via: 'your ChatGPT account', vendor: 'OpenAI', kind: 'cli', integration_id: 8, ready: true, reason: null },
      { id: 'gemini-cli', label: 'Gemini CLI', via: 'your Google account', vendor: 'Google', kind: 'cli', integration_id: null, ready: false, reason: 'Connect Gemini CLI first.' },
      { id: 'copilot-cli', label: 'GitHub Copilot', via: 'your GitHub account', vendor: 'GitHub', kind: 'cli', integration_id: 5, ready: true, reason: null },
      { id: 'cursor-cli', label: 'Cursor', via: 'your Cursor account', vendor: 'Anysphere', kind: 'cli', integration_id: 4, ready: false, reason: 'Cursor isn’t signed in.' },
    ],
    engine: { id: 'claude-code', label: 'Claude Code', via: 'your Claude account', vendor: 'Anthropic', kind: 'cli', integration_id: 7, ready: true, reason: null },
    engine_choice: 'auto',
    team: {
      lineup: {
        planner: { id: 'codex', label: 'Codex', vendor: 'OpenAI', chosen: false },
        builder: { id: 'claude-code', label: 'Claude Code', vendor: 'Anthropic', chosen: false },
        reviewer: { id: 'codex', label: 'Codex', vendor: 'OpenAI', chosen: false },
        debugger: { id: 'copilot-cli', label: 'GitHub Copilot', vendor: 'GitHub', chosen: false },
      },
      roles: { planner: { title: 'Planner', does: 'Plans the work' }, builder: { title: 'Builder', does: 'Does the work and applies fixes' }, reviewer: { title: 'Reviewer', does: 'Checks the work' }, debugger: { title: 'Debugger', does: 'Finds the cause of problems' } },
    },
  };
}
