/**
 * The Statistics page. Everything comes from data the app already holds: usage your tools reported, the tasks and AI
 * team stages your AIs ran here, and smart-routing decisions. Nothing is estimated; a figure no tool reports is null.
 */
import { db } from './db.js';
import { adapters } from './adapters/index.js';
import { CATEGORIES } from './router.js';
import { lastNDays, startOfUtcMonth, utcDay } from './util.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nz = (v) => v ?? 0;
const ENGINE_LABEL = (id) => adapters[id]?.engine?.label ?? (id === 'claude-api' ? 'Claude API' : id);
const ENGINE_VENDOR = (id) => adapters[id]?.vendor ?? (id === 'claude-api' ? 'Anthropic' : null);

export function buildStats(now = new Date()) {
  const monthStart = utcDay(startOfUtcMonth(now));
  const days = lastNDays(30, now);
  const from = days[0] < monthStart ? days[0] : monthStart;
  const tools = db.prepare('SELECT id, adapter, name, enabled FROM integrations WHERE enabled = 1').all();
  const usage = db.prepare('SELECT * FROM usage_daily WHERE day >= ?').all(from);

  // ── Usage: share by tool, cache reuse, daily totals ──
  const perTool = tools.map((t) => {
    const rows = usage.filter((r) => r.integration_id === t.id && r.day >= monthStart);
    const has = (f) => rows.some((r) => r[f] != null);
    const sum = (f) => rows.reduce((a, r) => a + nz(r[f]), 0);
    const tokens = has('input_tokens') || has('output_tokens') || has('cache_read_tokens') ? sum('input_tokens') + sum('output_tokens') + sum('cache_read_tokens') + sum('cache_write_tokens') : null;
    const cacheBase = sum('input_tokens') + sum('cache_read_tokens') + sum('cache_write_tokens');
    return {
      id: t.id,
      name: t.name,
      adapter: t.adapter,
      vendor: adapters[t.adapter]?.vendor ?? null,
      tokens,
      requests: has('requests') ? sum('requests') : null,
      output_tokens: has('output_tokens') ? sum('output_tokens') : null,
      cache_read: has('cache_read_tokens') ? sum('cache_read_tokens') : null,
      cache_pct: has('cache_read_tokens') && cacheBase > 0 ? (100 * sum('cache_read_tokens')) / cacheBase : null,
    };
  });
  const totalTokens = perTool.reduce((a, t) => a + nz(t.tokens), 0);
  const share = perTool.filter((t) => t.tokens).map((t) => ({ ...t, share: totalTokens ? (100 * t.tokens) / totalTokens : null })).sort((a, b) => b.tokens - a.tokens);

  const daily = days.map((d) => {
    const rows = usage.filter((r) => r.day === d);
    const any = rows.some((r) => r.input_tokens != null || r.output_tokens != null);
    return {
      day: d,
      tokens: any ? rows.reduce((a, r) => a + nz(r.input_tokens) + nz(r.output_tokens) + nz(r.cache_read_tokens) + nz(r.cache_write_tokens), 0) : null,
      requests: rows.some((r) => r.requests != null) ? rows.reduce((a, r) => a + nz(r.requests), 0) : null,
    };
  });
  const known = daily.filter((d) => d.tokens != null);
  const busiest = known.length ? known.reduce((a, b) => (b.tokens > a.tokens ? b : a)) : null;

  // ── How your AIs did on work run here: background tasks, AI team stages, Ask all answers ──
  const since = days[0];
  const perf = new Map();
  const entry = (id) => {
    if (!perf.has(id)) perf.set(id, { id, label: ENGINE_LABEL(id), vendor: ENGINE_VENDOR(id), runs: 0, ok: 0, failed: 0, durations: [], reviews: 0, approved: 0, reviewed: 0, passed: 0 });
    return perf.get(id);
  };
  const took = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  const tasks = db.prepare("SELECT * FROM tasks WHERE runner IS NOT NULL AND (finished_at >= ? OR status IN ('running', 'queued'))").all(since);
  let teamRuns = 0;
  const teamDurations = [];
  for (const t of tasks) {
    if (t.status !== 'completed' && t.status !== 'failed') continue;
    if (/^Cancelled/.test(t.error ?? '')) continue;
    if (t.runner !== 'team') {
      const e = entry(t.runner);
      e.runs += 1;
      if (t.status === 'completed') e.ok += 1;
      else e.failed += 1;
      const ms = took(t.started_at, t.finished_at);
      if (ms > 0) e.durations.push(ms);
      continue;
    }
    teamRuns += 1;
    const ms = took(t.started_at, t.finished_at);
    if (ms > 0 && t.status === 'completed') teamDurations.push(ms);
    let d = null;
    try {
      d = JSON.parse(t.detail ?? 'null');
    } catch {
      d = null;
    }
    const builder = d?.stages?.find((s) => s.key === 'build')?.engine;
    for (const s of d?.stages ?? []) {
      if (s.status !== 'done' && s.status !== 'failed') continue;
      const e = entry(s.engine);
      e.runs += 1;
      if (s.status === 'done') e.ok += 1;
      else e.failed += 1;
      const sm = took(s.started_at, s.finished_at);
      if (sm > 0) e.durations.push(sm);
      // The first review says how the builder's work held up, and how often this reviewer asks for changes.
      if (s.key === 'review' && s.verdict) {
        e.reviews += 1;
        if (s.verdict === 'approve') e.approved += 1;
        if (builder) {
          const b = entry(builder);
          b.reviewed += 1;
          if (s.verdict === 'approve') b.passed += 1;
        }
      }
    }
  }
  const performance = [...perf.values()]
    .filter((e) => e.runs)
    .map(({ durations, ...e }) => ({
      ...e,
      success_pct: (100 * e.ok) / e.runs,
      median_ms: median(durations),
      passed_review_pct: e.reviewed ? (100 * e.passed) / e.reviewed : null,
    }))
    .sort((a, b) => b.runs - a.runs);

  // ── What you ask for, and where Automatic sent it ──
  const log = db.prepare('SELECT * FROM routing_log WHERE at >= ? ORDER BY id DESC').all(`${since}T00:00:00.000Z`);
  const byCategory = Object.entries(CATEGORIES).map(([k, label]) => ({ category: k, label, count: log.filter((r) => r.category === k).length })).filter((c) => c.count).sort((a, b) => b.count - a.count);
  const byEngine = [...new Set(log.map((r) => r.engine))].map((id) => ({ id, label: ENGINE_LABEL(id), vendor: ENGINE_VENDOR(id), count: log.filter((r) => r.engine === id).length })).sort((a, b) => b.count - a.count);

  const runsThisMonth = tasks.filter((t) => (t.finished_at ?? '') >= monthStart && (t.status === 'completed' || t.status === 'failed'));
  const done = runsThisMonth.filter((t) => t.status === 'completed').length;

  return {
    generated_at: now.toISOString(),
    totals: {
      tokens_mtd: totalTokens || null,
      requests_mtd: perTool.some((t) => t.requests != null) ? perTool.reduce((a, t) => a + nz(t.requests), 0) : null,
      runs_mtd: runsThisMonth.length,
      success_pct: runsThisMonth.length ? (100 * done) / runsThisMonth.length : null,
      team_runs: teamRuns,
      team_median_ms: median(teamDurations),
      busiest_day: busiest,
    },
    share,
    cache: perTool.filter((t) => t.cache_pct != null).map(({ id, name, adapter, vendor, cache_pct, cache_read }) => ({ id, name, adapter, vendor, cache_pct, cache_read })).sort((a, b) => b.cache_pct - a.cache_pct),
    daily,
    performance,
    asks: { by_category: byCategory, by_engine: byEngine, total: log.length },
    recent_routes: log.slice(0, 10).map((r) => ({ at: r.at, kind: r.kind, category: CATEGORIES[r.category] ?? r.category, engine: r.engine, engine_label: ENGINE_LABEL(r.engine), why: r.why, preview: r.preview })),
  };
}
