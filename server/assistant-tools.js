/**
 * The app functions Claude can call. Read tools are available everywhere; action tools only in the chat,
 * where the person asked for them. Background tasks get the read tools plus report_progress (runner.js).
 *
 * Each tool: { name, description, input_schema, label(input) -> what the UI shows, run(input) -> JSON-able result }
 */
import { db, getSettings, setRaw } from './db.js';
import { buildState } from './state.js';
import { buildFacts } from './summary.js';
import { syncIntegration } from './sync.js';
import { evaluateAlerts } from './alerts.js';
import { cancelClaudeTask, retryClaudeTask, startClaudeTask } from './runner.js';
import { startTeamTask } from './team.js';
import { listEngines } from './engine-list.js';

export class ToolInputError extends Error {}

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ToolInputError(`${field} must be a positive whole number.`);
  return n;
};
const money = (v, field) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new ToolInputError(`${field} must be a dollar amount from 0 to 1,000,000, or null.`);
  return n || null;
};
const text = (v, field, max) => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`${field} is required.`);
  return v.trim().slice(0, max);
};

function toolBrief(t) {
  return {
    id: t.id, name: t.name, type: t.adapter_name, status: t.status, problem: t.last_error, enabled: t.enabled,
    signed_in_account: t.kind === 'local' ? t.account ?? null : undefined, plan_limits: t.limits ?? undefined,
    running_sessions: t.kind === 'local' ? t.sessions_running : undefined,
    spend_this_month_usd: t.cost_mtd, spend_today_usd: t.cost_today, tokens_this_month: t.tokens_mtd, requests_this_month: t.requests_mtd,
    budget_usd: t.budget_usd, budget_used_pct: t.budget_pct == null ? null : Math.round(t.budget_pct),
    running_now: t.current_activity, last_activity_at: t.last_activity_at, provider_data_complete_up_to: t.data_refreshed_at,
    can_sync: t.can_sync, what_it_can_see: t.capabilities,
  };
}

export function taskBrief(t) {
  return {
    id: t.id, name: t.name, tool: t.tool_name, status: t.status, progress_pct: t.progress, current_step: t.step,
    started_at: t.started_at, expected_finish: t.eta_at, finish_estimate_basis: t.eta_source,
    stalled: t.stalled || undefined, overdue: t.overdue || undefined, longer_than_usual: t.longer_than_usual || undefined,
    typical_duration_min: t.typical_ms == null ? undefined : Math.round(t.typical_ms / 60_000),
    scheduled_for: t.scheduled_for, finished_at: t.finished_at, error: t.error, has_result: t.has_result,
    kind: t.kind === 'session' ? 'interactive session (no set end, so no finish estimate)' : undefined,
    run_by_assistant: t.runner ? t.runner_label : undefined, last_update: t.updated_at,
  };
}

const findTool = (state, toolId) => {
  const t = state.tools.find((x) => x.id === toolId);
  if (!t) throw new ToolInputError(`There is no tool with id ${toolId}. Call list_tools to see the ids.`);
  return t;
};

const TASK_FILTERS = ['running', 'upcoming', 'completed', 'failed', 'all'];

export const READ_TOOLS = [
  {
    name: 'get_overview',
    description: 'Current snapshot of the dashboard: counts, spending, budgets, running and upcoming tasks with expected finish times, problems, and the daily summary. Start here for general questions.',
    input_schema: obj(),
    label: () => 'Looked at the overview',
    run() {
      const s = buildState();
      return { facts: buildFacts(s), stats: s.stats, unread_alerts: s.unread, daily_summary: s.summary?.text ?? null };
    },
  },
  {
    name: 'list_tools',
    description: 'Every connected AI tool with its id, status, sync problems, spend, tokens, budget and what data it can see. A null figure means the tool does not report it (not zero).',
    input_schema: obj(),
    label: () => 'Looked at your tools',
    run: () => ({ tools: buildState().tools.map(toolBrief) }),
  },
  {
    name: 'list_tasks',
    description: 'Tasks reported by the tools, newest first, with progress, current step and expected finish. expected_finish comes from the task itself (finish_estimate_basis "reported"), from its progress trend ("progress") or from how long earlier runs took ("history"); null means there is nothing to estimate from.',
    input_schema: obj({
      status: { type: 'string', enum: TASK_FILTERS, description: 'Which tasks to return. "upcoming" means queued or scheduled. Default "all".' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 30.' },
    }),
    label: (i) => `Checked ${i.status && i.status !== 'all' ? `${i.status} ` : ''}tasks`,
    run(input) {
      const status = input.status ?? 'all';
      if (!TASK_FILTERS.includes(status)) throw new ToolInputError(`status must be one of ${TASK_FILTERS.join(', ')}.`);
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
      const match = { all: () => true, upcoming: (t) => t.status === 'queued' || t.status === 'scheduled' }[status] ?? ((t) => t.status === status);
      const tasks = buildState().tasks.filter(match);
      return { total: tasks.length, tasks: tasks.slice(0, limit).map(taskBrief) };
    },
  },
  {
    name: 'get_task',
    description: 'Full detail of one task: description or instructions, error, progress history, finish estimate and, for tasks Claude ran, the result text.',
    input_schema: obj({ task_id: { type: 'integer' } }, ['task_id']),
    label: (i) => `Opened task #${i.task_id}`,
    run(input) {
      const taskId = id(input.task_id, 'task_id');
      const t = buildState().tasks.find((x) => x.id === taskId);
      if (!t) throw new ToolInputError(`There is no task with id ${taskId}.`);
      const row = db.prepare('SELECT description, result FROM tasks WHERE id = ?').get(taskId);
      const history = db.prepare('SELECT at, progress FROM task_progress WHERE task_id = ? ORDER BY at DESC LIMIT 20').all(taskId).reverse();
      return {
        ...taskBrief(t),
        description: row.description,
        result: row.result ? row.result.slice(0, 6000) + (row.result.length > 6000 ? '\n[result truncated]' : '') : null,
        progress_history: history,
      };
    },
  },
  {
    name: 'get_usage',
    description: 'Daily spend and tokens for the last 30 UTC days, per tool, plus this month by model. Days with null were not reported.',
    input_schema: obj({
      tool_id: { type: 'integer', description: 'Only this tool. Omit for all tools.' },
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many recent days. Default 14.' },
    }),
    label: () => 'Looked at usage and costs',
    run(input) {
      const s = buildState();
      const days = Math.min(30, Math.max(1, Number(input.days) || 14));
      const toolId = input.tool_id == null ? null : id(input.tool_id, 'tool_id');
      if (toolId) findTool(s, toolId);
      const from = s.usage.days.length - days;
      const series = s.usage.series
        .filter((x) => !toolId || x.id === toolId)
        .map((x) => ({
          tool_id: x.id, tool: x.name,
          daily: s.usage.days.slice(from).map((d, i) => ({ day: d, cost_usd: x.cost[from + i], tokens: x.tokens[from + i] })),
        }));
      return { series, this_month_by_model: toolId ? undefined : s.usage.by_model };
    },
  },
  {
    name: 'list_alerts',
    description: 'Alerts raised by the app: failed tasks, stalled or overdue tasks, budget warnings, connection failures, spending spikes.',
    input_schema: obj({ unread_only: { type: 'boolean' } }),
    label: () => 'Checked alerts',
    run(input) {
      const rows = db
        .prepare(`SELECT id, kind, severity, title, body, read, created_at FROM notifications ${input.unread_only ? 'WHERE read = 0' : ''} ORDER BY id DESC LIMIT 40`)
        .all();
      return { alerts: rows.map((r) => ({ ...r, read: Boolean(r.read) })) };
    },
  },
];

export const ACTION_TOOLS = [
  {
    name: 'set_tool_budget',
    description: "Set or clear one tool's monthly budget in dollars. Budgets drive the limit bars and budget alerts. Only do this when the person asks.",
    input_schema: obj({ tool_id: { type: 'integer' }, budget_usd: { type: ['number', 'null'], description: 'null clears the budget.' } }, ['tool_id', 'budget_usd']),
    label: (i) => (i.budget_usd == null ? `Cleared the budget on tool #${i.tool_id}` : `Set tool #${i.tool_id}'s budget to $${Number(i.budget_usd).toFixed(2)}`),
    run(input) {
      const toolId = id(input.tool_id, 'tool_id');
      const t = findTool(buildState(), toolId);
      const budget = money(input.budget_usd, 'budget_usd');
      db.prepare('UPDATE integrations SET budget_usd = ? WHERE id = ?').run(budget, toolId);
      evaluateAlerts();
      return { ok: true, tool: t.name, budget_usd: budget };
    },
  },
  {
    name: 'set_monthly_ceiling',
    description: 'Set or clear the monthly spending ceiling across all tools. Only do this when the person asks.',
    input_schema: obj({ ceiling_usd: { type: ['number', 'null'] } }, ['ceiling_usd']),
    label: (i) => (i.ceiling_usd == null ? 'Cleared the monthly ceiling' : `Set the monthly ceiling to $${Number(i.ceiling_usd).toFixed(2)}`),
    run(input) {
      const s = getSettings();
      s.monthly_ceiling_usd = money(input.ceiling_usd, 'ceiling_usd');
      setRaw('settings', s);
      evaluateAlerts();
      return { ok: true, monthly_ceiling_usd: s.monthly_ceiling_usd };
    },
  },
  {
    name: 'mark_alerts_read',
    description: 'Mark alerts as read. Pass alert_ids, or omit them to mark every alert read.',
    input_schema: obj({ alert_ids: { type: 'array', items: { type: 'integer' } } }),
    label: (i) => (i.alert_ids?.length ? `Marked ${i.alert_ids.length} alert${i.alert_ids.length === 1 ? '' : 's'} read` : 'Marked all alerts read'),
    run(input) {
      if (Array.isArray(input.alert_ids) && input.alert_ids.length) {
        const ids = input.alert_ids.slice(0, 200).map((v) => id(v, 'alert_ids[]'));
        const res = db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        return { ok: true, marked: res.changes };
      }
      return { ok: true, marked: db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run().changes };
    },
  },
  {
    name: 'sync_tool',
    description: 'Pull fresh usage and cost from a tool that has an API integration (can_sync true).',
    input_schema: obj({ tool_id: { type: 'integer' } }, ['tool_id']),
    label: (i) => `Synced tool #${i.tool_id}`,
    async run(input) {
      const toolId = id(input.tool_id, 'tool_id');
      const t = findTool(buildState(), toolId);
      if (!t.can_sync) throw new ToolInputError(`${t.name} has no API to sync from.`);
      const r = await syncIntegration(toolId);
      evaluateAlerts();
      return { tool: t.name, ...r };
    },
  },
  {
    name: 'start_claude_task',
    description: 'Start a background task that an AI carries out on its own, such as drafting a report, writing or rewriting text, analysing the usage data, planning work, changing files in a folder, or git work (commit, push, pull, branches) in a repository. It appears on the Tasks page with live progress and an expected finish time, and its result is saved there. Use it for work that takes more than a quick answer, or when the person asks for a task. On Automatic it goes to the AI best suited to it: building to Claude Code, debugging to Codex or Gemini, git to GitHub Copilot. For files or git, pass the folder the person named; git tasks may only run git commands there, and force-pushes and hard resets are blocked. Start git work only when the person asked for it.',
    input_schema: obj({
      name: { type: 'string', description: 'Short task name, under 80 characters.' },
      instructions: { type: 'string', description: 'Complete, self-contained instructions. The background task cannot see this chat.' },
      folder: { type: 'string', description: 'Optional. The full path of the folder or git repository to work in, exactly as the person gave it.' },
    }, ['name', 'instructions']),
    label: (i) => `Started task “${String(i.name ?? '').slice(0, 80)}”`,
    run(input) {
      let t;
      try {
        t = startClaudeTask({ name: text(input.name, 'name', 80), instructions: text(input.instructions, 'instructions', 2000), folder: typeof input.folder === 'string' && input.folder.trim() ? input.folder.trim() : null });
      } catch (err) {
        throw new ToolInputError(err.message);
      }
      const ai = listEngines().find((e) => e.id === t.runner)?.label ?? t.runner;
      return { ok: true, task_id: t.id, status: t.status, runs_on: ai, note: 'It is visible on the Tasks page.' };
    },
  },
  {
    name: 'start_team_task',
    description: 'Start an AI team task: the connected AIs split the work by role. One plans (Codex first), one builds (Claude Code first), another reviews it, and if the review finds problems one debugs (Gemini CLI first) and the builder fixes them. Use it when the person asks for the team, for several AIs to work together, or for substantial work that benefits from a second opinion. It shows on the Tasks page with each stage and who did it. From the chat it produces text only; to have the team work on files in a folder, the person starts it from the Tasks page.',
    input_schema: obj({
      goal: { type: 'string', description: 'What the team should produce, complete and self-contained. The team cannot see this chat.' },
      mode: { type: 'string', enum: ['team', 'compare'], description: '"team" (default) splits the work by role. "compare" asks every connected AI the same thing and combines their answers: use it when the person wants to compare AIs or get several opinions.' },
    }, ['goal']),
    label: (i) => `${i.mode === 'compare' ? 'Asked all AIs' : 'Started an AI team task'}: “${String(i.goal ?? '').split('\n')[0].slice(0, 70)}”`,
    run(input) {
      let t;
      try {
        t = startTeamTask({ goal: text(input.goal, 'goal', 4000), mode: input.mode === 'compare' ? 'compare' : 'team' });
      } catch (err) {
        throw new ToolInputError(err.message);
      }
      return { ok: true, task_id: t.id, status: t.status, roles: t.lineup, note: 'It is visible on the Tasks page.' };
    },
  },
  {
    name: 'cancel_claude_task',
    description: 'Stop a background task the assistant is running or has queued. Tasks reported by other tools, and sessions in Claude Code, Codex or Gemini CLI, cannot be stopped from here.',
    input_schema: obj({ task_id: { type: 'integer' } }, ['task_id']),
    label: (i) => `Cancelled task #${i.task_id}`,
    run: (input) => cancelClaudeTask(id(input.task_id, 'task_id')),
  },
  {
    name: 'retry_claude_task',
    description: 'Run a finished or failed background task of the assistant again with the same instructions.',
    input_schema: obj({ task_id: { type: 'integer' } }, ['task_id']),
    label: (i) => `Restarted task #${i.task_id}`,
    run: (input) => retryClaudeTask(id(input.task_id, 'task_id')),
  },
];

export const definition = ({ name, description, input_schema }) => ({ name, description, input_schema });

/** Runs one tool call and returns a tool_result block plus what the UI shows. */
export async function runTool(tools, block) {
  const tool = tools.find((t) => t.name === block.name);
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  let label = block.name;
  try {
    if (!tool) throw new ToolInputError(`Unknown tool ${block.name}.`);
    label = tool.label(input);
    const out = await tool.run(input);
    return { result: { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) }, label, ok: true };
  } catch (err) {
    const message = err instanceof ToolInputError ? err.message : `The app could not do this: ${err.message}`;
    if (!(err instanceof ToolInputError)) console.error(`[acc] tool ${block.name}:`, err);
    return { result: { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }, label, ok: false, error: message };
  }
}

export const allTools = [...READ_TOOLS, ...ACTION_TOOLS];
export const labelFor = (name, input) => {
  const t = allTools.find((x) => x.name === name);
  if (name === 'web_search') return `Searched the web${input?.query ? ` for “${input.query}”` : ''}`;
  try { return t ? t.label(input ?? {}) : name; } catch { return name; }
};
