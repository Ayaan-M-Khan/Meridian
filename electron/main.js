import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON = path.join(root, 'public', 'icon-512.png');

app.setAppUserModelId('com.aicommandcenter.desktop');

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
    tray.setToolTip(busy ? `AI Command Center · ${busy} task${busy === 1 ? '' : 's'} running` : 'AI Command Center');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open AI Command Center', click: () => showWindow() },
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
      new Notification({ title: 'AI Command Center is still running', body: 'Tasks, syncs and alerts keep going. Open it again from the icon in the system tray.', icon: ICON, silent: true }).show();
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
    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 380,
      minHeight: 560,
      title: 'AI Command Center',
      icon: ICON,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#090a0f' : '#f4f5fa', // matches the page, so there's no flash
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
        title: 'AI Command Center',
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

  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('AI Command Center could not start', String(err?.stack ?? err));
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
