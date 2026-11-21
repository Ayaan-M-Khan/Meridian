/**
 * Updates: checks the project's GitHub releases for a newer version of Meridian.
 *
 * Only the release list is read, and nothing about you or your data is sent. Public releases are read directly. When
 * the repository is private, GitHub only shows them to an account with access, so the check and the download go
 * through the GitHub CLI's own sign-in on this computer, if there is one (like the other apps here, no token is
 * handled by this app). The desktop app checks every few hours (Settings → Desktop app can turn that off) and can
 * download, verify and run the new installer for you. When run as a server, you get a link to the release instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRaw, setRaw, notify } from './db.js';
import { resolveCli, runCli } from './local/cli.js';
import { APP_VERSION } from './version.js';
import { HttpError, nowIso } from './util.js';

export const REPO = 'Ayaan-M-Khan/Meridian';
// The repository was called ai-command-center before the rename; GitHub redirects that name, and links may still use it.
const REPO_NAMES = [REPO, 'Ayaan-M-Khan/ai-command-center'];
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Installers are only ever downloaded from this project's own releases. */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const fromThisProject = (url, kind = 'releases/download/') => REPO_NAMES.some((r) => String(url ?? '').toLowerCase().startsWith(`https://github.com/${r}/${kind}`.toLowerCase()));
export const UPDATE_DIR = path.join(os.tmpdir(), 'meridian-update');
const CHECK_EVERY_MS = 6 * 3_600_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Compares two versions like 0.7.0 and v0.10.1, number by number. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

const IS_WIN = process.platform === 'win32';
/** Runs the GitHub CLI if it's installed. Returns null when it isn't. `gh` prints no token for these commands. */
async function runGh(args, timeoutMs = 20_000) {
  const gh = resolveCli('gh', [IS_WIN ? '%ProgramFiles%\\GitHub CLI\\gh.exe' : '/opt/homebrew/bin/gh']);
  if (!gh) return null;
  return runCli(gh, args, { timeoutMs }).catch(() => null);
}

/** The latest release, read directly when it's public or through the GitHub CLI's sign-in when it isn't. */
async function latestRelease(fetchImpl, gh) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Meridian-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { release: await res.json(), via: 'web' };
  if (res.status === 404) {
    const r = await gh(['api', `repos/${REPO}/releases/latest`]);
    if (r?.code === 0) {
      try {
        return { release: JSON.parse(r.stdout), via: 'gh' };
      } catch {
        /* fall through to the message below */
      }
    }
    throw new Error(r
      ? 'The releases are private and your GitHub CLI sign-in can’t see them. Run “gh auth login” with an account that has access.'
      : 'The releases are private. Install the GitHub CLI and sign in (“gh auth login”) with an account that has access, so the app can check for updates.');
  }
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now. Try again later.');
  throw new Error(`GitHub answered with an error (${res.status}).`);
}

let checking = null;
let installing = false;

/** Reads the latest release and remembers it. Raises an alert once per new version. */
export function checkForUpdate({ force = false, fetchImpl = fetch, gh = runGh, current = APP_VERSION } = {}) {
  const last = getRaw('update_check');
  if (!force && last?.checked_at && Date.now() - Date.parse(last.checked_at) < CHECK_EVERY_MS) return Promise.resolve(last);
  checking ??= (async () => {
    let out;
    try {
      const { release: r, via } = await latestRelease(fetchImpl, gh);
      const tag = String(r.tag_name ?? '');
      const asset = (r.assets ?? []).find((a) => /^[\w.-]*setup[\w.-]*\.exe$/i.test(a.name ?? '') && fromThisProject(a.browser_download_url));
      out = {
        checked_at: nowIso(),
        latest: tag.replace(/^v/i, '') || null,
        name: r.name ?? null,
        url: typeof r.html_url === 'string' && fromThisProject(r.html_url, '') ? r.html_url : `https://github.com/${REPO}/releases`,
        notes: typeof r.body === 'string' ? r.body.slice(0, 6000) : null,
        published_at: r.published_at ?? null,
        via,
        asset: asset && /^[\w.-]+$/.test(tag)
          ? { name: asset.name, url: asset.browser_download_url, tag, via, size: asset.size ?? null, sha256: /^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7).toLowerCase() : null }
          : null,
        error: null,
      };
    } catch (err) {
      out = { ...(last ?? {}), checked_at: nowIso(), error: err.name === 'TimeoutError' ? 'GitHub didn’t answer in time.' : err.message };
    }
    setRaw('update_check', out);
    if (!out.error && out.latest && current && compareVersions(out.latest, current) > 0) {
      notify({ kind: 'update', severity: 'info', title: `Meridian ${out.latest} is available`, body: `You have ${current}. Open Settings to see what’s new and install it.`, dedupe: `update:${out.latest}` });
    }
    return out;
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Runs the automatic check in the desktop app, unless it's switched off. Never throws. */
export function maybeCheckForUpdate(settings) {
  if (!globalThis.accDesktop || settings?.desktop?.check_updates === false) return;
  checkForUpdate().catch((err) => console.error('[acc] update check:', err.message));
}

/** What the UI shows about updates. */
export function updateView(current = APP_VERSION) {
  const c = getRaw('update_check');
  const available = Boolean(c?.latest && current && compareVersions(c.latest, current) > 0);
  return {
    current,
    latest: c?.latest ?? null,
    available,
    url: c?.url ?? `https://github.com/${REPO}/releases`,
    notes: available ? c.notes ?? null : null,
    published_at: c?.published_at ?? null,
    checked_at: c?.checked_at ?? null,
    error: c?.error ?? null,
    can_install: available && Boolean(c?.asset) && typeof globalThis.accInstallUpdate === 'function',
    installing,
  };
}

/**
 * Downloads the installer into a fresh folder and checks it against the release (size, and checksum when GitHub
 * lists one). Returns the file's path. Nothing is run here.
 */
export async function downloadInstaller(a, { fetchImpl = fetch, gh = runGh, dir = UPDATE_DIR } = {}) {
  if (!fromThisProject(a?.url) || !/^[\w.-]+$/.test(a.name ?? '') || !/^[\w.-]+$/.test(a.tag ?? '')) throw new Error('That download isn’t from Meridian’s releases.');
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, a.name);
  if (a.via === 'gh') {
    const r = await gh(['release', 'download', a.tag, '--repo', REPO, '--pattern', a.name, '--dir', dir, '--clobber'], DOWNLOAD_TIMEOUT_MS);
    if (r?.code !== 0) throw new Error('The GitHub CLI couldn’t download the update. Check that it’s still signed in (“gh auth status”) and try again.');
  } else {
    const res = await fetchImpl(a.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The download failed (${res.status}). Try again.`);
    await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  let buf;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    throw new Error('The download didn’t arrive. Try again.');
  }
  if (a.size && buf.length !== a.size) throw new Error('The download was incomplete. Try again.');
  if (a.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== a.sha256) throw new Error('The download didn’t match the release, so it wasn’t installed. Try again.');
  return file;
}

/** Downloads, checks and runs the new installer (desktop app only). The app closes, updates and opens again. */
export async function installUpdate({ busy = 0, download = downloadInstaller } = {}) {
  const c = getRaw('update_check');
  if (typeof globalThis.accInstallUpdate !== 'function') throw new HttpError(501, 'Updates install from the desktop app. Download the new version from the release page.');
  if (!c?.latest || compareVersions(c.latest, APP_VERSION) <= 0) throw new HttpError(400, 'You already have the newest version.');
  if (!c.asset) throw new HttpError(400, 'This release has no installer to download. Use the release page.');
  if (busy > 0) throw new HttpError(409, `${busy} task${busy === 1 ? ' is' : 's are'} still running. Install the update when ${busy === 1 ? 'it finishes' : 'they finish'}, or cancel ${busy === 1 ? 'it' : 'them'} first.`);
  if (installing) throw new HttpError(409, 'The update is already downloading.');
  installing = true;
  try {
    const file = await download(c.asset);
    await globalThis.accInstallUpdate(file);
    return { ok: true, version: c.latest };
  } catch (err) {
    installing = false;
    throw err instanceof HttpError ? err : new HttpError(502, err.message);
  }
}
