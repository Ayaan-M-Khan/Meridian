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
