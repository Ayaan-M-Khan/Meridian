/**
 * Test stand-in for the Claude Code CLI. It speaks just enough of `claude -p --output-format stream-json` and
 * `claude auth status --json`, and it uses the MCP server from --mcp-config exactly as the real CLI would: it starts
 * the server, initializes it, lists its tools and calls the ones in FAKE_CLAUDE_PLAN.
 *   FAKE_CLAUDE_PLAN = {"calls":[{"tool":"name","input":{}}],"text":"final reply"}
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  out({ loggedIn: process.env.FAKE_CLAUDE_SIGNED_OUT !== '1', authMethod: 'claude.ai', email: 'test@example.com', subscriptionType: 'max' });
  process.exit(process.env.FAKE_CLAUDE_SIGNED_OUT === '1' ? 1 : 0);
}

const prompt = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, prompt, gitHooks: process.env.GIT_CONFIG_KEY_0 ? { key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 } : null })}\n`);
let plan = JSON.parse(process.env.FAKE_CLAUDE_PLAN || '{"calls":[],"text":"ok"}');

// AI team runs: FAKE_CLAUDE_TEAM = {"Planner": ["…"], "Builder": ["first reply", "second reply"]}, answered in order per role.
const system = args[args.indexOf('--system-prompt') + 1] ?? '';
const role = system.match(/You are the (\w+) in an AI team/)?.[1];
if (role && process.env.FAKE_CLAUDE_TEAM) {
  const replies = JSON.parse(process.env.FAKE_CLAUDE_TEAM)[role] ?? ['(no reply scripted)'];
  const counter = `${process.env.FAKE_CLAUDE_TEAM_DIR}/${role}.count`;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  plan = { calls: [], text: replies[Math.min(n, replies.length - 1)], access: args.includes('acceptEdits') ? 'edit' : args[args.indexOf('--tools') + 1] };
  fs.appendFileSync(`${process.env.FAKE_CLAUDE_TEAM_DIR}/calls.log`, `${JSON.stringify({ role, cwd: process.cwd(), tools: args[args.indexOf('--tools') + 1], acceptEdits: args.includes('acceptEdits') })}\n`);
}

let server = null;
const pending = new Map();
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const cfgAt = args.indexOf('--mcp-config');
let status = 'none';
const results = [];
if (cfgAt >= 0) {
  const cfg = JSON.parse(fs.readFileSync(args[cfgAt + 1], 'utf8')).mcpServers.acc;
  server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  status = init.result?.serverInfo ? 'connected' : 'failed';
  const list = await rpc('tools/list', {});
  out({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'acc', status }], tools: (list.result?.tools ?? []).map((t) => `mcp__acc__${t.name}`) });
} else {
  out({ type: 'system', subtype: 'init', mcp_servers: [], tools: [] });
}

out({ type: 'stream_event', event: { type: 'message_start' } });
if (plan.calls.length) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking.' } } });
  await new Promise((r) => setTimeout(r, 60)); // the real CLI streams text well before it calls a tool
}
for (const c of plan.calls) {
  const r = await rpc('tools/call', { name: c.tool, arguments: c.input ?? {} });
  results.push(r.result);
  out({ type: 'stream_event', event: { type: 'message_start' } });
}
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: plan.text } } });
out({ type: 'result', subtype: 'success', is_error: false, result: plan.text, usage: { input_tokens: 10, output_tokens: 5 } });
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ results })}\n`);
server?.stdin.end();
