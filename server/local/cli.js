/**
 * Finding and running the AI command-line apps installed on this computer (Claude Code, Codex, Gemini CLI).
 * Nothing here goes through a shell, so prompts and paths are passed exactly as they are.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%([A-Z_]+)%/gi, (m, v) => process.env[v] ?? m);

function pathDirs() {
  return (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
}

/** Like `which`. On Windows only real programs and .cmd launchers count, not the extensionless sh scripts npm also writes. */
export function findOnPath(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

/** The node.exe to run JavaScript programs with: the system one if there is one, otherwise this app's own runtime. */
export function nodeRuntime() {
  const sys = findOnPath('node');
  if (sys) return { command: sys, env: {} };
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/**
 * npm installs `.cmd` launchers on Windows. Node can't start those without a shell, so read the launcher and run the
 * program it points to: `"%dp0%\node_modules\@scope\pkg\cli.js" %*` becomes `node <that file>`.
 */
export function unwrapShim(file, text = fs.readFileSync(file, 'utf8')) {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => m[1]).filter((t) => !/^node(\.exe)?$/i.test(t));
  const target = targets.at(-1);
  if (!target) return null;
  const abs = path.resolve(path.dirname(file), target);
  if (/\.exe$/i.test(abs)) return { command: abs, prefix: [], env: {} };
  const localNode = path.join(path.dirname(file), 'node.exe');
  if (exists(localNode)) return { command: localNode, prefix: [abs], env: {} };
  const rt = nodeRuntime();
  return { command: rt.command, prefix: [abs], env: rt.env };
}

const resolved = new Map();

/** Locates a CLI. Returns { command, prefix, env, path } or null when it isn't installed. Cached for a minute. */
export function resolveCli(bin, candidates = []) {
  const hit = resolved.get(bin);
  if (hit && Date.now() - hit.at < 60_000) return hit.cli;
  let cli = null;
  const found = findOnPath(bin) ?? candidates.map(expandHome).find(exists) ?? null;
  if (found) {
    if (IS_WIN && /\.(cmd|bat)$/i.test(found)) {
      try {
        const r = unwrapShim(found);
        if (r && exists(r.prefix[0] ?? r.command)) cli = { ...r, path: found };
      } catch {
        cli = null;
      }
    } else {
      cli = { command: found, prefix: [], env: {}, path: found };
    }
  }
  resolved.set(bin, { at: Date.now(), cli });
  return cli;
}

export const forgetResolved = () => resolved.clear();

/**
 * Environment for the CLIs.
 * - MCP_CONNECTION_NONBLOCKING is always removed: with it, Claude Code answers before the app's functions connect.
 * - When this app itself runs inside a Claude Code session (as during development), that session's own variables
 *   are removed too, so the run behaves like one started from your desktop and uses your own sign-in.
 */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  const nested = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID);
  for (const k of Object.keys(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'MCP_CONNECTION_NONBLOCKING'].includes(k)) delete env[k];
    else if (nested && (/^CLAUDE_CODE_|^CLAUDE_AGENT_SDK_|^CLAUDE_PREVIEW_|^MCP_SERVER_/.test(k) || ['CLAUDECODE', 'CLAUDE_PID', 'ANTHROPIC_BASE_URL'].includes(k))) delete env[k];
  }
  return { ...env, ...extra };
}

/** Ends a process and everything it started. On Windows, killing the parent alone can leave its children running. */
export function killTree(child) {
  if (!child || child.exitCode != null || child.killed) return;
  if (IS_WIN && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Runs a CLI to completion. `input` goes to stdin; `onLine` sees each stdout line as it arrives.
 * Resolves { code, stdout, stderr, timedOut, aborted }; rejects only if the program can't be started.
 */
export function runCli(cli, args, { input, timeoutMs = 20_000, cwd, env, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cli.command, [...cli.prefix, ...args], {
        cwd: cwd ?? os.homedir(),
        env: childEnv({ ...cli.env, ...env }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < 4_000_000) stdout += d;
      if (!onLine) return;
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try {
            onLine(line);
          } catch (err) {
            console.error('[acc] cli line handler:', err);
          }
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 200_000) stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onLine && buf.trim()) {
        try {
          onLine(buf.replace(/\r$/, ''));
        } catch (err) {
          console.error('[acc] cli line handler:', err);
        }
      }
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
    child.stdin.on('error', () => {}); // the program may exit before reading all of stdin
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const quoteWin = (s) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Opens a console window running a command, for sign-in and install steps that need the person to interact.
 * Windows only. The window stays open afterwards so any message can be read. Returns false elsewhere.
 */
export function openConsole(command, args, { title = 'AI Command Center', cwd = os.homedir() } = {}) {
  if (!IS_WIN) return false;
  const line = [command, ...args].map(quoteWin).join(' ');
  const script = `title ${title.replace(/[&|<>^"]/g, '')} & ${line} & echo. & echo You can close this window now.`;
  const child = spawn('cmd.exe', ['/d', '/s', '/k', `"${script}"`], {
    cwd,
    env: childEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  child.on('error', (err) => console.error('[acc] open console:', err.message));
  child.unref();
  return true;
}

/** Finds files with an extension under a folder, newest first, skipping anything older than `since`. */
export function walkFiles(root, ext, { since = 0, maxDepth = 6, limit = 4000 } = {}) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(ext)) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= since) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* removed while reading */
        }
      }
    }
  };
  visit(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
