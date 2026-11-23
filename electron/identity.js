/**
 * Keeps your shortcuts on the installed Meridian. During an update the installer moves the old program aside before
 * the new one is in place; if Windows looks at a shortcut in that moment, it can repoint it at another file with the
 * same name, such as a build of Meridian elsewhere on the computer. From then on that shortcut opens the other copy,
 * which updates never touch. So:
 * - a copy that isn't the installed one, opened normally, hands off to the installed one (handOffTarget), and
 * - the installed copy points Meridian's shortcuts back at itself (shortcutsToRepair).
 * Copies started with their own folders (--user-data-dir, ACC_DATA_DIR), as tests do, are left alone.
 * Pure functions here; electron/main.js does the reading, writing and launching.
 */
import path from 'node:path';

export const APP_EXE = 'Meridian.exe';

/** Two paths name the same file or folder (Windows paths compare without case). */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x) => p.resolve(String(x)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** The install folder from `reg query <HKCU\Software\{app GUID}> /v InstallLocation` output, or null. */
export function parseInstallLocation(regOutput) {
  const m = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(regOutput ?? ''));
  return m ? m[1] : null;
}

/** A launch of the app as a person opens it: not a copy started with its own folders. */
export function isNormalLaunch({ argv = process.argv, env = process.env } = {}) {
  return !env.ACC_DATA_DIR && !argv.some((a) => a.startsWith('--user-data-dir'));
}

/**
 * The installed Meridian.exe to open instead of this copy, or null to carry on here.
 * `exists(file)` checks that the installed program is there.
 */
export function handOffTarget({ execPath, installDir, packaged, platform = process.platform, argv, env, exists }) {
  if (platform !== 'win32' || !packaged || !installDir || !isNormalLaunch({ argv, env })) return null;
  if (samePath(path.win32.dirname(execPath), installDir, platform)) return null;
  const installed = path.win32.join(installDir, APP_EXE);
  return exists(installed) ? installed : null;
}

/**
 * Of Meridian's shortcuts ([{ file, link }] where link is what Electron's shell.readShortcutLink returns), the ones
 * that point at a different Meridian.exe than this installed one. Shortcuts to anything else are never touched.
 */
export function shortcutsToRepair(shortcuts, exe, platform = process.platform) {
  return shortcuts.filter(({ link }) => link?.target
    && path.win32.basename(link.target).toLowerCase() === APP_EXE.toLowerCase()
    && !samePath(link.target, exe, platform));
}
