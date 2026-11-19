/**
 * Connections that use an AI app installed on this computer and signed in with your own account, so no API key is
 * needed: Claude Code (Claude account), Codex (ChatGPT account) and Gemini CLI (Google account).
 *
 * Each one can:
 *   status()  is it installed, and is it signed in? (asks the CLI itself where it can)
 *   sync()    usage, sessions and plan limits read from the CLI's own logs on this computer
 *   engine    run a prompt through the CLI, with this app's functions available to it as an MCP server
 *   login / install   commands the app can open in a console window for you
 */
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, resolveCli, runCli } from '../local/cli.js';
import { readClaudeCode, readCodex, readGemini, geminiHome } from '../local/logs.js';
import { AdapterError, nowIso } from '../util.js';

const STATUS_TTL_MS = 60_000;
const statusCache = new Map();

const tryJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0]?.trim() || null;
export const FAKE_CALLS = /<function_calls>|<invoke name=/;

function local({ id, statusCheck, ...def }) {
  const adapter = {
    id,
    kind: 'local',
    credential: null,
    ...def,
    resolve: () => resolveCli(def.cli.bin, def.cli.candidates),

    /** { installed, version, signed_in, account, detail, checked_at }. Cached for a minute unless fresh is set. */
    async status({ fresh = false } = {}) {
      const hit = statusCache.get(id);
      if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
      const cli = adapter.resolve();
      let value;
      if (!cli) {
        value = { installed: false, version: null, signed_in: false, account: null, detail: `${def.name} isn’t installed on this computer.` };
      } else {
        try {
          const [ver, st] = await Promise.all([
            runCli(cli, ['--version'], { timeoutMs: 15_000 }).catch(() => null),
            statusCheck(cli),
          ]);
          value = { installed: true, version: ver?.code === 0 ? firstLine(ver.stdout)?.replace(/\s*\(.*\)$/, '') ?? null : null, ...st };
        } catch (err) {
          value = { installed: true, version: null, signed_in: false, account: null, detail: `Couldn’t check the sign-in: ${err.message}` };
        }
      }
      value.checked_at = nowIso();
      value.path = cli?.path ?? null;
      statusCache.set(id, { at: Date.now(), value });
      return value;
    },
    forgetStatus: () => statusCache.delete(id),

    async sync({ since, workspace }) {
      let read;
      try {
        read = def.readLogs({ since, workspace });
      } catch (err) {
        throw new AdapterError(`Couldn’t read ${def.name}’s logs: ${err.message}`);
      }
      const st = await adapter.status();
      return {
        rows: read.rows,
        sessions: read.sessions,
        meta: { account: st.account, version: st.version, limits: read.limits ?? null },
        localStatus: st,
        dataRefreshedAt: nowIso(),
      };
    },
  };
  return adapter;
}

const npmBin = (name) => (IS_WIN ? [`%APPDATA%\\npm\\${name}.cmd`] : ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, `~/.npm-global/bin/${name}`]);

// ── Claude Code ────────────────────────────────────────────────────────────
export const claudeCode = local({
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  account: 'Claude account',
  description: 'Sign in with your Claude account (Pro or Max) through Claude Code. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'none', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Claude Code app on this computer and the Claude account it is signed in with. The assistant, background tasks and the daily summary can run through it, so they count toward your plan instead of costing API tokens.',
    'Usage comes from Claude Code’s own session logs on this computer, including sessions from the Claude desktop app. Token counts are exact; cost is not shown because plan usage isn’t priced per token.',
    'Your Claude plan’s remaining limits aren’t written to those logs, so they are not shown.',
    'Sessions active in the last few minutes show as running tasks. They have no finish estimate because an interactive session has no set end.',
  ],
  cli: {
    bin: 'claude',
    candidates: [IS_WIN ? '~\\.local\\bin\\claude.exe' : '~/.local/bin/claude', ...npmBin('claude'), '~/.claude/local/claude'],
    install: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], text: 'npm install -g @anthropic-ai/claude-code', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
    login: { args: ['auth', 'login'], text: 'claude auth login', help: 'A browser window opens. Sign in with your Claude account and approve access.' },
  },
  async statusCheck(cli) {
    const r = await runCli(cli, ['auth', 'status', '--json'], { timeoutMs: 20_000 });
    const j = tryJson(r.stdout.trim());
    if (!j) return { signed_in: false, account: null, detail: firstLine(r.stderr) ?? 'Claude Code didn’t report its sign-in status.' };
    const signedIn = j.loggedIn === true;
    const method = j.authMethod && j.authMethod !== 'none' ? String(j.authMethod) : null;
    return {
      signed_in: signedIn,
      account: signedIn
        ? { email: j.email ?? j.account?.email ?? null, plan: j.subscriptionType ?? j.subscription ?? null, method, org: j.orgName ?? j.organization ?? null }
        : null,
      detail: signedIn ? null : 'Claude Code is installed but not signed in.',
    };
  },
  readLogs: readClaudeCode,
  engine: {
    label: 'Claude Code',
    via: 'your Claude account',
    invocation({ system, prompt, mcp }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--system-prompt', system, '--strict-mcp-config', '--tools', ''];
      if (mcp) args.push('--mcp-config', mcp.claudeConfigPath, '--allowedTools', 'mcp__acc');
      return { args, input: prompt };
    },
    parser(emit) {
      let sawDelta = false;
      let messages = 0;
      let result = null;
      let mcpProblem = null;
      const texts = [];
      return {
        onLine(line) {
          const o = tryJson(line);
          if (!o) return;
          if (o.type === 'system' && o.subtype === 'init') {
            // Servers can still be "pending" here while they start; only a real failure is worth mentioning.
            const s = (o.mcp_servers ?? []).find((x) => x.name === 'acc');
            if (s && /fail|error|needs-auth/i.test(s.status ?? '')) mcpProblem = `The app’s functions didn’t connect (${s.status}).`;
          } else if (o.type === 'stream_event') {
            const ev = o.event ?? {};
            if (ev.type === 'message_start') {
              if (messages++ > 0) emit({ type: 'turn' });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              sawDelta = true;
              emit({ type: 'text', delta: ev.delta.text });
            }
          } else if (o.type === 'assistant') {
            if (o.message?.model === '<synthetic>') return; // the CLI's own notices, such as "Not logged in"; reported via result
            const t = (o.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (t) texts.push(t);
            if (!sawDelta && t) emit({ type: 'text', delta: t });
          } else if (o.type === 'result') {
            result = o;
          }
        },
        finish(run) {
          if (mcpProblem) emit({ type: 'notice', text: mcpProblem });
          if (result?.is_error || (result && result.subtype && result.subtype !== 'success')) {
            const msg = typeof result.result === 'string' && result.result ? result.result : `Claude Code stopped (${result.subtype ?? 'error'}).`;
            return { error: /log ?in|sign ?in|api key|authenticat|oauth/i.test(msg) ? 'Claude Code isn’t signed in. Open Claude Code in the sidebar and choose Sign in.' : msg };
          }
          if (!result) return { error: firstLine(run.stderr) ?? `Claude Code exited without a reply (code ${run.code}).` };
          const text = typeof result.result === 'string' && result.result ? result.result : texts.at(-1) ?? '';
          // If the app's functions never reached the model, it may write imitation tool calls as text. Don't pass that off as an answer.
          if (FAKE_CALLS.test(text)) return { error: 'Claude Code couldn’t reach this app’s functions for that reply. Try again.' };
          return { text };
        },
      };
    },
  },
});

// ── Codex (ChatGPT account) ────────────────────────────────────────────────
const toml = (v) => JSON.stringify(v); // JSON strings and arrays are valid TOML values

export const codex = local({
  id: 'codex',
  name: 'Codex',
  vendor: 'OpenAI',
  account: 'ChatGPT account',
  description: 'Sign in with your ChatGPT account (Plus, Pro or Team) through the Codex CLI. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'local', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Codex CLI on this computer and the ChatGPT account it is signed in with. The assistant and background tasks can run through it.',
    'Usage and your plan’s usage limits come from Codex’s own session logs. Limits are as of the last Codex session, so they can be out of date until Codex runs again.',
    'Cost is not shown because plan usage isn’t priced per token.',
    'Codex runs read-only here: it can’t change files on this computer.',
  ],
  cli: {
    bin: 'codex',
    candidates: npmBin('codex'),
    install: { command: 'npm', args: ['install', '-g', '@openai/codex'], text: 'npm install -g @openai/codex', url: 'https://developers.openai.com/codex/cli' },
    login: { args: ['login'], text: 'codex login', help: 'A browser window opens. Sign in with your ChatGPT account.' },
  },
  async statusCheck(cli) {
    const r = await runCli(cli, ['login', 'status'], { timeoutMs: 20_000 });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const signedIn = r.code === 0 && !/not logged in/i.test(text);
    const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null;
    return {
      signed_in: signedIn,
      account: signedIn ? { email: null, plan: null, method, org: null } : null,
      detail: signedIn ? null : 'Codex is installed but not signed in.',
    };
  },
  readLogs: readCodex,
  engine: {
    label: 'Codex',
    via: 'your ChatGPT account',
    invocation({ system, prompt, mcp }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"'];
      if (mcp) {
        args.push('-c', `mcp_servers.acc.command=${toml(mcp.command)}`, '-c', `mcp_servers.acc.args=${toml(mcp.args)}`, '-c', 'mcp_servers.acc.tool_timeout_sec=180');
        if (Object.keys(mcp.env).length) args.push('-c', `mcp_servers.acc.env={${Object.entries(mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(', ')}}`);
      }
      args.push('-');
      return { args, input: `${system}\n\n---\n\n${prompt}` };
    },
    parser(emit) {
      const texts = [];
      let failed = null;
      let lastError = null;
      let done = false;
      return {
        onLine(line) {
          const o = tryJson(line);
          if (!o) return;
          if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) {
            if (texts.length) emit({ type: 'turn' });
            texts.push(o.item.text);
            emit({ type: 'text', delta: o.item.text });
          } else if (o.type === 'turn.failed') failed = o.error?.message ?? 'Codex couldn’t finish.';
          else if (o.type === 'error') lastError = o.message ?? null;
          else if (o.type === 'turn.completed') done = true;
        },
        finish(run) {
          if (failed) return { error: /log ?in|sign ?in|auth/i.test(failed) ? 'Codex isn’t signed in. Open Codex in the sidebar and choose Sign in.' : failed };
          if (!texts.length) return { error: lastError ?? firstLine(run.stderr) ?? `Codex exited without a reply (code ${run.code}).` };
          if (!done && lastError) emit({ type: 'notice', text: lastError });
          return { text: texts.at(-1) };
        },
      };
    },
  },
});

// ── Gemini CLI (Google account) ────────────────────────────────────────────
function geminiSignIn() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { method: 'API key' };
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_CLOUD_PROJECT) return { method: 'Vertex AI' };
  const home = geminiHome();
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  } catch {
    settings = null;
  }
  const selected = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? null;
  if (fs.existsSync(path.join(home, 'oauth_creds.json'))) return { method: 'Google account' };
  if (selected) return { method: String(selected) };
  return null;
}

export const geminiCli = local({
  id: 'gemini-cli',
  name: 'Gemini CLI',
  vendor: 'Google',
  account: 'Google account',
  description: 'Sign in with your Google account through the Gemini CLI. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'none', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Gemini CLI on this computer and the Google account it is signed in with. The assistant and background tasks can run through it.',
    'Usage comes from Gemini CLI’s saved chats on this computer. Cost and plan limits are not in those files, so they are not shown.',
    'Google has moved some free and Google One accounts from Gemini CLI to a newer CLI. If sign-in fails, check which one your account uses.',
  ],
  cli: {
    bin: 'gemini',
    candidates: npmBin('gemini'),
    install: { command: 'npm', args: ['install', '-g', '@google/gemini-cli'], text: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
    login: { args: [], text: 'gemini', help: 'Gemini CLI opens in a console window. Choose “Sign in with Google”, finish in the browser, then type /quit.' },
  },
  async statusCheck() {
    const s = geminiSignIn();
    return {
      signed_in: Boolean(s),
      account: s ? { email: null, plan: null, method: s.method, org: null } : null,
      detail: s ? null : 'Gemini CLI is installed but not signed in.',
    };
  },
  readLogs: readGemini,
  engine: {
    label: 'Gemini CLI',
    via: 'your Google account',
    invocation({ system, prompt, mcp }) {
      const args = ['--output-format', 'json'];
      const env = {};
      if (mcp) {
        args.push('--allowed-mcp-server-names', 'acc');
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = mcp.geminiSettingsPath;
      }
      return { args, input: `${system}\n\n---\n\n${prompt}`, env };
    },
    parser() {
      return {
        onLine() {},
        finish(run) {
          const start = run.stdout.indexOf('{');
          const j = start >= 0 ? tryJson(run.stdout.slice(start)) : null;
          if (j?.error) return { error: j.error.message ?? String(j.error) };
          if (typeof j?.response === 'string' && j.response.trim()) return { text: j.response, emitAll: true };
          return { error: firstLine(run.stderr) ?? `Gemini CLI exited without a reply (code ${run.code}).` };
        },
      };
    },
  },
});

export const LOCAL_ADAPTERS = [claudeCode, codex, geminiCli];

/** Where the CLIs run when the app uses them, so their sessions are kept apart from yours. */
export const workspaceDir = (dataDir) => path.join(dataDir, 'assistant-workspace');
