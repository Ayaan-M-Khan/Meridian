import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveAppFolder } from './migrate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON = path.join(root, 'public', 'icon-512.png');
// The window buttons' colors, matching the app's frame in each theme.
const TITLE_BAR = { dark: { color: '#141414', symbolColor: '#b5b5b5' }, light: { color: '#f0f0f0', symbolColor: '#4a4a4a' } };
const TITLE_BAR_HEIGHT = 35;

// The app ID stays the same through the rename to Meridian, so installs update in place and keep their taskbar pin.
app.setAppUserModelId('com.aicommandcenter.desktop');

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

if (!app.requestSingleInstanceLock()) {
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
    if (firstTime && Notification.isSupported()) {
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
      if (!Notification.isSupported() || desktopSettings().notifications === false) return;
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
