import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ACC_DATA_DIR = path.join(os.tmpdir(), `acc-test-claude-${process.pid}`);
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const { db } = await import('../server/db.js');
const { estimate } = await import('../server/eta.js');
const { parseTask, upsertTask } = await import('../server/ingest.js');
const { buildState } = await import('../server/state.js');
const { setClaudeClientForTests } = await import('../server/claude.js');
const { startClaudeTask } = await import('../server/runner.js');
const { createThread, sendMessage, threadView } = await import('../server/assistant.js');

const MIN = 60_000;
const T0 = Date.parse('2026-11-18T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const running = (extra = {}) => ({ status: 'running', started_at: iso(T0), eta: null, updated_at: iso(T0), ...extra });

/** A scripted stand-in for the Anthropic client: each call to stream() returns the next message. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(structuredClone(params));
        const msg = script.shift();
        if (!msg) throw new Error('fake client ran out of replies');
        const handlers = {};
        return {
          on(ev, fn) { handlers[ev] = fn; return this; },
          async finalMessage() {
            for (const b of msg.content) if (b.type === 'text') handlers.text?.(b.text, b.text);
            return { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 }, ...msg };
          },
        };
      },
    },
  };
}
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};

test('ETA from a progress trend extends the line to 100%', () => {
  const pts = [{ t: T0, p: 0 }, { t: T0 + 10 * MIN, p: 25 }, { t: T0 + 20 * MIN, p: 50 }];
  const e = estimate(running({ updated_at: iso(T0 + 20 * MIN) }), pts, [], T0 + 21 * MIN);
  assert.equal(e.eta_source, 'progress');
  assert.equal(e.eta_at, iso(T0 + 40 * MIN));
  assert.equal(e.stalled, false);
  assert.equal(e.overdue, false);
});

test('a reported ETA wins, and running well past it is flagged overdue', () => {
  const e = estimate(running({ eta: iso(T0 + 10 * MIN) }), [], [], T0 + 15 * MIN);
  assert.equal(e.eta_source, 'reported');
  assert.equal(e.overdue, true);
});

test('earlier runs give an estimate when there is no progress', () => {
  const e = estimate(running(), [], [30 * MIN, 34 * MIN, 32 * MIN], T0 + 5 * MIN);
  assert.equal(e.eta_source, 'history');
  assert.equal(e.eta_at, iso(T0 + 32 * MIN));
  const late = estimate(running(), [], [30 * MIN], T0 + 60 * MIN);
  assert.equal(late.eta_at, null, 'no estimate once the typical length has passed');
  assert.equal(late.longer_than_usual, true);
});

test('no reports and no history means no estimate, not a guess', () => {
  const e = estimate(running(), [], [], T0 + 5 * MIN);
  assert.equal(e.eta_at, null);
  assert.equal(e.eta_source, null);
});

test('a task that stops reporting progress is flagged stalled', () => {
  const pts = [{ t: T0 + 1 * MIN, p: 10 }, { t: T0 + 2 * MIN, p: 20 }, { t: T0 + 3 * MIN, p: 30 }];
  const e = estimate(running({ updated_at: iso(T0 + 3 * MIN) }), pts, [], T0 + 25 * MIN);
  assert.equal(e.stalled, true);
});

test('ingested progress is recorded and drives the ETA in the state', () => {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES('custom-agent', 'Agent', 'tracked', ?)")
    .run(new Date().toISOString());
  const integ = { id: Number(lastInsertRowid), name: 'Agent' };
  const started = new Date(Date.now() - 10 * MIN).toISOString();
  const id = upsertTask(integ, parseTask({ id: 'r1', name: 'Crawl', status: 'running', progress: 0, started_at: started }, 0));
  db.prepare("UPDATE task_progress SET at = ? WHERE task_id = ?").run(started, id);
  upsertTask(integ, parseTask({ id: 'r1', name: 'Crawl', status: 'running', progress: 50, step: 'Page 50 of 100' }, 0));
  const t = buildState().tasks.find((x) => x.id === id);
  assert.equal(t.eta_source, 'progress');
  assert.equal(t.step, 'Page 50 of 100');
  const left = Date.parse(t.eta_at) - Date.now();
  assert.ok(left > 8 * MIN && left < 12 * MIN, `about 10 minutes left, got ${left / MIN}`);
});

test('a Claude background task reports progress, saves its result and records tokens', async () => {
  setClaudeClientForTests(fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'report_progress', input: { percent: 50, step: 'Halfway' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '# Report\nAll good.' }] },
  ]));
  const t = startClaudeTask({ name: 'Write report', instructions: 'Write it.' });
  const done = await waitFor(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
    return row.status === 'completed' || row.status === 'failed' ? row : null;
  });
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(done.result, '# Report\nAll good.');
  assert.equal(done.progress, 100);
  const pts = db.prepare('SELECT progress FROM task_progress WHERE task_id = ? ORDER BY at').all(t.id).map((r) => r.progress);
  assert.deepEqual(pts, [0, 50]);
  const usage = db.prepare("SELECT SUM(input_tokens) AS i, SUM(requests) AS r FROM usage_daily WHERE source = 'app'").get();
  assert.equal(usage.i, 200);
  assert.equal(usage.r, 2);
  const view = buildState().tasks.find((x) => x.id === t.id);
  assert.equal(view.runner, 'claude-api');
  assert.deepEqual(view.controls, ['retry', 'follow_up', 'delete']);
});

test('the assistant can act on the dashboard and the chat shows what it did', async () => {
  const toolId = db.prepare("SELECT id FROM integrations WHERE adapter = 'custom-agent'").get().id;
  const fake = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Setting it now.' }, { type: 'tool_use', id: 'tu2', name: 'set_tool_budget', input: { tool_id: toolId, budget_usd: 25 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: the budget is $25.' }] },
  ]);
  setClaudeClientForTests(fake);
  const thread = createThread();
  const events = [];
  await sendMessage(thread.id, 'Set the Agent budget to $25', (e) => events.push(e));

  assert.equal(db.prepare('SELECT budget_usd FROM integrations WHERE id = ?').get(toolId).budget_usd, 25);
  assert.ok(events.some((e) => e.type === 'tool_done' && e.ok));
  assert.equal(events.at(-1).type, 'done');
  const tr = fake.calls[1].messages.at(-1).content[0];
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.is_error, undefined);
  const items = threadView(thread.id).items;
  assert.deepEqual(items.map((i) => i.role), ['user', 'assistant', 'action', 'assistant']);
  assert.equal(items[2].ok, true);
  assert.equal(threadView(thread.id).title, 'Set the Agent budget to $25');
});

test('a failed first reply leaves the conversation valid and returns the text to resend', async () => {
  setClaudeClientForTests({ messages: { stream() { return { on() { return this; }, finalMessage: async () => { throw new Error('network down'); } }; } } });
  const thread = createThread();
  const events = [];
  await sendMessage(thread.id, 'hello', (e) => events.push(e));
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.unsent, 'hello');
  assert.equal(JSON.parse(db.prepare('SELECT messages FROM assistant_threads WHERE id = ?').get(thread.id).messages).length, 0);
});

test('after a restart, an AI team task left running shows where it stopped', async () => {
  const { recoverRuns } = await import('../server/runner.js');
  const { assistantIntegration } = await import('../server/claude.js');
  const integ = assistantIntegration();
  const now = new Date().toISOString();
  const detail = { goal: 'x', stages: [{ key: 'plan', status: 'done' }, { key: 'build', status: 'running' }, { key: 'review', status: 'pending' }] };
  const id = Number(db.prepare("INSERT INTO tasks(integration_id, external_id, name, status, kind, runner, detail, created_at, updated_at) VALUES(?, 'team-x', 'Left running', 'running', 'team', 'team', ?, ?, ?)")
    .run(integ.id, JSON.stringify(detail), now, now).lastInsertRowid);
  recoverRuns();
  const row = db.prepare('SELECT status, detail FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.deepEqual(JSON.parse(row.detail).stages.map((s) => s.status), ['done', 'failed', 'skipped']);
});
