import { getRaw, setRaw, getSettings } from './db.js';
import { buildState } from './state.js';
import { claudeClient, claudeErrorMessage, claudeKey, recordUsage, MODEL, CLAUDE_KEY_AAD as SUMMARY_KEY_AAD } from './claude.js';
import { nowIso } from './util.js';

/** The facts a summary may mention. Nulls mean "not available", and the summary must say so rather than guess. */
export function buildFacts(state) {
  const { stats, tools, tasks, upcoming } = state;
  return {
    date_utc: state.generated_at.slice(0, 10),
    tools: tools.filter((t) => t.enabled).map((t) => ({
      name: t.name,
      status: t.status,
      problem: t.last_error,
      cost_month_usd: t.cost_mtd,
      budget_usd: t.budget_usd,
      budget_used_pct: t.budget_pct == null ? null : Math.round(t.budget_pct),
      data_complete_up_to: t.data_refreshed_at,
    })),
    running: tasks.filter((t) => t.status === 'running').map((t) => ({
      name: t.name, tool: t.tool_name, progress: t.progress, expected_finish: t.eta_at, finish_estimate_basis: t.eta_source, stalled: t.stalled,
    })),
    next_up: upcoming.slice(0, 5).map((t) => ({ name: t.name, tool: t.tool_name, at: t.scheduled_for })),
    completed_today: stats.completed_today,
    failed_today: tasks.filter((t) => t.status === 'failed' && t.finished_at?.startsWith(state.generated_at.slice(0, 10))).map((t) => ({ name: t.name, tool: t.tool_name, error: t.error })),
    cost_today_usd: stats.cost_today,
    cost_month_usd: stats.cost_mtd,
    monthly_ceiling_usd: stats.ceiling_usd,
  };
}

const money = (n) => (n == null ? null : `$${n.toFixed(2)}`);

export function ruleSummary(f) {
  if (!f.tools.length) return 'No tools are connected yet. Add one on the AI Tools page to start tracking it.';
  const parts = [];
  const errored = f.tools.filter((t) => t.status === 'error');
  parts.push(
    `${f.tools.length} tool${f.tools.length === 1 ? ' is' : 's are'} connected` +
      (errored.length ? `, and ${errored.map((t) => t.name).join(', ')} need${errored.length === 1 ? 's' : ''} attention.` : '.'),
  );
  if (f.running.length) parts.push(`Running now: ${f.running.map((t) => `${t.name} (${t.tool})`).join(', ')}.`);
  parts.push(`${f.completed_today} task${f.completed_today === 1 ? '' : 's'} finished today` +
    (f.failed_today.length ? ` and ${f.failed_today.length} failed.` : '.'));
  if (f.next_up.length) parts.push(`Next up: ${f.next_up[0].name}${f.next_up[0].at ? ` at ${f.next_up[0].at.slice(11, 16)} UTC` : ''}.`);
  if (f.cost_month_usd != null) {
    parts.push(`Reported spending this month is ${money(f.cost_month_usd)}` +
      (f.monthly_ceiling_usd ? ` of your ${money(f.monthly_ceiling_usd)} ceiling.` : '.'));
  } else {
    parts.push('No tool has reported spending this month.');
  }
  const near = f.tools.filter((t) => t.budget_used_pct >= 75);
  if (near.length) parts.push(`Close to budget: ${near.map((t) => `${t.name} at ${t.budget_used_pct}%`).join(', ')}.`);
  return parts.join(' ');
}

const SYSTEM = `You write the daily status summary at the top of a dashboard that tracks someone's AI tools.
Write 3 to 5 plain sentences, no lists, no headings, no greeting. Cover what is running, what finished or failed today, what is scheduled next, and any connection problems, budgets near their limit, or spending worth knowing about.
Use only the facts in the JSON. A null value means the data is not available: say so briefly when it matters, and never estimate it. Spending figures may lag by up to a day for API providers; mention this only if spending is the main point.`;

async function aiSummary(facts) {
  const res = await claudeClient().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Current state:\n${JSON.stringify(facts)}` }],
  });
  recordUsage(res.usage, res.model);
  if (res.stop_reason === 'refusal') throw new Error('The model declined to write this summary.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('The model returned an empty summary.');
  return text;
}

export const summaryKey = claudeKey;

export async function refreshSummary() {
  const facts = buildFacts(buildState());
  const key = summaryKey();
  let result;
  if (key && facts.tools.length) {
    try {
      result = { text: await aiSummary(facts), source: 'ai', generated_at: nowIso() };
    } catch (err) {
      result = { text: ruleSummary(facts), source: 'rules', generated_at: nowIso(), error: `AI summary unavailable: ${claudeErrorMessage(err)}` };
    }
  } else {
    result = { text: ruleSummary(facts), source: 'rules', generated_at: nowIso() };
  }
  setRaw('summary_cache', result);
  return result;
}

export function getSummary() {
  return getRaw('summary_cache') ?? null;
}

/** The rule-based summary is free, so it is rebuilt every tick; AI summaries follow the configured interval. */
export async function maybeRefreshSummary() {
  const cached = getSummary();
  const hours = getSettings().summary_interval_hours;
  const stale = !cached || Date.now() - Date.parse(cached.generated_at) >= hours * 3_600_000;
  if (!summaryKey() || cached?.source !== 'ai' || stale) await refreshSummary();
}

export { SUMMARY_KEY_AAD };
