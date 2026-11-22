/**
 * Runs a prompt through a signed-in CLI (Claude Code, Codex, Gemini CLI). The app's own functions are offered to it
 * through a per-run MCP bridge (local/mcp-bridge.cjs) that calls back to this server with a one-run token, so the
 * functions run here, exactly as they do for the Claude API engine. Events go to `emit` in the chat's format.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, db, getSettings } from './db.js';
import { adapters } from './adapters/index.js';
import { FAKE_CALLS, workspaceDir } from './adapters/local.js';
import { nodeRuntime, runCli } from './local/cli.js';
import { runTool } from './assistant-tools.js';
import { HttpError, nowIso } from './util.js';
import { markUnusable } from './blocked.js';
import { gitGuardEnv } from './local/git-guard.js';

/** `unusable`: the app couldn't take the work at all (not installed, or its account can't use it), so nothing ran. */
/** Notes a run in one of your folders (see app_runs in db.js). Keeps 40 days. */
function noteAppRun(engineId, folder) {
  db.prepare('DELETE FROM app_runs WHERE started_at < ?').run(new Date(Date.now() - 40 * 86_400_000).toISOString());
  return Number(db.prepare('INSERT INTO app_runs(engine, folder, started_at) VALUES(?, ?, ?)').run(engineId, folder, nowIso()).lastInsertRowid);
}

export class EngineError extends Error {
  constructor(message, { unusable = false } = {}) {
    super(message);
    this.unusable = unusable;
  }
}

let bridgeBase = null;
/** Set once the HTTP server is listening, e.g. http://127.0.0.1:4317. */
export const setBridgeBase = (origin) => {
  bridgeBase = origin;
};

const runs = new Map(); // run id -> { token, tools, emit }
// A plain path rather than a URL, so it also reads from inside a packaged (asar) app.
const BRIDGE_SRC = fileURLToPath(new URL('./local/mcp-bridge.cjs', import.meta.url));

function bridgeScript() {
  const dir = path.join(DATA_DIR, 'bridge');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'mcp-bridge.cjs');
  // Copied out of the app's install folder, where a packaged app's files can't be run by an outside program.
  const src = fs.readFileSync(BRIDGE_SRC, 'utf8');
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current !== src) fs.writeFileSync(target, src);
  return { dir, script: target };
}

function openBridge(tools, emit) {
  if (!bridgeBase) throw new EngineError('The app’s server isn’t ready yet. Try again in a moment.');
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const { dir, script } = bridgeScript();
  const rt = nodeRuntime();
  const server = { command: rt.command, args: [script, `${bridgeBase}/api/bridge/${id}`, token], env: rt.env };
  const claudeConfigPath = path.join(dir, `run-${id}.claude.json`);
  fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { acc: { type: 'stdio', ...server } } }));
  // Cursor and Gemini CLI read MCP servers from project files in the folder they run in, so each run gets a folder
  // of its own: .cursor/mcp.json and .gemini/settings.json (trust: true lets Gemini call the app's functions unasked).
  const runDir = path.join(dir, `run-${id}`);
  fs.mkdirSync(path.join(runDir, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(runDir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(runDir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { acc: server } }));
  fs.writeFileSync(path.join(runDir, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { acc: { ...server, trust: true, timeout: 180_000 } } }));
  runs.set(id, { token, tools, emit });
  return {
    ...server,
    claudeConfigPath,
    runDir,
    close() {
      runs.delete(id);
      for (const f of [claudeConfigPath, runDir]) fs.rm(f, { force: true, recursive: true }, () => {});
    },
  };
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** True when the engine can call the app's functions; otherwise it reads a snapshot (see assistant.js). */
export const engineHasTools = (engineId) => engineId === 'claude-api' || adapters[engineId]?.engine?.mcp !== false;

/** POST /api/bridge/:run — called only by the MCP bridge of a run that is in progress. */
export async function bridgeHandler(req, res) {
  const run = runs.get(req.params.run);
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!run || !sameToken(token, run.token)) throw new HttpError(401, 'This run has ended.');
  const { op, name, arguments: args } = req.body ?? {};
  if (op === 'list') {
    res.json({ tools: run.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    return;
  }
  if (op !== 'call') throw new HttpError(400, 'Unknown bridge operation.');
  const call = {
    id: `toolu_acc_${crypto.randomBytes(9).toString('hex')}`,
    name: String(name ?? '').replace(/^mcp__acc__|^mcp_acc_/, ''),
    input: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
  };
  const tool = run.tools.find((t) => t.name === call.name);
  let label = call.name;
  try {
    label = tool ? tool.label(call.input) : call.name;
  } catch {
    label = call.name;
  }
  run.emit({ type: 'tool', label, call });
  const r = await runTool(run.tools, call);
  run.emit({ type: 'tool_done', label: r.label, ok: r.ok, error: r.error, call, result: r.result });
  res.json({ text: r.result.content, isError: !r.ok });
}

/**
 * Runs one prompt to completion through a CLI engine. Resolves { text }: the final reply.
 * emit receives {type:'text', delta} {type:'turn'} {type:'notice', text} and, for app functions it calls,
 * {type:'tool', label, call} and {type:'tool_done', label, ok, error, call, result}.
 * `folder` runs the CLI in a folder of yours instead of the app's own, with `access` 'read' or 'edit' there.
 */
export async function runCliEngine(engineId, { system, prompt, tools = [], emit = () => {}, signal, timeoutMs = 10 * 60_000, access = 'none', folder = null }) {
  const adapter = adapters[engineId];
  if (!adapter?.engine) throw new EngineError('That assistant isn’t available.');
  const cli = adapter.resolve();
  if (!cli) throw new EngineError(`${adapter.name} isn’t installed on this computer.`, { unusable: true });
  const cwd = folder ?? workspaceDir(DATA_DIR);
  fs.mkdirSync(cwd, { recursive: true });
  // Engines without MCP support (engine.mcp === false) get no functions; callers give them a snapshot instead.
  const bridge = tools.length && adapter.engine.mcp !== false ? openBridge(tools, emit) : null;
  const parser = adapter.engine.parser(emit);
  try {
    const model = getSettings().engine_models?.[engineId] || null;
    const inv = adapter.engine.invocation({ system, prompt, mcp: bridge, access: folder ? access : 'none', cwd });
    if (model) inv.args.splice(adapter.engine.modelAt ?? 0, 0, ...adapter.engine.modelArgs(model));
    let run;
    // A run in your folder, or in this run's own folder (Gemini CLI, Cursor), leaves a session in that app's logs that the
    // log readers can't tell from yours by its folder alone; noting when and where keeps it off your sessions list.
    const runCwd = inv.cwd ?? cwd;
    const runId = folder || path.resolve(runCwd) !== path.resolve(workspaceDir(DATA_DIR)) ? noteAppRun(engineId, runCwd) : null;
    try {
      // With git access, every push in this run goes through the push check (no force-pushes, no remote deletes).
      const env = folder && access === 'git' ? { ...inv.env, ...gitGuardEnv(DATA_DIR, folder) } : inv.env;
      run = await runCli(cli, inv.args, { input: inv.input, env, cwd: inv.cwd ?? cwd, timeoutMs, signal, onLine: parser.onLine });
    } catch (err) {
      throw new EngineError(`Couldn’t start ${adapter.name}: ${err.message}`);
    } finally {
      if (runId) db.prepare('UPDATE app_runs SET finished_at = ? WHERE id = ?').run(nowIso(), runId);
    }
    if (run.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    if (run.timedOut) throw new EngineError(`${adapter.name} took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
    const out = parser.finish(run);
    if (out.unusable) {
      const st = await adapter.status().catch(() => null);
      markUnusable(engineId, out.error, st?.signin_id ?? null);
      throw new EngineError(out.error, { unusable: true });
    }
    if (out.error) throw new EngineError(out.error);
    // If the app's functions never reached the model, it may write imitation tool calls as text. That's not a reply.
    if (FAKE_CALLS.test(out.text ?? '')) throw new EngineError(`${adapter.name} couldn’t reach this app’s functions for that reply. Try again.`);
    if (out.emitAll && out.text) emit({ type: 'text', delta: out.text });
    return { text: out.text ?? '' };
  } finally {
    bridge?.close();
  }
}
