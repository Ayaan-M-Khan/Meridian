import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ACC_DATA_DIR = path.join(os.tmpdir(), `acc-test-${process.pid}`);
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const { db } = await import('../server/db.js');
const { encrypt, decrypt } = await import('../server/crypto.js');
const { hashPassword, verifyPassword } = await import('../server/auth.js');
const anthropic = await import('../server/adapters/anthropic.js');
const openai = await import('../server/adapters/openai.js');
const { parseTask, upsertTask } = await import('../server/ingest.js');
const { evaluateAlerts } = await import('../server/alerts.js');
const { buildState } = await import('../server/state.js');
const { demoState } = await import('../server/demo.js');
const { ruleSummary, buildFacts } = await import('../server/summary.js');

test('secrets round-trip and are bound to their row', () => {
  const blob = encrypt('sk-ant-admin-example', 7);
  assert.equal(decrypt(blob, 7), 'sk-ant-admin-example');
  assert.throws(() => decrypt(blob, 8));
});

test('passwords hash and verify', async () => {
  const h = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password!', h), false);
});

test('Anthropic rows map tokens and convert cents to dollars', () => {
  const u = anthropic.mapUsageRow({
    starting_at: '2026-11-03T00:00:00Z',
    group: { model: 'claude-opus-5-5' },
    usage: { uncached_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 7 }, cache_read_input_tokens: 30, output_tokens: 40, requests: 3 },
  });
  assert.deepEqual(u, { day: '2026-11-03', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 12, requests: 3 });
  const c = anthropic.mapCostRow({ starting_at: '2026-11-03T00:00:00Z', group: { model: 'claude-opus-5-5' }, cost: { amount: '1234.500000' } });
  assert.equal(c.cost_usd, 12.345);
});

test('Anthropic query windows stay within 31 days and add an hourly window for today', () => {
  const now = new Date('2026-11-17T10:30:00Z');
  const w = anthropic.queryWindows(new Date('2026-10-01T00:00:00Z'), now);
  assert.equal(w.at(-1).time_bucket_width, '1h');
  assert.equal(w.at(-1).starting_at, '2026-11-17T00:00:00.000Z');
  for (const x of w.slice(0, -1)) {
    assert.ok((Date.parse(x.ending_at) - Date.parse(x.starting_at)) / 86_400_000 <= 31);
  }
  assert.equal(w.at(-2).ending_at, '2026-11-17T00:00:00.000Z');
  assert.equal(anthropic.queryWindows(new Date('2026-11-17T00:00:00Z'), new Date('2026-11-17T00:20:00Z')).length, 0);
});

test('OpenAI sync pages through usage and costs and splits cached tokens', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = u.searchParams.get('page');
    if (u.pathname.endsWith('/usage/completions')) {
      const body = page
        ? { data: [{ start_time: 1763337600, results: [{ model: 'gpt-5', input_tokens: 50, input_cached_tokens: 0, output_tokens: 5, num_model_requests: 1 }] }], has_more: false }
        : { data: [{ start_time: 1763251200, results: [{ model: 'gpt-5', input_tokens: 100, input_cached_tokens: 40, output_tokens: 20, num_model_requests: 2 }] }], has_more: true, next_page: 'p2' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ start_time: 1763251200, results: [{ amount: { value: 0.5, currency: 'usd' } }, { amount: { value: 0.25, currency: 'usd' } }] }], has_more: false }), { status: 200 });
  };
  const { rows } = await openai.default.sync({ secret: 'sk-admin-test', since: new Date('2026-11-01T00:00:00Z'), fetchImpl });
  assert.equal(calls.length, 3);
  assert.deepEqual(rows[0], { day: '2025-11-16', model: 'gpt-5', input_tokens: 60, cache_read_tokens: 40, output_tokens: 20, requests: 2 });
  assert.equal(rows.find((r) => r.cost_usd != null).cost_usd, 0.75);
});

test('OpenAI auth failures become a readable message', async () => {
  const fetchImpl = async () => new Response('{}', { status: 401 });
  await assert.rejects(openai.default.test({ secret: 'bad', fetchImpl }), /Admin key/);
});

test('task reports are validated', () => {
  assert.throws(() => parseTask({ id: 'a', name: 'b', status: 'exploded' }, 0), /status must be one of/);
  assert.throws(() => parseTask({ name: 'b', status: 'running' }, 0), /needs an id/);
  assert.throws(() => parseTask({ id: 'a', name: 'b', status: 'running', progress: 140 }, 0), /progress/);
  const t = parseTask({ id: 'a', name: 'b', status: 'failed' }, 0);
  assert.ok(t.finished_at, 'finished tasks get a finish time');
});

test('state, alerts and summary work together without inventing data', () => {
  const now = new Date();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO integrations(adapter, name, budget_usd, status, created_at) VALUES('custom-agent', 'Agent', 10, 'tracked', ?)")
    .run(now.toISOString());
  const id = Number(lastInsertRowid);
  upsertTask({ id, name: 'Agent' }, parseTask({ id: 't1', name: 'Fails', status: 'failed', error: 'boom' }, 0));
  db.prepare("INSERT INTO usage_daily(integration_id, day, model, source, cost_usd) VALUES(?, ?, '', 'webhook', 9)").run(id, now.toISOString().slice(0, 10));
  evaluateAlerts(now);
  evaluateAlerts(now);

  const kinds = db.prepare('SELECT kind FROM notifications ORDER BY id').all().map((r) => r.kind);
  assert.deepEqual(kinds, ['task_failed', 'usage_warning'], 'each alert is created once');

  const s = buildState(now);
  assert.equal(s.tools[0].tokens_mtd, null, 'no token reports means unavailable, not zero');
  assert.equal(s.tools[0].cost_mtd, 9);
  assert.equal(Math.round(s.tools[0].budget_pct), 90);
  assert.equal(s.stats.failed_today, 1);
  assert.match(ruleSummary(buildFacts(s)), /1 failed/);
});

test('demo state has the live shape and is flagged', () => {
  const d = demoState();
  assert.equal(d.demo, true);
  const live = buildState();
  for (const key of Object.keys(live)) assert.ok(key in d, `demo is missing ${key}`);
  for (const key of Object.keys(live.tools[0])) assert.ok(key in d.tools[0], `demo tool is missing ${key}`);
});
