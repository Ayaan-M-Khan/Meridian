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
  for (const c of calls) assert.equal(path.resolve(c.cwd), fs.realpathSync.native(project), 'every member works in the folder (its full path)');
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

test('updates: versions compare by number, a newer release is offered once, and installs only from this project', async () => {
  const { compareVersions, checkForUpdate, updateView, installUpdate, downloadInstaller, DOWNLOAD_PREFIX } = await import('../server/updates.js');
  const { setRaw } = await import('../server/db.js');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('0.7.0', '0.7.1'), -1);

  const body = (tag, assets) => ({ tag_name: tag, html_url: `https://github.com/Ayaan-M-Khan/ai-command-center/releases/tag/${tag}`, body: '## New\n- Things', assets });
  const publicRelease = (tag, assets) => async (url, opts) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/Ayaan-M-Khan\/Meridian\/releases\/latest$/);
    assert.equal(opts.headers['user-agent'], 'Meridian-updater', 'a generic client name, nothing about the person');
    return new Response(JSON.stringify(body(tag, assets)), { status: 200 });
  };
  const notFound = async () => new Response('{}', { status: 404 });
  const noGh = async () => null;
  const installer = Buffer.from('pretend installer');
  const sha = crypto.createHash('sha256').update(installer).digest('hex');
  const good = { name: 'Meridian-Setup-9.0.0.exe', browser_download_url: `${DOWNLOAD_PREFIX}v9.0.0/Meridian-Setup-9.0.0.exe`, size: installer.length, digest: `sha256:${sha}` };
  const foreign = { name: 'Meridian-Setup-9.0.0.exe', browser_download_url: 'https://example.com/Meridian-Setup-9.0.0.exe', size: 1 };
  const alerts = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'update'").get().n;
  try {
    await checkForUpdate({ force: true, current: '0.8.0', fetchImpl: publicRelease('v9.0.0', [foreign]), gh: noGh });
    let u = updateView('0.8.0');
    assert.equal(u.available, true);
    assert.equal(u.latest, '9.0.0');
    assert.equal(u.can_install, false, 'an installer from anywhere else is never used');
    assert.equal(alerts(), 1);

    // Private releases: read through the GitHub CLI's own sign-in.
    const ghCalls = [];
    const gh = async (args) => {
      ghCalls.push(args);
      return { code: 0, stdout: JSON.stringify(body('v9.0.0', [good])), stderr: '' };
    };
    await checkForUpdate({ force: true, current: '0.8.0', fetchImpl: notFound, gh });
    assert.deepEqual(ghCalls[0], ['api', 'repos/Ayaan-M-Khan/Meridian/releases/latest']);
    assert.equal(alerts(), 1, 'one alert per version');
    assert.equal(updateView('0.8.0').can_install, false, 'only the desktop app installs');
    await assert.rejects(installUpdate(), /desktop app/);
    await checkForUpdate({ force: true, current: '0.8.0', fetchImpl: notFound, gh: noGh });
    assert.match(updateView('0.8.0').error, /releases are private.*gh auth login/);

    // Downloads are checked against the release before anything runs.
    const dir = path.join(tmp, 'update-dl');
    const asset = { name: good.name, url: good.browser_download_url, tag: 'v9.0.0', via: 'web', size: installer.length, sha256: sha };
    const file = await downloadInstaller(asset, { dir, fetchImpl: async () => new Response(installer) });
    assert.equal(fs.readFileSync(file, 'utf8'), 'pretend installer');
    await assert.rejects(downloadInstaller(asset, { dir, fetchImpl: async () => new Response('tampered!!!!!!!!!') }), /didn’t match the release/);
    await assert.rejects(downloadInstaller({ ...asset, url: 'https://example.com/x.exe' }, { dir }), /isn’t from Meridian’s releases/);
    const viaGh = await downloadInstaller({ ...asset, via: 'gh' }, { dir, gh: async (args) => {
      assert.deepEqual(args.slice(0, 5), ['release', 'download', 'v9.0.0', '--repo', 'Ayaan-M-Khan/Meridian']);
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], good.name), installer);
      return { code: 0, stdout: '', stderr: '' };
    } });
    assert.equal(path.basename(viaGh), good.name);

    await checkForUpdate({ force: true, current: '0.8.0', fetchImpl: publicRelease('v9.0.0', [good]), gh: noGh });
    const ran = [];
    globalThis.accInstallUpdate = async (f) => ran.push(f);
    assert.equal(updateView('0.8.0').can_install, true);
    await assert.rejects(installUpdate({ busy: 2 }), /2 tasks are still running/);
    const r = await installUpdate({ download: async (a) => {
      assert.equal(a.via, 'web');
      return downloadInstaller(a, { dir, fetchImpl: async () => new Response(installer) });
    } });
    assert.equal(r.version, '9.0.0');
    assert.equal(ran.length, 1);
    assert.equal(path.basename(ran[0]), good.name);

    await checkForUpdate({ force: true, current: '0.8.0', fetchImpl: async () => new Response('{}', { status: 403 }), gh: noGh });
    u = updateView('0.8.0');
    assert.match(u.error, /limiting requests/);
    assert.equal(u.latest, '9.0.0', 'a failed check keeps what the last one found');

    await checkForUpdate({ force: true, current: '9.0.0', fetchImpl: publicRelease('v9.0.0', [good]), gh: noGh });
    assert.equal(updateView('9.0.0').available, false);
  } finally {
    delete globalThis.accInstallUpdate;
    setRaw('update_check', undefined);
    db.prepare("DELETE FROM notifications WHERE kind = 'update'").run();
  }
});
test('a follow-up continues a finished task: same kind of run, and it sees the earlier request and result', async () => {
  const { followUpTask } = await import('../server/runner.js');
  const finished = (id) => waitFor(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row.status === 'completed' || row.status === 'failed' ? row : null;
  });
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Draft: a long email about the launch.' });
  const first = startClaudeTask({ name: 'Launch email', instructions: 'Write an email about the launch.', engine: 'claude-code' });
  assert.equal((await finished(first.id)).status, 'completed');
  assert.throws(() => followUpTask(first.id, ''), /what to do next/);

  const log = path.join(tmp, 'follow.log');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Short version.' });
  try {
    const r = followUpTask(first.id, 'Make it shorter.');
    assert.equal(r.kind, 'task');
    const next = await finished(r.task_id);
    assert.equal(next.status, 'completed', next.error ?? '');
    assert.equal(next.name, 'Follow-up: Launch email');
    assert.equal(next.description, 'Make it shorter.', 'the new task shows only what you asked now');
    const sent = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.prompt)?.prompt ?? '';
    assert.match(sent, /Make it shorter\./);
    assert.match(sent, /Write an email about the launch\./, 'the earlier request comes along');
    assert.match(sent, /<earlier_result>\nDraft: a long email about the launch\.\n<\/earlier_result>/, 'and the earlier result, marked as material');
    const view = buildState().tasks.find((x) => x.id === r.task_id);
    assert.deepEqual(view.follows, { id: first.id, name: 'Launch email' });
    assert.ok(view.controls.includes('follow_up'));
    const again = followUpTask(r.task_id, 'Now in French.');
    await finished(again.task_id);
    assert.equal(db.prepare('SELECT name FROM tasks WHERE id = ?').get(again.task_id).name, 'Follow-up: Launch email', 'no “Follow-up: Follow-up:”');
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('updates: release links under the repository’s old name are still trusted, and nothing else is', async () => {
  const { checkForUpdate, updateView } = await import('../server/updates.js');
  const { setRaw } = await import('../server/db.js');
  const rel = (url) => async () => new Response(JSON.stringify({ tag_name: 'v9.1.0', html_url: 'https://github.com/Ayaan-M-Khan/ai-command-center/releases/tag/v9.1.0', assets: [{ name: 'Meridian-Setup-9.1.0.exe', browser_download_url: url, size: 10 }] }), { status: 200 });
  globalThis.accInstallUpdate = async () => {};
  try {
    await checkForUpdate({ force: true, current: '1.0.0', fetchImpl: rel('https://github.com/Ayaan-M-Khan/ai-command-center/releases/download/v9.1.0/Meridian-Setup-9.1.0.exe'), gh: async () => null });
    assert.equal(updateView('1.0.0').can_install, true, 'the old name');
    assert.equal(updateView('1.0.0').url, 'https://github.com/Ayaan-M-Khan/ai-command-center/releases/tag/v9.1.0');
    await checkForUpdate({ force: true, current: '1.0.0', fetchImpl: rel('https://github.com/Ayaan-M-Khan/Meridian/releases/download/v9.1.0/Meridian-Setup-9.1.0.exe'), gh: async () => null });
    assert.equal(updateView('1.0.0').can_install, true, 'the new name');
    await checkForUpdate({ force: true, current: '1.0.0', fetchImpl: rel('https://github.com/someone-else/Meridian/releases/download/v9.1.0/Meridian-Setup-9.1.0.exe'), gh: async () => null });
    assert.equal(updateView('1.0.0').can_install, false, 'another repository is never trusted');
  } finally {
    delete globalThis.accInstallUpdate;
    setRaw('update_check', undefined);
    db.prepare("DELETE FROM notifications WHERE kind = 'update'").run();
  }
});

test('routing by kind of work: building to Claude Code, debugging to Codex and Gemini, git to GitHub Copilot', async () => {
  const { classify, routeTask, forgetReliability } = await import('../server/router.js');
  assert.equal(classify('Commit my changes and push them to origin').category, 'git');
  assert.equal(classify('Pull the latest from main and merge the branch').category, 'git');
  assert.equal(classify('Open a pull request for the login fix').category, 'git');
  assert.equal(classify('Fix this TypeError crash in the checkout page').category, 'debug');
  assert.equal(classify('Build me a landing page app with a pricing section').category, 'code');
  assert.equal(classify('Add push notifications to my mobile app').category, 'code', 'push notifications are building, not git');

  const now = new Date().toISOString();
  const add = (adapter, name) => Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES(?, ?, 'ok', ?)").run(adapter, name, now).lastInsertRowid);
  const ids = [add('codex', 'Codex'), add('gemini-cli', 'Gemini CLI'), add('copilot-cli', 'GitHub Copilot')];
  try {
    forgetReliability();
    assert.equal(routeTask('Build me a landing page app with a pricing section').engine.id, 'claude-code');
    const debug = routeTask('Fix this TypeError crash in the checkout page');
    assert.ok(['codex', 'gemini-cli'].includes(debug.engine.id), `debugging goes to Codex or Gemini, not ${debug.engine.id}`);
    assert.deepEqual(debug.ranking.slice(0, 2).map((x) => x.id).sort(), ['codex', 'gemini-cli']);
    const git = routeTask('Commit my changes and push them to origin', { needsGit: true });
    assert.equal(git.engine.id, 'copilot-cli');
    assert.deepEqual(git.ranking.map((x) => x.id).sort(), ['claude-code', 'copilot-cli'], 'only AIs that can be limited to git get git work');
    assert.equal(routeTask('Commit my changes and push them to origin').engine.id, 'copilot-cli', 'git questions in the chat go to Copilot too');
    db.prepare("UPDATE integrations SET status = 'signin' WHERE adapter = 'copilot-cli'").run();
    assert.equal(routeTask('Commit my changes and push them', { needsGit: true }).engine.id, 'claude-code', 'without Copilot, Claude Code does git');
  } finally {
    for (const i of ids) db.prepare('DELETE FROM integrations WHERE id = ?').run(i);
    forgetReliability();
  }
});

test('git access: only git commands, and never force-push or hard reset', () => {
  const cp = copilotCli.engine.invocation({ system: 'S', prompt: 'P', access: 'git' }).args.join(' ');
  assert.match(cp, /--allow-tool shell\(git:\*\)/, 'every git subcommand, not just a bare git');
  assert.match(cp, /--deny-tool shell\(git reset\)/);
  assert.match(cp, /--deny-tool shell\(git clean\)/);
  assert.doesNotMatch(cp, /shell\(git push --force\)/, 'Copilot rules can’t match flags; the push check stops force-pushes');
  assert.match(cp, /--deny-tool write/);
  assert.doesNotMatch(cp, /--deny-tool shell(?!\()/, 'git access doesn’t deny every command, only the dangerous git ones');
  const cc = claudeCode.engine.invocation({ system: 'S', prompt: 'P', access: 'git', mcp: { claudeConfigPath: 'x' } }).args;
  assert.equal(cc[cc.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
  assert.equal(cc[cc.indexOf('--allowedTools') + 1], 'mcp__acc,Bash(git:*)');
  assert.match(cc[cc.indexOf('--disallowedTools') + 1], /Bash\(git reset:\*\).*Bash\(git clean:\*\).*Bash\(git push --force:\*\)/);
});

test('a git task runs in its folder with git access, and its folder shows on the task', async () => {
  const { forgetReliability } = await import('../server/router.js');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const log = path.join(tmp, 'git-task.log');
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Committed 2 files as abc123, “Fix login”.' });
  forgetReliability();
  try {
    const t = startClaudeTask({ name: 'Commit and push', instructions: 'Commit my changes with a clear message and push them to origin.', folder: repo });
    const done = await waitFor(() => {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
      return row.status === 'completed' || row.status === 'failed' ? row : null;
    });
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.runner, 'claude-code', 'Copilot isn’t connected here, so Claude Code does git');
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.args);
    const call = calls.at(-1);
    assert.equal(call.args[call.args.indexOf('--allowedTools') + 1], 'mcp__acc,Bash(git:*)');
    assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /git/i);
    assert.equal(call.gitHooks?.key, 'core.hooksPath', 'pushes go through the push check');
    const view = buildState().tasks.find((x) => x.id === t.id);
    assert.equal(view.folder, fs.realpathSync.native(repo), 'the folder’s full path');
    assert.equal(view.access, 'git');
    assert.throws(() => startClaudeTask({ name: 'x', instructions: 'Commit everything', folder: 'relative/path' }));
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('in the chat on Automatic, a new kind of request goes to the best AI, and each reply says which AI wrote it', async () => {
  const { setRaw, getSettings } = await import('../server/db.js');
  const { forgetReliability } = await import('../server/router.js');
  const { codex } = await import('../server/adapters/local.js');
  setRaw('settings', { ...getSettings(), assistant_engine: 'auto' });
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'Here you go.' });
  const codexId = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('codex', 'Codex', 'ok', ?)").run(new Date().toISOString()).lastInsertRowid);
  const saved = { resolve: codex.resolve, engine: codex.engine };
  forgetReliability();
  try {
    const thread = createThread();
    const first = [];
    await sendMessage(thread.id, 'Build a React component for the pricing table', (e) => first.push(e));
    assert.equal(first.find((e) => e.type === 'route')?.engine, 'claude-code');
    const thanks = [];
    await sendMessage(thread.id, 'thanks!', (e) => thanks.push(e));
    assert.ok(!thanks.some((e) => e.type === 'route'), 'a quick follow-up stays with the same AI');

    // Codex isn't installed here: the debugging request goes to it, and Codex hands it to the next best AI.
    codex.resolve = () => null;
    const failed = [];
    await sendMessage(thread.id, 'Now debug this TypeError crash when the table loads', (e) => failed.push(e));
    assert.deepEqual(failed.filter((e) => e.type === 'route').map((e) => e.engine), ['codex', 'claude-code'], 'debugging goes to Codex, then on');
    assert.equal(failed.find((e) => e.type === 'route').from, 'Claude Code');
    assert.match(failed.find((e) => e.type === 'notice')?.text ?? '', /Codex couldn’t answer: Codex isn’t installed/);
    assert.equal(threadView(thread.id).engine, 'claude-code');

    // Now Codex answers (played by the stand-in, speaking Claude Code's format).
    codex.resolve = claudeCode.resolve;
    codex.engine = { ...claudeCode.engine, label: saved.engine.label };
    const debug = [];
    await sendMessage(thread.id, 'Now debug this TypeError crash when the table loads', (e) => debug.push(e));
    assert.equal(debug.find((e) => e.type === 'route')?.engine, 'codex');
    const v = threadView(thread.id);
    assert.equal(v.engine, 'codex');
    const replies = v.items.filter((it) => it.role === 'assistant');
    assert.deepEqual([replies[0].engine, replies.at(-1).engine], ['claude-code', 'codex'], 'each reply keeps the AI that wrote it');
    assert.equal(v.items.filter((it) => it.role === 'user').at(-1).route?.engine, 'codex', 'the request says where it went');
    const after = [];
    await sendMessage(thread.id, 'ok, and add a test for it', (e) => after.push(e));
    assert.equal(threadView(thread.id).engine, 'codex', 'a follow-up stays with the AI now answering when it’s about as good');
  } finally {
    Object.assign(codex, saved);
    db.prepare('DELETE FROM integrations WHERE id = ?').run(codexId);
    forgetReliability();
  }
});

test('a preferred AI that can’t run git is passed over for git work, with the reason', async () => {
  const { routeTask, forgetReliability } = await import('../server/router.js');
  const { setRaw, getSettings } = await import('../server/db.js');
  const codexId = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('codex', 'Codex', 'ok', ?)").run(new Date().toISOString()).lastInsertRowid);
  forgetReliability();
  try {
    setRaw('settings', { ...getSettings(), route_prefs: { git: 'codex' } });
    const r = routeTask('Commit my changes and push them', { needsGit: true });
    assert.equal(r.engine.id, 'claude-code');
    assert.match(r.why, /Your choice, Codex, was skipped for now: it can’t be limited to git commands/);
    assert.equal(routeTask('How do I undo my last commit?').engine.id, 'codex', 'a git question without a folder can still go to it');
  } finally {
    setRaw('settings', { ...getSettings(), route_prefs: {} });
    db.prepare('DELETE FROM integrations WHERE id = ?').run(codexId);
    forgetReliability();
  }
});

test('an AI whose account can’t use it is marked not ready, and its task and chat go to the next best AI', async () => {
  const { forgetReliability } = await import('../server/router.js');
  const { listEngines } = await import('../server/engine-list.js');
  const { stillBlocked } = await import('../server/blocked.js');
  const { setRaw, getSettings } = await import('../server/db.js');
  setRaw('settings', { ...getSettings(), assistant_engine: 'auto' });
  const MOVED = 'Google no longer lets personal accounts use Gemini CLI. Connect “Gemini (Antigravity)” to use Gemini with this Google account.';
  const saved = { resolve: geminiCli.resolve, engine: geminiCli.engine };
  // Gemini CLI answers every run with Google's "move to Antigravity" error, as it does for personal accounts.
  geminiCli.resolve = claudeCode.resolve;
  geminiCli.engine = { ...saved.engine, invocation: claudeCode.engine.invocation, parser: () => ({ onLine() {}, finish: () => ({ unusable: true, error: MOVED }) }) };
  const gid = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('gemini-cli', 'Gemini CLI', 'ok', ?)").run(new Date().toISOString()).lastInsertRowid);
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'The bug: add subtracts. Use a + b.' });
  forgetReliability();
  try {
    const t = startClaudeTask({ name: 'Fix add', instructions: 'Debug this: add(2, 3) returns -1 instead of 5.' });
    assert.equal(t.runner, 'gemini-cli', 'debugging goes to Gemini first');
    const done = await waitFor(() => {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
      return row.status === 'completed' || row.status === 'failed' ? row : null;
    });
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.runner, 'claude-code', 'Claude Code took it over');
    const view = buildState().tasks.find((x) => x.id === t.id);
    assert.match(view.handoff, /Gemini CLI couldn’t take it \(Google no longer lets personal accounts.*\), so Claude Code took over\./);
    const g = listEngines().find((e) => e.id === 'gemini-cli');
    assert.equal(g.ready, false);
    assert.equal(g.reason, MOVED, 'the reason says what’s wrong');

    const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(gid);
    assert.ok(stillBlocked(row, { signin_id: null }), 'the same sign-in stays blocked');
    assert.equal(stillBlocked(row, { signin_id: 'Google account|work@example.com' }), null, 'another sign-in lifts it');

    // The chat, when the mark isn't there yet: the message goes to Gemini, which can't answer, then to the next best.
    db.prepare("UPDATE integrations SET status = 'ok', last_error = NULL, meta = NULL WHERE id = ?").run(gid);
    const thread = createThread();
    const ev = [];
    await sendMessage(thread.id, 'Debug this TypeError crash in my checkout page', (e) => ev.push(e));
    const routes = ev.filter((e) => e.type === 'route').map((e) => e.engine);
    assert.deepEqual(routes, ['gemini-cli', 'claude-code']);
    assert.match(ev.find((e) => e.type === 'notice')?.text ?? '', /Gemini CLI couldn’t answer: Google no longer.*Asking the next best AI\./);
    assert.ok(!ev.some((e) => e.type === 'error'));
    const v = threadView(thread.id);
    assert.equal(v.engine, 'claude-code');
    assert.equal(v.items.filter((it) => it.role === 'user').length, 1, 'the message is in the conversation once');
    assert.equal(v.items.find((it) => it.role === 'assistant')?.engine, 'claude-code');
    assert.match(v.items.find((it) => it.role === 'user').route?.handoff ?? '', /^Gemini CLI couldn’t answer: Google no longer/, 'the request’s routing note says why it moved');
  } finally {
    Object.assign(geminiCli, saved);
    db.prepare('DELETE FROM integrations WHERE id = ?').run(gid);
    forgetReliability();
  }
});

test('a quick follow-up stays with the AI that did the task; new work in a follow-up is routed afresh', async () => {
  const { followUpTask } = await import('../server/runner.js');
  const { forgetReliability } = await import('../server/router.js');
  const { setRaw, getSettings } = await import('../server/db.js');
  setRaw('settings', { ...getSettings(), assistant_engine: 'auto' });
  const cid = Number(db.prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('copilot-cli', 'GitHub Copilot', 'ok', ?)").run(new Date().toISOString()).lastInsertRowid);
  const resolve = copilotCli.resolve;
  copilotCli.resolve = () => null; // never runs the real Copilot here
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ calls: [], text: 'A steel bottle that keeps drinks cold all day.' });
  forgetReliability();
  const settle = (id) => waitFor(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row.status === 'completed' || row.status === 'failed' ? row : null;
  });
  try {
    const first = startClaudeTask({ name: 'Bottle copy', instructions: 'Write a two-sentence product description for a steel water bottle.' });
    assert.equal(first.runner, 'claude-code', 'writing goes to Claude Code');
    await settle(first.id);
    const quick = followUpTask(first.id, 'Make it one sentence.');
    const q = await settle(quick.task_id);
    assert.equal(q.runner, 'claude-code', 'a quick follow-up isn’t sent to the quick-answers AI');
    assert.equal(q.status, 'completed');
    followUpTask(first.id, 'Now commit my changes and push them to origin.');
    assert.equal(db.prepare("SELECT engine FROM routing_log WHERE kind = 'task' ORDER BY id DESC LIMIT 1").get().engine, 'copilot-cli', 'git work goes to Copilot');
    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'queued') AND runner IS NOT NULL AND runner != 'team'").get().n === 0 || null);
  } finally {
    copilotCli.resolve = resolve;
    db.prepare('DELETE FROM integrations WHERE id = ?').run(cid);
    forgetReliability();
  }
});

test('the app’s own runs in your folders aren’t listed again as your sessions', async () => {
  const runs = db.prepare('SELECT folder, started_at, finished_at FROM app_runs').all();
  assert.ok(runs.some((r) => r.folder === fs.realpathSync.native(path.join(tmp, 'repo')) && r.finished_at), 'folder runs are noted, with when they ended');

  const home = path.join(tmp, 'claude-own-runs');
  const project = path.join(tmp, 'project-own');
  fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
  const at = (ms) => new Date(Date.parse('2026-11-20T10:00:00Z') + ms).toISOString();
  const session = (id, startMs) => [
    { type: 'user', sessionId: id, cwd: project, timestamp: at(startMs), message: { role: 'user', content: `Task: ${id}` } },
    { type: 'assistant', sessionId: id, cwd: project, timestamp: at(startMs + 5000), message: { id: `m-${id}`, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(home, 'projects', 'p', 'own.jsonl'), session('own', 2000));
  fs.writeFileSync(path.join(home, 'projects', 'p', 'yours.jsonl'), session('yours', 3_600_000));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const ownRuns = [{ folder: project, started_at: at(0), finished_at: at(30_000) }];
    const ids = readClaudeCode({ since: new Date('2026-11-01'), ownRuns }).sessions.map((s) => s.id);
    assert.deepEqual(ids, ['yours'], 'the session the app ran is left out; yours an hour later in the same folder stays');
    assert.equal(readClaudeCode({ since: new Date('2026-11-01'), ownRuns }).rows[0].output_tokens, 10, 'its usage still counts');
    assert.deepEqual(readClaudeCode({ since: new Date('2026-11-01') }).sessions.map((s) => s.id).sort(), ['own', 'yours']);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test('Gemini CLI and Cursor work in the task’s folder, not only in the run’s own folder', () => {
  const mcp = { runDir: path.join(tmp, 'run-x') };
  const folder = path.join(tmp, 'project');
  const g = geminiCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'edit', cwd: folder });
  assert.equal(g.cwd, mcp.runDir, 'the app’s functions load from the run’s folder');
  assert.equal(g.args[g.args.indexOf('--include-directories') + 1], folder, 'and the task’s folder is in its workspace');
  assert.ok(!geminiCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'none', cwd: path.join(tmp, 'ws') }).args.includes('--include-directories'));
  const c = cursorCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'edit', cwd: folder });
  assert.equal(c.cwd, folder);
  assert.equal(c.args[c.args.indexOf('--workspace') + 1], folder);
  assert.ok(!c.args.includes('--approve-mcps'));
  const chat = cursorCli.engine.invocation({ system: 'S', prompt: 'P', mcp, access: 'none', cwd: path.join(tmp, 'ws') });
  assert.equal(chat.cwd, mcp.runDir, 'without a folder, it runs where its functions are');
  assert.ok(chat.args.includes('--approve-mcps'));
});

test('Codex: its own server’s tools are approved, and on Windows it runs in its sandbox unless you chose one', async () => {
  const { codex, codexWindowsSandboxSet } = await import('../server/adapters/local.js');
  const home = path.join(tmp, 'codex-config');
  fs.mkdirSync(home, { recursive: true });
  const conf = path.join(home, 'config.toml');
  assert.equal(codexWindowsSandboxSet(home), false, 'no config.toml');
  fs.writeFileSync(conf, 'model = "x"\n[projects."C:\\work"]\ntrust_level = "trusted"\n');
  assert.equal(codexWindowsSandboxSet(home), false);
  fs.writeFileSync(conf, 'model = "x"\n\n[windows]\nsandbox = "elevated"\n\n[tui]\nx = 1\n');
  assert.equal(codexWindowsSandboxSet(home), true);
  fs.writeFileSync(conf, 'windows.sandbox = "elevated"\n');
  assert.equal(codexWindowsSandboxSet(home), true);
  fs.writeFileSync(conf, '[windows]\nother = 1\n[sandbox]\nsandbox = "x"\n');
  assert.equal(codexWindowsSandboxSet(home), false, 'a sandbox key in another section doesn’t count');

  const args = codex.engine.invocation({ system: 'S', prompt: 'P', access: 'edit', mcp: { command: 'node', args: ['b.cjs'], env: {} } }).args.join(' ');
  assert.match(args, /--sandbox workspace-write/);
  assert.match(args, /mcp_servers\.acc\.default_tools_approval_mode="approve"/);
  if (process.platform === 'win32') assert.match(args, /windows\.sandbox="unelevated"/, 'CODEX_HOME here has no config, so the unelevated sandbox is used');
});
