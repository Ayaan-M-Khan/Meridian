/**
 * Which AI the assistant, background tasks and the daily summary run through. A signed-in app on this computer
 * (Claude Code, Codex, Gemini CLI) needs no API key; the Claude API engine uses the key from Settings.
 */
import { db, getSettings } from './db.js';
import { LOCAL_ADAPTERS } from './adapters/local.js';
import { hasClaudeApi } from './claude.js';
import { HttpError } from './util.js';
import { routeTask } from './router.js';

const ORDER = ['claude-code', 'claude-api', 'codex', 'gemini-cli', 'antigravity-cli', 'copilot-cli', 'cursor-cli'];

const NOT_READY = {
  missing: (n) => `${n} isn’t installed on this computer.`,
  signin: (n) => `${n} isn’t signed in.`,
  pending: (n) => `Still checking ${n}.`,
  error: (n) => `${n} has a problem. Open it in the sidebar to see what’s wrong.`,
};

export function listEngines() {
  const ints = db.prepare('SELECT id, adapter, enabled, status FROM integrations').all();
  const out = LOCAL_ADAPTERS.map((a) => {
    const i = ints.find((x) => x.adapter === a.id);
    const ready = Boolean(i?.enabled && i.status === 'ok');
    return {
      id: a.id,
      label: a.engine.label,
      via: a.engine.via,
      vendor: a.vendor,
      kind: 'cli',
      tools: a.engine.mcp !== false,
      integration_id: i?.id ?? null,
      ready,
      reason: ready ? null : !i ? `Connect ${a.name} first.` : !i.enabled ? `${a.name} is turned off.` : (NOT_READY[i.status] ?? NOT_READY.error)(a.name),
    };
  });
  const api = hasClaudeApi();
  out.push({ id: 'claude-api', label: 'Claude API', via: 'your Claude API key', vendor: 'Anthropic', kind: 'api', tools: true, integration_id: null, ready: api, reason: api ? null : 'Add a Claude API key in Settings.' });
  return out.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

/**
 * The engine to use: the one asked for, the one chosen in Settings, or, on Automatic, the best AI for this request
 * (router.js) when there's text to judge by, else the first that is ready. Throws a readable error.
 * A routed engine carries `route`: { category, label, why }.
 */
export function chooseEngine(id, { text = null, needsTools = false } = {}) {
  const want = id ?? getSettings().assistant_engine ?? 'auto';
  const list = listEngines();
  if (want !== 'auto') {
    const e = list.find((x) => x.id === want);
    if (!e) throw new HttpError(400, 'That assistant isn’t available.');
    if (!e.ready) throw new HttpError(400, e.reason);
    return e;
  }
  if (text) {
    const r = routeTask(text, { needsTools });
    if (r) return { ...r.engine, route: { category: r.category, label: r.label, why: r.why } };
  }
  const e = list.find((x) => x.ready);
  if (!e) throw new HttpError(400, 'To use the assistant, connect Claude Code, Codex, Gemini, GitHub Copilot or Cursor with your account, or add a Claude API key in Settings.');
  return e;
}

export function currentEngine() {
  try {
    return chooseEngine();
  } catch {
    return null;
  }
}
