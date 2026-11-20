// The map's model: places come only from your connected tools, positions follow real usage, and names are escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ACC_DATA_DIR = path.join(os.tmpdir(), `acc-test-map-${process.pid}`);
process.env.ACC_DB_PATH = ':memory:';
process.env.ACC_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const { demoState, demoStats } = await import('../server/demo.js');
const { buildMapModel, mapListHtml } = await import('../public/map.js');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const h = {
  esc,
  ICON: new Proxy({}, { get: () => '<svg viewBox="0 0 16 16"></svg>' }),
  fmtNum: (n) => String(n),
  rel: () => 'soon',
  logo: () => '',
  limitMeters: () => '',
  accountLine: () => null,
  toolStatus: (t) => ({ ok: { label: 'Signed in', dot: 'ok', cls: 's-ok' }, signin: { label: 'Needs sign-in', dot: 'warn', cls: 's-warn' }, error: { label: 'Problem', dot: 'err', cls: 's-err' } })[t.status] ?? { label: t.status, dot: 'idle', cls: 's-queued' },
  hueOf: () => 'slate',
  mono: (t) => t.name.slice(0, 2),
  kindLabel: () => '',
};

test('the map has one place per connected tool, grouped by company, closer the more it was used', () => {
  const data = demoState();
  const m = buildMapModel(data, demoStats(), h);
  const expected = data.tools.filter((t) => t.enabled && (t.kind !== 'builtin' || data.engines.some((e) => e.id === 'claude-api' && e.ready)));
  assert.equal(m.nodes.length, expected.length);
  for (const n of m.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
    assert.ok(Math.hypot(n.x, n.y) > 120, 'no place sits on the command center');
  }
  const used = m.nodes.filter((n) => n.tokens).sort((a, b) => b.tokens - a.tokens);
  assert.ok(used.length >= 2);
  assert.ok(Math.hypot(used[0].x, used[0].y) <= Math.hypot(used.at(-1).x, used.at(-1).y), 'the busiest tool is nearest the center');
  for (const n of m.nodes.filter((x) => !x.tokens)) assert.equal(Math.round(Math.hypot(n.x, n.y)), 390, 'no usage reported: out at the edge, not guessed');
  const companies = new Set(m.nodes.map((n) => n.vendor));
  assert.equal(m.regions.length, companies.size);
  const routedTotal = m.nodes.reduce((s, n) => s + n.routed, 0);
  assert.equal(routedTotal, demoStats().asks.by_engine.filter((e) => m.nodes.some((n) => n.engineId === e.id)).reduce((s, e) => s + e.count, 0), 'route widths come from routing counts');
});

test('live work and team hand-offs come from the tasks themselves', () => {
  const data = demoState();
  const team = data.tasks.find((t) => t.team && t.status === 'running');
  assert.ok(team, 'the demo has a running AI team task');
  const m = buildMapModel(data, demoStats(), h);
  const runningStage = team.team.stages.find((s) => s.status === 'running');
  const node = m.nodes.find((n) => n.engineId === runningStage.engine);
  if (node) assert.ok(node.running >= 1, 'the AI doing the running stage shows live work');
  for (const t of m.team) assert.ok(t.count >= 1 && t.from && t.to && t.from !== t.to);
});

test('names on the map and in its list are escaped, so a tool name can’t inject markup', () => {
  const data = demoState();
  data.tools = [{ ...data.tools.find((t) => t.kind === 'local'), id: 99, name: '<img src=x onerror=alert(1)>', enabled: true }];
  data.engines = [];
  const m = buildMapModel(data, null, h);
  const html = mapListHtml(m, h);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(m.nodes[0].routed, 0, 'without statistics, routes are drawn as unused, not invented');
});

test('an empty setup gives an empty map, not an error', () => {
  const data = { ...demoState(), tools: [], tasks: [], engines: [] };
  const m = buildMapModel(data, null, h);
  assert.equal(m.nodes.length, 0);
  assert.equal(m.regions.length, 0);
  assert.equal(mapListHtml(m, h), '');
});
