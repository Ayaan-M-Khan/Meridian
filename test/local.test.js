import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-local-'));
process.env.ACC_DATA_DIR = path.join(tmp, 'data');
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');
// Point every CLI's home at empty test folders, so the real logs on this computer are never read.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.GEMINI_CLI_HOME = path.join(tmp, 'gemini-home');

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const { db } = await import('../server/db.js');
const { unwrapShim } = await import('../server/local/cli.js');
const { readClaudeCode, readCodex, readGemini } = await import('../server/local/logs.js');
const { claudeCode } = await import('../server/adapters/local.js');
const { syncIntegration } = await import('../server/sync.js');
const { buildState } = await import('../server/state.js');
const { startServer } = await import('../server/app.js');
const { createThread, sendMessage, threadView } = await import('../server/assistant.js');
const { startClaudeTask } = await import('../server/runner.js');
const { startTeamTask, teamLineup, verdictOf } = await import('../server/team.js');
const { setClaudeClientForTests } = await import('../server/claude.js');
const { copilotCli, cursorCli, geminiCli, antigravityCli } = await import('../server/adapters/local.js');
const { readCopilot } = await import('../server/local/logs.js');
process.env.COPILOT_HOME = path.join(tmp, 'copilot');

claudeCode.resolve = () => ({ command: process.execPath, prefix: [FAKE], env: {}, path: FAKE });
const srv = await startServer({ port: 0 });
after(() => {
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
};
const waitFor = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

test('npm .cmd launchers are unwrapped to the program they run', () => {
  const shim = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const r = unwrapShim(path.join(tmp, 'npm', 'claude.cmd'), shim);
  assert.equal(r.prefix[0], path.join(tmp, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  const exe = unwrapShim(path.join(tmp, 'npm', 'codex.cmd'), '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe"   %*');
  assert.equal(exe.command, path.join(tmp, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe'));
  assert.deepEqual(exe.prefix, []);
});

test('Claude Code logs: tokens per day and model, each response counted once, sessions named', () => {
  const day = new Date().toISOString().slice(0, 10);
  const ts = `${day}T09:00:00.000Z`;
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
  const msg = (id, model = 'claude-opus-5-5') => ({ type: 'assistant', sessionId: 's1', requestId: `r-${id}`, timestamp: ts, cwd: '/work/billing', message: { id, model, usage } });
  write(path.join(tmp, 'claude', 'projects', 'p1', 's1.jsonl'), [
    { type: 'user', sessionId: 's1', timestamp: ts, cwd: '/work/billing', message: { role: 'user', content: 'Fix the failing invoice test' } },
    msg('m1'), msg('m1'), // the same response, written once per content block
    msg('m2'),
    { type: 'assistant', sessionId: 's1', timestamp: ts, message: { id: 'syn', model: '<synthetic>', usage } },
    { type: 'custom-title', sessionId: 's1', customTitle: 'Invoice test fix' },
    '{"type":"assistant","truncated',
  ]);
  write(path.join(tmp, 'claude', 'projects', 'p1', 's1', 'subagents', 'agent-x.jsonl'), [msg('m3', 'claude-haiku-5-5')]);
  const ws = path.join(tmp, 'data', 'assistant-workspace');
  write(path.join(tmp, 'claude', 'projects', 'p2', 's2.jsonl'), [{ ...msg('m4'), sessionId: 's2', cwd: ws }]);

  const r = readClaudeCode({ since: new Date(Date.now() - 86_400_000), workspace: ws });
  const opus = r.rows.find((x) => x.model === 'claude-opus-5-5');
  assert.equal(opus.requests, 3, 'm1 once, m2, and the app’s own run m4');
  assert.equal(opus.input_tokens, 30);
  assert.equal(opus.cache_read_tokens, 900);
  assert.equal(r.rows.find((x) => x.model === 'claude-haiku-5-5').requests, 1, 'subagent usage counts');
  assert.deepEqual(r.sessions.map((s) => s.name), ['Invoice test fix'], 'subagents and the app’s own runs are not sessions');
  assert.equal(r.sessions[0].where, 'billing');
});

test('Codex logs: usage from token_count totals, plan limits from the newest report', () => {
  const day = new Date().toISOString().slice(0, 10);
  const at = (m) => `${day}T10:0${m}:00.000Z`;
  const tc = (m, input, cached, output, used) => ({
    timestamp: at(m), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1_900_000_000 }, plan_type: 'plus' } },
  });
  write(path.join(tmp, 'codex', 'sessions', '2026', '11', '18', 'rollout-a.jsonl'), [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'c1', cwd: '/work/api' } },
    { timestamp: at(0), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'Add pagination to /orders' } },
    tc(2, 1000, 400, 100, 10),
    tc(3, 1000, 400, 100, 12), // a repeated report without new usage
    tc(4, 1800, 900, 250, 15),
  ]);
  const r = readCodex({ since: new Date(Date.now() - 86_400_000) });
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.model, 'gpt-5-codex');
  assert.equal(row.requests, 2);
  assert.equal(row.input_tokens + row.cache_read_tokens, 1800);
  assert.equal(row.cache_read_tokens, 900);
  assert.equal(row.output_tokens, 250);
  assert.equal(r.limits.primary.used_percent, 15);
  assert.equal(r.limits.plan, 'plus');
  assert.equal(r.sessions[0].name, 'Add pagination to /orders');
});

test('Gemini CLI chats: per-message tokens, updates applied', () => {
  const day = new Date().toISOString().slice(0, 10);
  write(path.join(tmp, 'gemini-home', '.gemini', 'tmp', 'abc', 'chats', 'session-x.jsonl'), [
    { sessionId: 'g1', projectHash: 'abc', startTime: `${day}T08:00:00.000Z`, lastUpdated: `${day}T08:00:00.000Z` },
    { id: 'u1', timestamp: `${day}T08:00:01.000Z`, type: 'user', content: 'Explain this stack trace' },
    { id: 'a1', timestamp: `${day}T08:00:05.000Z`, type: 'gemini', model: 'gemini-2.5-pro', content: 'It means…', tokens: { input: 500, output: 80, cached: 200, thoughts: 20, tool: 0, total: 600 } },
    { $set: { summary: 'Stack trace help' } },
  ]);
  const r = readGemini({ since: new Date(Date.now() - 86_400_000) });
  assert.deepEqual(r.rows[0], { day, model: 'gemini-2.5-pro', input_tokens: 300, output_tokens: 100, cache_read_tokens: 200, cache_write_tokens: 0, requests: 1 });
  assert.equal(r.sessions[0].name, 'Stack trace help');
});

let ccId;
test('connecting Claude Code reads its sign-in and makes it the assistant', async () => {
  const { lastInsertRowid } = db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('claude-code', 'Claude Code', 'pending', ?)").run(new Date().toISOString());
  ccId = Number(lastInsertRowid);
  claudeCode.forgetStatus();
  const r = await syncIntegration(ccId);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'ok');
  const s = buildState();
  const tool = s.tools.find((t) => t.id === ccId);
  assert.equal(tool.account.email, 'test@example.com');
  assert.equal(tool.version, '9.9.9');
  assert.equal(s.engine.id, 'claude-code', 'a signed-in CLI is used before an API key');
  assert.ok(s.tasks.some((t) => t.kind === 'session' && t.name === 'Invoice test fix'));
});

test('a signed-out CLI is not used, and says why', async () => {
  process.env.FAKE_CLAUDE_SIGNED_OUT = '1';
  claudeCode.forgetStatus();
  await syncIntegration(ccId);
  const s = buildState();
  assert.equal(s.tools.find((t) => t.id === ccId).status, 'signin');
  assert.equal(s.engines.find((e) => e.id === 'claude-code').reason, 'Claude Code isn’t signed in.');
  delete process.env.FAKE_CLAUDE_SIGNED_OUT;
  claudeCode.forgetStatus();
  await syncIntegration(ccId);
});

test('the chat runs through Claude Code and its app functions work over the bridge', async () => {
  const { lastInsertRowid } = db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('custom-agent', 'Agent', 'tracked', ?)").run(new Date().toISOString());
  const agentId = Number(lastInsertRowid);
  const log = path.join(tmp, 'fake.log');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [{ tool: 'set_tool_budget', input: { tool_id: agentId, budget_usd: 42 } }], text: 'Done: the budget is $42.' });
  const thread = createThread();
  const events = [];
  await sendMessage(thread.id, 'Set the Agent budget to $42', (e) => events.push(e), { engine: 'claude-code' });

  assert.equal(db.prepare('SELECT budget_usd FROM integrations WHERE id = ?').get(agentId).budget_usd, 42);
  assert.ok(events.some((e) => e.type === 'tool_done' && e.ok), JSON.stringify(events));
  assert.ok(!events.some((e) => 'call' in e), 'internal fields are not sent to the browser');
  const view = threadView(thread.id);
  assert.deepEqual(view.items.map((i) => i.role), ['user', 'assistant', 'action', 'assistant']);
  assert.equal(view.items.at(-1).text, 'Done: the budget is $42.');
  assert.equal(view.engine, 'claude-code');
  const run = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(run[0].args.includes('--tools') && run[0].args.includes('--strict-mcp-config'), 'built-in tools are switched off');
  assert.equal(run[1].results[0].isError, false);

  // A second message carries the conversation so far in the prompt.
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Still $42.' });
  await sendMessage(thread.id, 'What is it now?', () => {}, { engine: 'claude-code' });
  const second = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-2);
  assert.match(second.prompt, /Set the Agent budget to \$42/);
  assert.match(second.prompt, /What is it now\?/);
  const stored = JSON.parse(db.prepare('SELECT messages FROM assistant_threads WHERE id = ?').get(thread.id).messages);
  const uses = stored.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use');
  const results = stored.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
  assert.deepEqual(uses.map((b) => b.id), results.map((b) => b.tool_use_id), 'every tool call has its result, so the API engine can continue it');
  delete process.env.FAKE_CLAUDE_LOG;
});

test('a background task runs through Claude Code with live progress', async () => {
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [{ tool: 'report_progress', input: { percent: 50, step: 'Halfway' } }], text: '# Report\nAll good.' });
  const t = startClaudeTask({ name: 'Write report', instructions: 'Write it.', engine: 'claude-code' });
  const done = await waitFor(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
    return row.status === 'completed' || row.status === 'failed' ? row : null;
  });
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(done.result, '# Report\nAll good.');
  assert.equal(done.runner, 'claude-code');
  const pts = db.prepare('SELECT progress FROM task_progress WHERE task_id = ? ORDER BY at').all(t.id).map((r) => r.progress);
  assert.deepEqual(pts, [0, 50]);
  const view = buildState().tasks.find((x) => x.id === t.id);
  assert.equal(view.runner_label, 'Claude Code');
});

test('Copilot and Cursor runs: no shell, file writes only when editing, the app’s functions over MCP', () => {
  const mcp = { command: 'node', args: ['bridge.cjs', 'http://x', 'tok'], env: {}, runDir: path.join(tmp, 'cur') };
  const read = copilotCli.engine.invocation({ system: 'S', prompt: 'P', mcp: null, access: 'read' }).args;
  assert.deepEqual(read.slice(0, 2), ['-p', 'S\n\n---\n\nP']);
  assert.ok(read.includes('--deny-tool') && read[read.indexOf('--deny-tool') + 1] === 'shell');
  assert.ok(read.join(' ').includes('--deny-tool write'));
  const edit = copilotCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'edit' }).args;
  assert.ok(edit.join(' ').includes('--allow-tool write'));
  const cfg = JSON.parse(edit[edit.indexOf('--additional-mcp-config') + 1]);
  assert.equal(cfg.mcpServers.acc.command, 'node');
  assert.ok(edit.join(' ').includes('--allow-tool acc'));
  const long = copilotCli.engine.invocation({ system: 'S', prompt: 'x'.repeat(60_000), access: 'none' }).args[1];
  assert.ok(long.length < 27_000 && long.includes('characters left out'), 'long prompts fit on a Windows command line');

  const cur = cursorCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'none', cwd: tmp });
  assert.equal(cur.cwd, mcp.runDir, 'Cursor runs where its per-run .cursor/mcp.json is');
  assert.ok(cur.args.includes('--approve-mcps'));
  assert.ok(cursorCli.engine.invocation({ system: 'S', prompt: 'P', access: 'read', cwd: tmp }).args.join(' ').includes('--mode ask'));
  const ok = cursorCli.engine.parser().finish({ code: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"Hello"}\n', stderr: '' });
  assert.equal(ok.text, 'Hello');
  const signedOut = cursorCli.engine.parser().finish({ code: 1, stdout: '', stderr: 'Error: Not authenticated. Run agent login.' });
  assert.match(signedOut.error, /isn’t signed in/);
  const cp = copilotCli.engine.parser().finish({ code: 1, stdout: '', stderr: 'Error: No authentication information found.' });
  assert.match(cp.error, /isn’t signed in/);
});

test('Copilot sessions are read defensively from its session folder', () => {
  const day = new Date().toISOString().slice(0, 10);
  write(path.join(tmp, 'copilot', 'session-state', 'abc-123', 'events.jsonl'), [
    { type: 'session.start', timestamp: `${day}T07:00:00.000Z`, data: { cwd: '/work/site' } },
    { type: 'user.message', timestamp: `${day}T07:00:01.000Z`, data: { content: 'Add a dark mode toggle' } },
    { type: 'assistant.usage', timestamp: `${day}T07:00:09.000Z`, data: { model: 'gpt-5', usage: { inputTokens: 1200, outputTokens: 300 } } },
    'not json',
  ]);
  const r = readCopilot({ since: new Date(Date.now() - 86_400_000) });
  assert.equal(r.sessions[0].name, 'Add a dark mode toggle');
  assert.equal(r.sessions[0].where, 'site');
  assert.equal(r.rows[0].input_tokens, 1200);
  assert.equal(r.rows[0].output_tokens, 300);
});

test('review verdicts', () => {
  assert.equal(verdictOf('VERDICT: APPROVE\nLooks good.'), 'approve');
  assert.equal(verdictOf('**VERDICT: CHANGES**\n1. The FAQ is missing.'), 'changes');
  assert.equal(verdictOf('1. The headline is wrong.'), 'changes', 'a numbered list of problems without a verdict line counts as changes');
  assert.equal(verdictOf('All good, ship it.'), 'approve');
});

const fakeApi = (replies) => ({
  messages: {
    stream() {
      const text = replies.shift() ?? '(none)';
      if (text instanceof Error) return { on() { return this; }, finalMessage: async () => { throw text; } };
      return { on() { return this; }, finalMessage: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 }, content: [{ type: 'text', text }] }) };
    },
  },
});
const teamDir = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.FAKE_CLAUDE_TEAM_DIR = dir;
  return dir;
};
const finished = (id) => waitFor(() => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row.status === 'completed' || row.status === 'failed' ? row : null;
}, 30_000);

test('an AI team task splits the work: plan, build, review, debug, fix, final check', async () => {
  const api = fakeApi(['VERDICT: CHANGES\n1. The prices are missing.', 'Cause: the plan never asked for prices. Fix: add a price to each service.', 'VERDICT: APPROVE']);
  setClaudeClientForTests(api);
  teamDir('team-text');
  process.env.FAKE_CLAUDE_TEAM = JSON.stringify({ Planner: ['1. Headline\n2. Three services'], Builder: ['Draft one', 'Draft two, with prices'] });
  try {
    const lineup = teamLineup();
    assert.equal(lineup.builder.id, 'claude-code');
    assert.equal(lineup.planner.id, 'claude-code', 'Codex plans first; without it, the next in line');
    assert.equal(lineup.reviewer.id, 'claude-api', 'the reviewer is a different AI from the builder when one is ready');
    assert.equal(lineup.debugger.id, 'claude-api');

    const t = startTeamTask({ goal: 'Write a page for a dog-walking business' });
    const done = await finished(t.id);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.ok(done.result.startsWith('Draft two, with prices'), done.result);
    assert.match(done.result, /How the team worked/);
    const d = JSON.parse(done.detail);
    assert.deepEqual(d.stages.map((s) => `${s.key}:${s.status}`), ['plan:done', 'build:done', 'review:done', 'debug:done', 'fix:done', 'check:done']);
    assert.equal(d.stages.find((s) => s.key === 'review').verdict, 'changes');
    assert.equal(d.stages.find((s) => s.key === 'check').verdict, 'approve');
    const pts = db.prepare('SELECT progress FROM task_progress WHERE task_id = ? ORDER BY at, rowid').all(t.id).map((r) => r.progress);
    assert.ok(pts.length >= 6 && pts.every((p, i) => i === 0 || p >= pts[i - 1]), `progress only goes up: ${pts}`);
    const view = buildState().tasks.find((x) => x.id === t.id);
    assert.equal(view.runner_label, 'AI team');
    assert.equal(view.team.stages.length, 6);
    assert.equal(view.team.stages[0].engine_label, 'Claude Code');
  } finally {
    setClaudeClientForTests(null);
  }
});

test('in a folder, only the builder may change files, and an approved review ends the run', async () => {
  const dir = teamDir('team-folder');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  process.env.FAKE_CLAUDE_TEAM = JSON.stringify({ Planner: ['1. Edit index.html'], Builder: ['Changed index.html'], Reviewer: ['VERDICT: APPROVE'] });
  const t = startTeamTask({ goal: 'Add a footer', folder: project });
  const done = await finished(t.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.role), ['Planner', 'Builder', 'Reviewer']);
  for (const c of calls) assert.equal(path.resolve(c.cwd), path.resolve(project), 'every member works in the folder');
  assert.equal(calls[0].tools, 'Read,Glob,Grep');
  assert.equal(calls[0].acceptEdits, false);
  assert.equal(calls[1].tools, 'Read,Glob,Grep,Edit,Write');
  assert.equal(calls[1].acceptEdits, true);
  assert.equal(calls[2].acceptEdits, false);
  const d = JSON.parse(done.detail);
  assert.deepEqual(d.stages.filter((s) => s.status === 'skipped').map((s) => s.key), ['debug', 'fix', 'check']);
  assert.throws(() => startTeamTask({ goal: 'x', folder: os.homedir() }), /not a whole drive or your home folder/);
  assert.throws(() => startTeamTask({ goal: 'x', folder: 'relative/path' }), /full path/);
});

test('Gemini CLI explains Google’s move to Antigravity, and Antigravity replies are read from its JSON', () => {
  const moved = geminiCli.engine.parser().finish({ code: 1, stdout: '', stderr: 'Warning: 256-color support not detected.\nAn unexpected critical error occurred: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google' });
  assert.match(moved.error, /Connect “Gemini \(Antigravity\)”/);
  const other = geminiCli.engine.parser().finish({ code: 1, stdout: '', stderr: 'Warning: 256-color support not detected.\nRipgrep is not available.\nError: quota exceeded' });
  assert.equal(other.error, 'Error: quota exceeded', 'start-up warnings are skipped when reporting an error');
  const inv = geminiCli.engine.invocation({ system: 'S', prompt: 'P', mcp: { runDir: path.join(tmp, 'r') } });
  assert.equal(inv.cwd, path.join(tmp, 'r'), 'Gemini runs where its per-run .gemini/settings.json is');
  assert.ok(inv.args.includes('--skip-trust') && inv.args.includes('--allowed-mcp-server-names'));

  const ag = antigravityCli.engine.parser().finish({ code: 0, stderr: '', stdout: '{"conversation_id":"c1","status":"SUCCESS","response":"Hi there","usage":{"input_tokens":10,"output_tokens":3}}' });
  assert.equal(ag.text, 'Hi there');
  const agErr = antigravityCli.engine.parser().finish({ code: 1, stdout: '', stderr: 'authentication required' });
  assert.match(agErr.error, /isn’t signed in/);
  assert.deepEqual(antigravityCli.engine.invocation({ system: 'S', prompt: 'P', access: 'read' }).args.slice(-2), ['--mode', 'plan']);
  assert.deepEqual(antigravityCli.engine.invocation({ system: 'S', prompt: 'P', access: 'edit' }).args.slice(-2), ['--mode', 'accept-edits']);
});

test('when an AI can’t do its part of a team task, the next one takes over', async () => {
  setClaudeClientForTests(fakeApi([new Error('Claude API is down')]));
  teamDir('team-handoff');
  process.env.FAKE_CLAUDE_TEAM = JSON.stringify({ Planner: ['1. Do it'], Builder: ['Done it'], Reviewer: ['VERDICT: APPROVE'] });
  try {
    const t = startTeamTask({ goal: 'Write a haiku about dashboards' });
    const done = await finished(t.id);
    assert.equal(done.status, 'completed', done.error ?? '');
    const review = JSON.parse(done.detail).stages.find((s) => s.key === 'review');
    assert.equal(review.engine, 'claude-code');
    assert.match(review.note, /Claude API couldn’t do it \(Claude API is down\), so Claude Code took over/);
  } finally {
    setClaudeClientForTests(null);
  }
});

test('a finished task you started raises one alert, which reaches the desktop notification hook', async () => {
  const seen = [];
  globalThis.accDesktopNotify = (n) => seen.push(n);
  teamDir('team-notify');
  process.env.FAKE_CLAUDE_TEAM = JSON.stringify({ Planner: ['1. Go'], Builder: ['All done'], Reviewer: ['VERDICT: APPROVE'] });
  try {
    const t = startTeamTask({ goal: 'Say hello' });
    const done = await finished(t.id);
    assert.equal(done.status, 'completed', done.error ?? '');
    const rows = db.prepare("SELECT title, body FROM notifications WHERE kind = 'my_task_done' AND title LIKE ?").all('%Say hello%');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /^AI team finished: Say hello/);
    assert.match(rows[0].body, /All done/);
    assert.ok(seen.some((n) => n.kind === 'my_task_done' && /Say hello/.test(n.title)));
  } finally {
    delete globalThis.accDesktopNotify;
  }
});

test('with the summary set to rules, no AI is asked to write it', async () => {
  const { setRaw, getSettings } = await import('../server/db.js');
  const { refreshSummary } = await import('../server/summary.js');
  const log = path.join(tmp, 'summary.log');
  process.env.FAKE_CLAUDE_LOG = log;
  setRaw('settings', { ...getSettings(), summary_mode: 'rules', assistant_engine: 'auto' });
  try {
    const r = await refreshSummary();
    assert.equal(r.source, 'rules');
    assert.ok(!fs.existsSync(log), 'Claude Code was not run');
  } finally {
    setRaw('settings', { ...getSettings(), summary_mode: 'ai' });
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('a model chosen for an AI app is passed to it, in the right place', async () => {
  const { setRaw, getSettings } = await import('../server/db.js');
  const { runCliEngine } = await import('../server/engines.js');
  const { codex: codexAdapter } = await import('../server/adapters/local.js');
  const log = path.join(tmp, 'model.log');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'ok' });
  setRaw('settings', { ...getSettings(), engine_models: { 'claude-code': 'sonnet' } });
  try {
    await runCliEngine('claude-code', { system: 'S', prompt: 'P' });
    const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).args;
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.ok(args.includes('-p'), 'the run still has its print-mode flag');
    // Codex takes the model after its exec subcommand.
    const inv = codexAdapter.engine.invocation({ system: 'S', prompt: 'P' });
    inv.args.splice(codexAdapter.engine.modelAt, 0, ...codexAdapter.engine.modelArgs('gpt-5-codex'));
    assert.deepEqual(inv.args.slice(0, 3), ['exec', '-m', 'gpt-5-codex']);
  } finally {
    setRaw('settings', { ...getSettings(), engine_models: {} });
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('Ask all: every ready AI answers, then the builder combines the answers', async () => {
  setClaudeClientForTests(fakeApi(['The API’s answer']));
  delete process.env.FAKE_CLAUDE_TEAM;
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Claude Code’s answer' });
  try {
    const t = startTeamTask({ goal: 'Name three uses for a dashboard', mode: 'compare' });
    assert.deepEqual(t.lineup.answering.sort(), ['claude-api', 'claude-code']);
    const done = await finished(t.id);
    assert.equal(done.status, 'completed', done.error ?? '');
    const d = JSON.parse(done.detail);
    assert.deepEqual(d.stages.map((s) => `${s.key}:${s.status}`).sort(), ['answer-claude-api:done', 'answer-claude-code:done', 'merge:done']);
    assert.match(done.result, /Each AI’s answer/);
    assert.match(done.result, /#### Claude API\n\nThe API’s answer/);
    assert.match(done.result, /Combined by Claude Code from 2 answers/);
    assert.equal(buildState().tasks.find((x) => x.id === t.id).runner_label, 'Ask all');
    assert.throws(() => startTeamTask({ goal: 'x', mode: 'compare', folder: path.join(tmp, 'project') }), /text only/);
  } finally {
    setClaudeClientForTests(null);
  }
});

test('smart routing: kind of task, strengths, plan headroom, recent failures', async () => {
  const { classify, routeTask, forgetReliability } = await import('../server/router.js');
  assert.equal(classify('Fix this TypeError crash in my React component').category, 'debug');
  assert.equal(classify('Write a short email to my landlord about the heating').category, 'writing');
  assert.equal(classify('Research the best alternatives to Notion and compare them').category, 'research');
  assert.equal(classify('Make a roadmap and break down the milestones for Q3').category, 'planning');
  assert.equal(classify('Refactor the login function in python').category, 'code');
  assert.equal(classify('what time zone is Tokyo in?').category, 'quick');

  setClaudeClientForTests(fakeApi([]));
  const now = new Date().toISOString();
  const codexId = Number(db.prepare("INSERT INTO integrations(adapter, name, status, meta, created_at) VALUES('codex', 'Codex', 'ok', ?, ?)")
    .run(JSON.stringify({ limits: { primary: { used_percent: 20, window_minutes: 300 }, observed_at: now } }), now).lastInsertRowid);
  try {
    forgetReliability();
    assert.equal(routeTask('Plan the roadmap for the launch').engine.id, 'codex', 'Codex is strongest for planning');
    assert.equal(routeTask('Write a blog post about our launch').engine.id, 'claude-code', 'a plan you pay for comes before the API key');

    db.prepare('UPDATE integrations SET meta = ? WHERE id = ?').run(JSON.stringify({ limits: { primary: { used_percent: 97, window_minutes: 300 }, observed_at: now } }), codexId);
    const r = routeTask('Plan the roadmap for the launch');
    assert.notEqual(r.engine.id, 'codex', 'Codex at 97% of its limit is skipped');
    assert.match(r.why, /Skipped Codex: 97% of its plan limit used/);

    const failed = Number(db.prepare("INSERT INTO tasks(integration_id, external_id, name, status, runner, error, finished_at, created_at, updated_at) VALUES(?, 'f1', 'x', 'failed', 'claude-code', 'Not logged in', ?, ?, ?)")
      .run(codexId, now, now, now).lastInsertRowid);
    forgetReliability();
    const after = routeTask('Refactor the login function in python');
    assert.notEqual(after.engine.id, 'claude-code', 'an AI whose last run just failed is tried after others');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(failed);
  } finally {
    db.prepare('DELETE FROM integrations WHERE id = ?').run(codexId);
    forgetReliability();
    setClaudeClientForTests(null);
  }
});

test('on Automatic, a new chat goes to the best AI and stays with it', async () => {
  const { setRaw, getSettings } = await import('../server/db.js');
  setRaw('settings', { ...getSettings(), assistant_engine: 'auto' });
  setClaudeClientForTests(fakeApi([]));
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Here you go.' });
  try {
    const thread = createThread();
    const events = [];
    await sendMessage(thread.id, 'Refactor this python function to be faster', (e) => events.push(e));
    const route = events.find((e) => e.type === 'route');
    assert.equal(route?.engine_label, 'Claude Code');
    assert.equal(route.category_label, 'Coding');
    const v = threadView(thread.id);
    assert.equal(v.engine, 'claude-code');
    assert.equal(v.route.category_label, 'Coding');
    const second = [];
    await sendMessage(thread.id, 'Now write me an email about it', (e) => second.push(e));
    assert.ok(!second.some((e) => e.type === 'route'), 'the conversation keeps its AI');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM routing_log WHERE kind = 'chat'").get().n >= 1, true);
  } finally {
    setClaudeClientForTests(null);
  }
});

test('statistics come from real usage, runs and routing decisions', async () => {
  const { buildStats } = await import('../server/stats.js');
  const s = buildStats();
  const cc = s.performance.find((p) => p.id === 'claude-code');
  assert.ok(cc && cc.runs > 0, 'Claude Code’s runs here are counted');
  assert.ok(cc.success_pct >= 0 && cc.success_pct <= 100);
  assert.ok(s.asks.total > 0 && s.asks.by_category.length > 0, 'routing decisions are counted');
  assert.ok(s.recent_routes[0].engine_label);
  assert.ok(s.share.some((x) => x.adapter === 'claude-code' && x.tokens > 0), 'usage share comes from reported tokens');
  assert.ok(s.cache.some((x) => x.adapter === 'claude-code' && x.cache_pct > 0 && x.cache_pct <= 100));
  assert.equal(s.daily.length, 30);
});

test('a preferred AI for a kind of task goes first, unless it’s at its limit', async () => {
  const { routeTask, forgetReliability } = await import('../server/router.js');
  const { setRaw, getSettings } = await import('../server/db.js');
  setClaudeClientForTests(fakeApi([]));
  const now = new Date().toISOString();
  try {
    forgetReliability();
    setRaw('settings', { ...getSettings(), route_prefs: { writing: 'claude-api' } });
    const r = routeTask('Write a blog post about our launch');
    assert.equal(r.engine.id, 'claude-api', 'your choice beats the default');
    assert.match(r.why, /your choice for writing/);

    const codexId = Number(db.prepare("INSERT INTO integrations(adapter, name, status, meta, created_at) VALUES('codex', 'Codex', 'ok', ?, ?)")
      .run(JSON.stringify({ limits: { primary: { used_percent: 99, window_minutes: 300 }, observed_at: now } }), now).lastInsertRowid);
    setRaw('settings', { ...getSettings(), route_prefs: { planning: 'codex' } });
    const p = routeTask('Plan the roadmap for the launch');
    assert.notEqual(p.engine.id, 'codex');
    assert.match(p.why, /Your choice, Codex, was skipped for now: 99% of its plan limit used/);
    db.prepare('DELETE FROM integrations WHERE id = ?').run(codexId);
  } finally {
    setRaw('settings', { ...getSettings(), route_prefs: {} });
    setClaudeClientForTests(null);
  }
});

test('automation schedules: next run in local time, described in words', async () => {
  const { nextRun, describeSchedule } = await import('../server/automations.js');
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi);
  const thu = at(2026, 10, 19, 10, 0); // a Thursday
  assert.equal(thu.getDay(), 4);
  assert.deepEqual(nextRun({ every: 'day', at: '11:00' }, thu), at(2026, 10, 19, 11, 0), 'later today');
  assert.deepEqual(nextRun({ every: 'day', at: '09:00' }, thu), at(2026, 10, 20, 9, 0), 'already past today, so tomorrow');
  assert.deepEqual(nextRun({ every: 'hour', at: '00:15' }, at(2026, 10, 19, 10, 20)), at(2026, 10, 19, 11, 15));
  assert.deepEqual(nextRun({ every: 'weekday', at: '08:30' }, at(2026, 10, 20, 18, 0)), at(2026, 10, 23, 8, 30), 'Friday evening, so Monday');
  const mon = nextRun({ every: 'week', at: '09:00', day: 1 }, thu);
  assert.equal(mon.getDay(), 1);
  assert.ok(mon > thu && mon - thu < 7 * 86_400_000);
  assert.equal(describeSchedule({ every: 'week', at: '09:00', day: 1 }), 'Every Monday at 09:00');
  assert.equal(describeSchedule({ every: 'hour', at: '00:15' }), 'Every hour at :15');
});

test('automations: saved with checks, paused and resumed, run when due, skipped when long overdue', async () => {
  const { createAutomation, updateAutomation, deleteAutomation, listAutomations, runDueAutomations } = await import('../server/automations.js');
  const { makeBackup } = await import('../server/backup.js');
  assert.throws(() => createAutomation({ name: 'x', prompt: 'y', mode: 'task', schedule: { every: 'day', at: '9am' } }), /Choose a time/);
  assert.throws(() => createAutomation({ name: 'x', prompt: 'y', mode: 'nope', schedule: { every: 'day', at: '09:00' } }), /how it runs/);
  assert.throws(() => createAutomation({ name: 'x', prompt: 'y', mode: 'team', folder: 'relative/path', schedule: { every: 'day', at: '09:00' } }), /full path/);
  assert.equal(createAutomation({ name: 'No folder', prompt: 'y', mode: 'task', folder: tmp, schedule: { every: 'day', at: '09:00' } }).folder, null, 'only an AI team works in a folder');

  const a = createAutomation({ name: 'Usage digest', prompt: 'Summarize my usage.', mode: 'task', schedule: { every: 'day', at: '09:00' } });
  assert.equal(a.schedule_text, 'Every day at 09:00');
  assert.ok(Date.parse(a.next_run_at) > Date.now());
  const paused = updateAutomation(a.id, { enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.next_run_at, null);
  assert.ok(updateAutomation(a.id, { enabled: true }).next_run_at);
  assert.ok(makeBackup().automations.some((x) => x.name === 'Usage digest'), 'backups include automations');

  // Due a minute ago: it runs, as a task named after it, and the next run moves on.
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Usage is fine.' });
  const now = new Date();
  db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(new Date(now - 60_000).toISOString(), a.id);
  runDueAutomations(now);
  const ran = listAutomations().find((x) => x.id === a.id);
  assert.ok(ran.last_task, ran.last_error ?? 'a task was started');
  assert.ok(Date.parse(ran.next_run_at) > now.getTime());
  const done = await waitFor(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(ran.last_task.id);
    return row.status === 'completed' || row.status === 'failed' ? row : null;
  });
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(done.name, 'Usage digest');
  assert.equal(done.result, 'Usage is fine.');

  // Due two hours ago, while the app was closed: skipped and noted, not run late.
  const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(new Date(now - 2 * 3_600_000).toISOString(), a.id);
  runDueAutomations(now);
  const skipped = listAutomations().find((x) => x.id === a.id);
  assert.match(skipped.last_error, /Skipped the run due .* because the app wasn’t running then/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before);
  assert.ok(Date.parse(skipped.next_run_at) > now.getTime());

  for (const x of listAutomations()) deleteAutomation(x.id);
  assert.equal(listAutomations().length, 0);
  assert.ok(Array.isArray(buildState().automations));
});
