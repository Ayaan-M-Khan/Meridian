import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, nativeTheme, shell } from 'electron';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveAppFolder } from './migrate.js';
import { handOffTarget, isNormalLaunch, parseInstallLocation, samePath, shortcutsToRepair } from './identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON = path.join(root, 'public', 'icon-512.png');
// The window buttons' colors, matching the app's frame in each theme.
const TITLE_BAR = { dark: { color: '#141414', symbolColor: '#b5b5b5' }, light: { color: '#f0f0f0', symbolColor: '#4a4a4a' } };
const TITLE_BAR_HEIGHT = 35;

// The app ID stays the same through the rename to Meridian, so installs update in place and keep their taskbar pin.
// A copy run from source gets its own ID, so its taskbar button (named "Electron") never stands in for Meridian's.
const APP_ID = 'com.aicommandcenter.desktop';
app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);

// electron-builder's ID for this app: its install key (InstallLocation) and its "Installed apps" entry.
const INSTALL_KEY = String.raw`HKCU\Software\142f0647-14b0-5c03-a7de-b9cdb5cd6a52`;
const UNINSTALL_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\142f0647-14b0-5c03-a7de-b9cdb5cd6a52`;

const realPath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/** Where the installer put Meridian on this computer, or null (running from source, or installed some other way). */
const INSTALL_DIR = (() => {
  if (process.platform !== 'win32' || !app.isPackaged) return null;
  try {
    const dir = parseInstallLocation(execFileSync('reg', ['query', INSTALL_KEY, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
    return dir ? realPath(dir) : null;
  } catch {
    return null;
  }
})();
const isInstalledCopy = () => Boolean(INSTALL_DIR) && samePath(path.dirname(realPath(process.execPath)), INSTALL_DIR);

/**
 * On Windows only the installed copy shows Windows notifications, or even asks whether it can: the first time a copy
 * calls Notification.isSupported(), Electron registers it for notifications and writes a Start menu shortcut named
 * after the program (Meridian.exe → "Meridian"), pointing at that copy. A test or development copy would take over
 * Meridian's own Start menu shortcut, so the installed-copy check comes first.
 */
const canNotify = () => (process.platform !== 'win32' || isInstalledCopy()) && Notification.isSupported();

/**
 * Opened through a shortcut that points at another copy of Meridian (see identity.js): open the installed one
 * instead, with the same arguments, and close this one. Never twice in a row.
 */
function handOffToInstalledCopy() {
  if (process.env.MERIDIAN_HANDED_OFF) return false;
  const target = handOffTarget({ execPath: realPath(process.execPath), installDir: INSTALL_DIR, packaged: app.isPackaged, exists: fs.existsSync });
  if (!target) return false;
  try {
    spawn(target, process.argv.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, MERIDIAN_HANDED_OFF: '1' } }).unref();
    return true;
  } catch {
    return false;
  }
}

/** The installed copy points Meridian's Start menu, desktop and taskbar shortcuts back at itself (see identity.js). */
function repairShortcuts() {
  if (!isInstalledCopy() || !isNormalLaunch()) return;
  const files = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Meridian.lnk'),
    path.join(app.getPath('desktop'), 'Meridian.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Meridian.lnk'),
  ];
  const shortcuts = [];
  for (const file of files) {
    try {
      if (fs.existsSync(file)) shortcuts.push({ file, link: shell.readShortcutLink(file) });
    } catch {
      /* leave anything we can't read alone */
    }
  }
  for (const { file, link } of shortcutsToRepair(shortcuts, process.execPath)) {
    try {
      shell.writeShortcutLink(file, 'update', {
        target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, appUserModelId: link.appUserModelId || APP_ID,
      });
    } catch {
      /* a shortcut we can't write stays as it is */
    }
  }
}

/**
 * Up to 1.1 the app was called "AI Command Center", and Electron names the data folder after the app. Move the old
 * folder (your account, data, sign-in and window settings) to the new name the first time Meridian starts. If it
 * can't be moved, keep using it where it is, so nothing is ever left behind.
 */
function moveDataFromOldName() {
  const legacy = path.join(app.getPath('appData'), 'AI Command Center');
  const current = app.getPath('userData');
  // Only the installed app, using its normal folder: never a copy started with its own folder (--user-data-dir)
  // or its own data folder (ACC_DATA_DIR), and never when running from source.
  if (!app.isPackaged || process.env.ACC_DATA_DIR || process.argv.some((a) => a.startsWith('--user-data-dir'))) return;
  if (path.resolve(current) !== path.resolve(path.join(app.getPath('appData'), app.getName()))) return;
  if (moveAppFolder(legacy, current) === 'keep-legacy') app.setPath('userData', legacy);
}
moveDataFromOldName();

/**
 * Keeps Meridian's entry in Windows' "Installed apps" list showing the right name and version. The installer writes
 * it, but an update can occasionally leave the old version there. Only the installed copy touches it, and only its
 * name and version values.
 */
function syncInstalledAppsEntry() {
  if (!isInstalledCopy()) return;
  execFile('reg', ['query', UNINSTALL_KEY], { windowsHide: true }, (err, out) => {
    if (err) return; // installed some other way: leave it alone
    const want = { DisplayName: `Meridian ${app.getVersion()}`, DisplayVersion: app.getVersion() };
    for (const [name, value] of Object.entries(want)) {
      const has = new RegExp(String.raw`\s${name}\s+REG_SZ\s+(.*)`).exec(out)?.[1]?.trim();
      if (has !== value) execFile('reg', ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, () => {});
    }
  });
}

/** Shortcuts named "AI Command Center" that now point at a program that no longer exists are removed. */
function removeDeadOldShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const links = [
    path.join(app.getPath('desktop'), 'AI Command Center.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AI Command Center.lnk'),
  ];
  for (const lnk of links) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const { target } = shell.readShortcutLink(lnk);
      if (target && !fs.existsSync(target)) fs.unlinkSync(lnk);
    } catch {
      /* leave anything we can't read alone */
    }
  }
}

if (handOffToInstalledCopy() || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let server = null;
  let tray = null;
  let trayTimer = null;
  let quitting = false;
  let busyCount = () => 0;
  let desktopSettings = () => ({});
  // Started by Windows at sign-in: stay in the tray until opened.
  const startHidden = process.argv.includes('--hidden');

  function showWindow(hash) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  }

  function updateTrayMenu() {
    if (!tray) return;
    const busy = busyCount();
    tray.setToolTip(busy ? `Meridian · ${busy} task${busy === 1 ? '' : 's'} running` : 'Meridian');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Meridian', click: () => showWindow() },
      { label: busy ? `${busy} task${busy === 1 ? '' : 's'} running` : 'Nothing running', enabled: false },
      { label: 'Tasks', click: () => showWindow('#tasks') },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  /** The tray icon that keeps the app reachable while its window is hidden. */
  function ensureTray() {
    if (tray) return;
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', () => showWindow());
    updateTrayMenu();
    trayTimer = setInterval(updateTrayMenu, 15_000);
  }

  function removeTray() {
    clearInterval(trayTimer);
    tray?.destroy();
    tray = null;
  }

  function hideToTray(firstTime) {
    ensureTray();
    win.hide();
    if (firstTime && canNotify()) {
      new Notification({ title: 'Meridian is still running', body: 'Tasks, syncs and alerts keep going. Open it again from the icon in the system tray.', icon: ICON, silent: true }).show();
    }
  }

  app.on('second-instance', () => showWindow());

  async function boot() {
    // The desktop app keeps its own database in the user's app-data folder.
    process.env.ACC_DATA_DIR ??= path.join(app.getPath('userData'), 'data');
    const { startServer } = await import('../server/app.js');
    try {
      server = await startServer({ host: '127.0.0.1', port: 4317 });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      server = await startServer({ host: '127.0.0.1', port: 0 });
    }
    const { getSettings } = await import('../server/db.js');
    const { runningCount } = await import('../server/runner.js');
    const { teamRunningCount } = await import('../server/team.js');
    busyCount = () => runningCount() + teamRunningCount();
    desktopSettings = () => getSettings().desktop ?? {};

    const origin = `http://127.0.0.1:${server.port}`;
    Menu.setApplicationMenu(null);
    // No Windows title bar: the app's own top row is the bar, with Windows' minimize, maximize and close buttons drawn
    // over its right end in the app's colors. The window keeps its rounded corners, shadow and resizable edges.
    const startTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 380,
      minHeight: 560,
      title: 'Meridian',
      icon: ICON,
      backgroundColor: TITLE_BAR[startTheme].color, // matches the page, so there's no flash
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...TITLE_BAR[startTheme], height: TITLE_BAR_HEIGHT },
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => {
      if (startHidden) ensureTray();
      else win.show();
    });
    win.on('closed', () => (win = null));

    // Closing the window: hide to the tray when that's switched on; otherwise warn before stopping running tasks.
    let hiddenBefore = false;
    win.on('close', (event) => {
      if (quitting) return;
      if (desktopSettings().keep_running) {
        event.preventDefault();
        hideToTray(!hiddenBefore);
        hiddenBefore = true;
        return;
      }
      const busy = busyCount();
      if (!busy) return;
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        title: 'Meridian',
        message: `${busy} task${busy === 1 ? ' is' : 's are'} still running`,
        detail: 'If you quit, they stop. In the background they keep going, and the app stays in the system tray until you quit it there.',
        buttons: ['Keep running in the background', 'Quit anyway', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (choice === 1) return;
      event.preventDefault();
      if (choice === 0) {
        hideToTray(!hiddenBefore);
        hiddenBefore = true;
      }
    });

    // Hooks the server calls. Only the desktop app sets them, so server mode works without them.
    globalThis.accDesktop = { version: app.getVersion() };
    globalThis.accPickFolder = async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the AI team', properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    };
    /** New alerts become Windows notifications while the window isn't in front. Clicking one opens it. */
    globalThis.accDesktopNotify = (n) => {
      if (!canNotify() || desktopSettings().notifications === false) return;
      if (win && win.isVisible() && win.isFocused()) return;
      const note = new Notification({ title: n.title, body: n.body ?? '', icon: ICON, silent: n.severity === 'info' });
      note.on('click', () => showWindow(n.kind === 'my_task_done' ? '#tasks' : '#notifications'));
      note.show();
    };
    globalThis.accApplyDesktopSettings = (d = desktopSettings()) => {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(d.open_at_login), args: ['--hidden'] });
      if (d.keep_running) ensureTray();
      else if (win?.isVisible()) removeTray();
    };
    globalThis.accApplyDesktopSettings();
    /** The page tells the window which theme it's showing, so the window buttons match it. */
    globalThis.accSetTitleBar = (theme) => {
      if (!win || !TITLE_BAR[theme]) return;
      try {
        win.setTitleBarOverlay({ ...TITLE_BAR[theme], height: TITLE_BAR_HEIGHT });
        win.setBackgroundColor(TITLE_BAR[theme].color);
      } catch {
        /* platforms without a title bar overlay */
      }
    };
    globalThis.accOpenDataFolder = async () => {
      const err = await shell.openPath(process.env.ACC_DATA_DIR);
      if (err) throw new Error(err);
    };

    /**
     * Runs an installer the server downloaded and checked against the release (server/updates.js), then quits. The
     * installer replaces the app in place, keeps your data, and opens the app again when it's done.
     */
    const { UPDATE_DIR } = await import('../server/updates.js');
    globalThis.accInstallUpdate = async (file) => {
      if (!app.isPackaged) throw new Error('Updates install only in the installed app, not when running from source.');
      const resolved = path.resolve(String(file));
      if (path.dirname(resolved) !== path.resolve(UPDATE_DIR) || !/\.exe$/i.test(resolved) || !fs.existsSync(resolved)) throw new Error('The downloaded installer is missing. Try again.');
      spawn(resolved, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      // Give the page time to show that the app is restarting, then get out of the installer's way.
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 1500);
    };

    // Links to other sites open in the default browser, never inside the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(origin)) return;
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    });

    // On first run the window receives the one-time setup code, so nothing needs copying from a console.
    await win.loadURL(server.setupCode ? `${origin}/?setup=${encodeURIComponent(server.setupCode)}` : origin);
  }

  app.whenReady().then(() => {
    removeDeadOldShortcuts();
    syncInstalledAppsEntry();
    repairShortcuts();
    return boot();
  }).catch((err) => {
    dialog.showErrorBox('Meridian could not start', String(err?.stack ?? err));
    app.quit();
  });

  // Without the tray, closing the window quits the app, like any other desktop application.
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    removeTray();
    server?.close();
  });
}
