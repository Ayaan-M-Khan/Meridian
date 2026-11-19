import { app, BrowserWindow, Menu, dialog, nativeTheme, shell } from 'electron';
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

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

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
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => (win = null));

    // The server asks for this when you choose a folder for an AI team task.
    globalThis.accPickFolder = async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the AI team', properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
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

  // Closing the window quits the app, like any other desktop application.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => server?.close());
}
