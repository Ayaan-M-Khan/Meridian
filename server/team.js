/**
 * AI team tasks: one goal, split across the AIs you have connected, each doing the part it's best suited to.
 *
 *   Plan         the planner (Codex first) writes a short, checkable plan
 *   Build        the builder (Claude Code first) does the work
 *   Review       the reviewer (Codex first, or any AI other than the builder) approves it or lists problems
 *   Debug        if there are problems, the debugger (Gemini CLI first) works out the causes and the fixes
 *   Fix          the builder applies them
 *   Final check  the reviewer looks once more
 *
 * Who does what can be set per role in Settings; 'auto' takes the first ready AI in each role's order. Without a folder
 * the result is text (a draft, a plan, code to copy). With a folder, the builder works on the files in it: the
 * planner, reviewer and debugger can only read them, and nobody runs shell commands (Codex may, in its sandbox).
 * Each task is a normal task row under the built-in assistant tool, so the ETA watcher and alerts cover it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, getSettings, DATA_DIR } from './db.js';
import { announce } from './ingest.js';
import { recordProgress } from './eta.js';
import { evaluateAlerts } from './alerts.js';
import { listEngines } from './engine-list.js';
import { runCliEngine } from './engines.js';
import { assistantIntegration, claudeClient, claudeErrorMessage, isAbort, recordUsage, MODEL } from './claude.js';
import { randomToken } from './crypto.js';
import { HttpError, nowIso } from './util.js';

export const ROLES = {
  planner: { title: 'Planner', does: 'Plans the work', prefer: ['codex', 'claude-code', 'gemini-cli', 'antigravity-cli', 'copilot-cli', 'cursor-cli', 'claude-api'] },
  builder: { title: 'Builder', does: 'Does the work and applies fixes', prefer: ['claude-code', 'claude-api', 'cursor-cli', 'copilot-cli', 'codex', 'gemini-cli', 'antigravity-cli'] },
  reviewer: { title: 'Reviewer', does: 'Checks the work', prefer: ['codex', 'claude-code', 'gemini-cli', 'antigravity-cli', 'copilot-cli', 'claude-api', 'cursor-cli'] },
  debugger: { title: 'Debugger', does: 'Finds the cause of problems', prefer: ['gemini-cli', 'antigravity-cli', 'claude-code', 'codex', 'copilot-cli', 'cursor-cli', 'claude-api'] },
};
const MAX_HANDOFFS = 2;

/** The next AI for a role after some have failed at it, or null. */
function fallbackFor(role, tried, folder) {
  const ready = listEngines().filter((e) => e.ready && (!folder || e.kind === 'cli') && !tried.includes(e.id));
  return [...ROLES[role].prefer.map((id) => ready.find((e) => e.id === id)).filter(Boolean), ...ready][0] ?? null;
}

const STAGES = [
  { key: 'plan', role: 'planner', label: 'Plan', from: 2, to: 15, verb: 'Planning' },
  { key: 'build', role: 'builder', label: 'Build', from: 15, to: 55, verb: 'Building' },
  { key: 'review', role: 'reviewer', label: 'Review', from: 55, to: 68, verb: 'Reviewing' },
  { key: 'debug', role: 'debugger', label: 'Debug', from: 68, to: 78, verb: 'Debugging' },
  { key: 'fix', role: 'builder', label: 'Fix', from: 78, to: 90, verb: 'Fixing' },
  { key: 'check', role: 'reviewer', label: 'Final check', from: 90, to: 99, verb: 'Final check' },
];

const STAGE_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_LIMIT = 30_000;
const active = new Map(); // task id -> AbortController
const queue = [];

/**
 * Who does each role right now. With a folder, every role needs an app on this computer, because the Claude API
 * engine can't read or change files. A reviewer and debugger other than the builder are preferred, for a second opinion.
 */
export function teamLineup({ folder = false, settings = getSettings() } = {}) {
  const ready = listEngines().filter((e) => e.ready);
  const pool = folder ? ready.filter((e) => e.kind === 'cli') : ready;
  if (!pool.length) return null;
  const pick = (role, avoid = []) => {
    const choice = settings.team_roles?.[role] ?? 'auto';
    if (choice !== 'auto') {
      const chosen = pool.find((e) => e.id === choice);
      if (chosen) return { ...chosen, chosen: true };
    }
    const ranked = [...ROLES[role].prefer.map((id) => pool.find((e) => e.id === id)).filter(Boolean), ...pool];
    return { ...(ranked.find((e) => !avoid.includes(e.id)) ?? ranked[0]), chosen: false };
  };
  const builder = pick('builder');
  return { planner: pick('planner'), builder, reviewer: pick('reviewer', [builder.id]), debugger: pick('debugger', [builder.id]) };
}

/** The lineup as the UI shows it. */
export function lineupView(opts) {
  const l = teamLineup(opts);
  if (!l) return null;
  return Object.fromEntries(Object.entries(l).map(([role, e]) => [role, { id: e.id, label: e.label, vendor: e.vendor, chosen: e.chosen }]));
}

function cleanFolder(f) {
  if (f == null || f === '') return null;
  if (typeof f !== 'string') throw new HttpError(400, 'The folder must be a path.');
  const raw = f.trim().replace(/^"(.*)"$/, '$1');
  if (!path.isAbsolute(raw)) throw new HttpError(400, 'Use the folder’s full path, for example C:\\Users\\you\\projects\\site.');
  const p = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new HttpError(400, 'That folder doesn’t exist.');
  }
  if (!st.isDirectory()) throw new HttpError(400, 'That path is a file, not a folder.');
  if (p === path.parse(p).root || p === os.homedir()) throw new HttpError(400, 'Choose a project folder, not a whole drive or your home folder.');
  const data = path.resolve(DATA_DIR);
  if (p.startsWith(data) || data.startsWith(p + path.sep)) throw new HttpError(400, 'Choose a folder outside the app’s own data folder.');
  return p;
}

const taskRow = (id) => db.prepare('SELECT t.*, i.name AS tool_name FROM tasks t JOIN integrations i ON i.id = t.integration_id WHERE t.id = ?').get(id);
const readDetail = (t) => {
  try {
    return JSON.parse(t.detail ?? 'null');
  } catch {
    return null;
  }
};

function save(id, fields) {
  const cols = { ...fields, updated_at: nowIso() };
  if (cols.detail && typeof cols.detail !== 'string') cols.detail = JSON.stringify(cols.detail);
  db.prepare(`UPDATE tasks SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), id);
}

function setStatus(id, status, fields = {}) {
  save(id, { status, ...fields });
  const t = taskRow(id);
  if (!t) return null;
  announce({ id: t.integration_id, name: t.tool_name }, id, t, { quiet: fields.error === CANCELLED });
  evaluateAlerts();
  return t;
}

const CANCELLED = 'Cancelled from AI Command Center.';

/** Creates an AI team task and starts it, or queues it behind the one that's running. */
export function startTeamTask({ goal, folder }) {
  if (typeof goal !== 'string' || !goal.trim()) throw new HttpError(400, 'Describe what the team should do.');
  if (goal.length > 4000) throw new HttpError(400, 'Keep the goal under 4,000 characters.');
  const dir = cleanFolder(folder);
  const lineup = teamLineup({ folder: Boolean(dir) });
  if (!lineup) {
    throw new HttpError(400, dir
      ? 'Working in a folder needs an AI app on this computer: connect and sign in to Claude Code, Codex, Gemini CLI, GitHub Copilot or Cursor.'
      : 'Connect at least one AI first: an app signed in with your account, or a Claude API key.');
  }
  const integ = assistantIntegration();
  if (!integ.enabled) throw new HttpError(409, 'The built-in assistant tool is turned off on the AI Tools page.');
  const text = goal.trim();
  const name = text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 80);
  const detail = {
    goal: text,
    folder: dir,
    lineup: Object.fromEntries(Object.entries(lineup).map(([r, e]) => [r, e.id])),
    stages: STAGES.map((s) => ({ key: s.key, label: s.label, role: s.role, engine: lineup[s.role].id, engine_label: lineup[s.role].label, status: 'pending' })),
  };
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks(integration_id, external_id, name, description, status, progress, runner, kind, detail, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'queued', NULL, 'team', 'team', ?, ?, ?)`,
    )
    .run(integ.id, `team-${randomToken(6)}`, name, dir ? `${text}\n\nFolder: ${dir}` : text, JSON.stringify(detail), now, now);
  const id = Number(lastInsertRowid);
  announce(integ, id, taskRow(id));
  queue.push(id);
  pump();
  return { ...taskRow(id), lineup: detail.lineup };
}

function pump() {
  while (active.size < 1 && queue.length) {
    const id = queue.shift();
    execute(id).catch((err) => console.error('[acc] team:', err));
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────
const TEAM = (role, folder) =>
  `You are the ${role} in an AI team working for one person through AI Command Center. Several AIs share the work: a planner, a builder, a reviewer and a debugger, each from a different provider where possible. Do only your own part, and write for the next team member in plain text with simple Markdown. Nobody is watching live, so don't ask questions: make sensible assumptions and say what you assumed.${folder ? `\n\nYou are working in the person’s folder ${folder}. ${role === 'Builder' ? 'You may read, create and change files in it. Don’t run shell commands.' : 'You may read files in it but must not change anything.'}` : '\n\nThere is no folder to work in: everything happens in your reply.'}`;

const ROLE_TASK = {
  plan: (f) => `Write a short, concrete plan the builder can follow to reach the goal: numbered steps, what the finished result must include, and how to check it is right.${f ? ' Look at the relevant files first and name the files to create or change.' : ''} Don’t do the work yourself.`,
  build: (f) => (f
    ? 'Carry out the plan: make the changes in the files. Then reply with a short summary of what you changed, file by file, and anything left undone.'
    : 'Carry out the plan and reply with the complete finished result itself, ready to use. No preamble, no notes about the process.'),
  review: (f) => `Check the builder’s work against the goal and the plan${f ? ', reading the files it changed' : ''}. Start your reply with exactly one line, either “VERDICT: APPROVE” or “VERDICT: CHANGES”. With CHANGES, follow with a numbered list of specific problems and what to change. Don’t redo the work.`,
  debug: (f) => `The reviewer found problems. For each one, work out the cause and the exact fix: where, what to change, and why.${f ? ' Read the files involved.' : ''} Be specific and brief. Don’t redo the whole work.`,
  fix: (f) => (f
    ? 'Apply the fixes from the review and the diagnosis to the files. Then reply with a short summary of what you fixed.'
    : 'Apply the fixes from the review and the diagnosis, and reply with the complete revised result, ready to use. No preamble.'),
  check: (f) => `This is the final check after fixes. Check the work against the goal${f ? ', reading the changed files' : ''}. Start with exactly one line, “VERDICT: APPROVE” or “VERDICT: CHANGES”, then list anything still wrong. Be brief.`,
};

function context(d, parts) {
  const out = [`Goal from the person:\n${d.goal}`];
  for (const [title, s] of parts) if (s?.output) out.push(`## ${title} (by ${s.engine_label})\n\n${s.output}`);
  return out.join('\n\n---\n\n');
}

/** APPROVE or CHANGES from a review. Without a verdict line, a reply that lists problems counts as CHANGES. */
export function verdictOf(text) {
  const m = String(text ?? '').match(/VERDICT\W{0,3}\s*(APPROVE|CHANGES)/i);
  if (m) return m[1].toUpperCase() === 'APPROVE' ? 'approve' : 'changes';
  return /\n\s*\d+[.)]\s|problem|issue|bug|missing|incorrect|wrong/i.test(String(text ?? '')) ? 'changes' : 'approve';
}

async function runStage(engineId, { system, prompt, access, folder, signal }) {
  if (engineId !== 'claude-api') {
    const out = await runCliEngine(engineId, { system, prompt, access, folder, signal, timeoutMs: STAGE_TIMEOUT_MS });
    return out.text.trim();
  }
  // The Claude API engine: one request, no file access.
  const msg = await claudeClient()
    .messages.stream({ model: MODEL, max_tokens: 32000, system, messages: [{ role: 'user', content: prompt }], cache_control: { type: 'ephemeral' } }, { signal })
    .finalMessage();
  recordUsage(msg.usage, msg.model);
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this part of the task.');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function execute(id) {
  const ctrl = new AbortController();
  active.set(id, ctrl);
  const t = taskRow(id);
  const d = t ? readDetail(t) : null;
  if (!t || !d) {
    active.delete(id);
    return pump();
  }
  const stage = (key) => d.stages.find((s) => s.key === key);
  setStatus(id, 'running', { started_at: nowIso(), progress: 0, step: 'Starting', detail: d });
  recordProgress(id, 0);

  const run = async (key, prompt) => {
    const def = STAGES.find((s) => s.key === key);
    const s = stage(key);
    Object.assign(s, { status: 'running', started_at: nowIso() });
    save(id, { progress: def.from, step: `${def.verb} · ${s.engine_label}`, detail: d });
    recordProgress(id, def.from);
    const access = !d.folder ? 'none' : key === 'build' || key === 'fix' ? 'edit' : 'read';
    const system = `${TEAM(ROLES[def.role].title, d.folder)}\n\nYour part now: ${ROLE_TASK[key](d.folder)}`;
    const tried = [];
    for (;;) {
      try {
        const output = await runStage(s.engine, { system, prompt, access, folder: d.folder, signal: ctrl.signal });
        if (!output) throw new Error(`${s.engine_label} returned nothing.`);
        Object.assign(s, { status: 'done', finished_at: nowIso(), output: output.slice(0, OUTPUT_LIMIT) });
        break;
      } catch (err) {
        const message = isAbort(err) ? 'Cancelled.' : claudeErrorMessage(err);
        tried.push(s.engine);
        // If an AI can't do its part (signed out, blocked, timed out), the next one suited to the role takes over.
        const next = isAbort(err) || tried.length > MAX_HANDOFFS ? null : fallbackFor(def.role, tried, d.folder);
        if (!next) {
          Object.assign(s, { status: 'failed', finished_at: nowIso(), error: message });
          throw err;
        }
        s.note = `${s.note ? `${s.note} ` : ''}${s.engine_label} couldn’t do it (${message.slice(0, 160)}), so ${next.label} took over.`;
        Object.assign(s, { engine: next.id, engine_label: next.label });
        // The builder also does the fixes, and the reviewer the final check.
        const twin = { build: 'fix', review: 'check' }[key];
        if (twin && stage(twin).status === 'pending') Object.assign(stage(twin), { engine: next.id, engine_label: next.label });
        save(id, { step: `${def.verb} · ${next.label}`, detail: d });
      }
    }
    save(id, { progress: def.to, detail: d });
    recordProgress(id, def.to);
    return s.output;
  };
  const skip = (key, why) => Object.assign(stage(key), { status: 'skipped', note: why });

  try {
    await run('plan', context(d, []));
    await run('build', context(d, [['Plan', stage('plan')]]));
    const review = await run('review', context(d, [['Plan', stage('plan')], [d.folder ? 'Changes made' : 'Work', stage('build')]]));
    stage('review').verdict = verdictOf(review);
    if (stage('review').verdict === 'approve') {
      for (const k of ['debug', 'fix', 'check']) skip(k, 'The review approved the work.');
    } else {
      if (stage('debug').engine === stage('build').engine) {
        skip('debug', 'Only one AI was available, so it diagnosed and fixed the problems in one step.');
      } else {
        await run('debug', context(d, [['Plan', stage('plan')], [d.folder ? 'Changes made' : 'Work', stage('build')], ['Review', stage('review')]]));
      }
      await run('fix', context(d, [['Plan', stage('plan')], [d.folder ? 'Changes made' : 'Work', stage('build')], ['Review', stage('review')], ['Diagnosis', stage('debug')]]));
      const check = await run('check', context(d, [['Plan', stage('plan')], [d.folder ? 'Changes made' : 'Revised work', d.folder ? stage('build') : stage('fix')], ...(d.folder ? [['Fixes made', stage('fix')]] : [])]));
      stage('check').verdict = verdictOf(check);
    }
    if (!taskRow(id)) return; // removed while running
    setStatus(id, 'completed', { progress: 100, step: null, result: teamResult(d).slice(0, 100_000), finished_at: nowIso(), error: null, detail: d });
  } catch (err) {
    for (const s of d.stages) if (s.status === 'pending') Object.assign(s, { status: 'skipped', note: 'Not reached.' });
    const failed = d.stages.find((s) => s.status === 'failed');
    const error = isAbort(err) ? CANCELLED : `${failed ? `${failed.label} (${failed.engine_label}) failed: ` : ''}${claudeErrorMessage(err)}`;
    if (taskRow(id)) setStatus(id, 'failed', { step: null, finished_at: nowIso(), error, detail: d });
  } finally {
    active.delete(id);
    pump();
  }
}

/** The saved result: the finished work first, then who did what. */
function teamResult(d) {
  const s = Object.fromEntries(d.stages.map((x) => [x.key, x]));
  const fixed = s.fix.status === 'done';
  const work = d.folder
    ? `${s.build.output}${fixed ? `\n\n**Fixes after review:**\n\n${s.fix.output}` : ''}`
    : fixed ? s.fix.output : s.build.output;
  const lines = d.stages.map((x) => {
    const what = x.status === 'skipped' ? `skipped: ${x.note}` : x.key === 'review' || x.key === 'check' ? (x.verdict === 'approve' ? 'approved' : 'asked for changes') : 'done';
    return `- **${x.label}** · ${x.engine_label}: ${what}`;
  });
  const lastReview = s.check.status === 'done' ? s.check : s.review;
  const concerns = lastReview.verdict === 'changes' ? `\n\n**Reviewer’s remaining notes (${lastReview.engine_label}):**\n\n${lastReview.output.replace(/^.*VERDICT.*$/im, '').trim()}` : '';
  return `${work}\n\n---\n\n### How the team worked\n${d.folder ? `Folder: \`${d.folder}\`\n\n` : ''}${lines.join('\n')}${concerns}`;
}

/** Stage list for the UI, without the full outputs (those come from GET /api/tasks/:id). */
export function teamView(t) {
  const d = readDetail(t);
  if (!d) return null;
  return {
    folder: d.folder ?? null,
    stages: d.stages.map(({ key, label, role, engine, engine_label, status, started_at, finished_at, verdict, note, error }) => ({ key, label, role, engine, engine_label, status, started_at, finished_at, verdict, note, error })),
  };
}

export function cancelTeamTask(id) {
  if (active.has(id)) {
    active.get(id).abort();
    return { ok: true, task_id: id, note: 'Stopping.' };
  }
  const q = queue.indexOf(id);
  if (q >= 0) {
    queue.splice(q, 1);
    const t = taskRow(id);
    const d = readDetail(t);
    if (d) for (const s of d.stages) Object.assign(s, { status: 'skipped', note: 'Cancelled.' });
    setStatus(id, 'failed', { finished_at: nowIso(), error: CANCELLED, detail: d });
    return { ok: true, task_id: id };
  }
  throw new HttpError(400, 'That team task is not running.');
}

export function retryTeamTask(id) {
  const t = taskRow(id);
  const d = readDetail(t);
  if (!d) throw new HttpError(404, 'That team task no longer exists.');
  if (t.status === 'running' || t.status === 'queued') throw new HttpError(400, `“${t.name}” is still ${t.status}.`);
  const next = startTeamTask({ goal: d.goal, folder: d.folder });
  return { ok: true, task_id: next.id, status: next.status };
}
