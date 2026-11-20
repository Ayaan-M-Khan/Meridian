/**
 * A tiny MCP server (stdio, newline-delimited JSON-RPC) that Claude Code, Codex or Gemini CLI start when AI Command
 * Center runs a prompt through them. It has no tools of its own: it relays tools/list and tools/call to the app over
 * 127.0.0.1, using a token that is valid only for that one run.
 *   node mcp-bridge.cjs <bridge url> <run token>
 * Self-contained on purpose (Node built-ins only), because the app copies it outside its install folder to run it.
 */
'use strict';
const http = require('node:http');

const [url, token] = process.argv.slice(2);
if (!url || !token) {
  process.stderr.write('usage: mcp-bridge.cjs <url> <token>\n');
  process.exit(2);
}

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${token}` },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (res.statusCode !== 200 || !json) reject(new Error(json?.error || `Meridian returned HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.on('error', (err) => reject(new Error(`Can’t reach Meridian: ${err.message}`)));
    req.end(data);
  });
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification, such as notifications/initialized
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'meridian', version: '1.0.0' },
          instructions: 'Functions of Meridian, the dashboard the person uses to track their AI tools.',
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list': {
        const r = await post({ op: 'list' });
        return reply(id, { tools: r.tools });
      }
      case 'tools/call': {
        const r = await post({ op: 'call', name: params?.name, arguments: params?.arguments ?? {} });
        return reply(id, { content: [{ type: 'text', text: String(r.text ?? '') }], isError: Boolean(r.isError) });
      }
      case 'resources/list':
        return reply(id, { resources: [] });
      case 'prompts/list':
        return reply(id, { prompts: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(id, -32603, err.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
