'use strict';

const { app, BrowserWindow, ipcMain, dialog, globalShortcut, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Vault } = require('./vault');
const { Indexer } = require('./indexer');

let mainWindow = null;
let captureWindow = null;
let vault = null;
const indexer = new Indexer();
let watcher = null;
let watchDebounce = null;
const selfWrites = new Map(); // rel path -> timestamp (ignore our own fs.watch echoes)

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------- vault / index ----------
function defaultVaultPath() {
  return path.join(app.getPath('documents'), 'Quillpad');
}

function rebuildIndex() {
  indexer.files.clear();
  for (const { path: rel, content } of vault.readAll()) {
    indexer.setFile(rel, content);
  }
}

function openVault(root) {
  vault = new Vault(root);
  if (vault.listNotes().length === 0) {
    vault.write(
      'Welcome.md',
      [
        '# Welcome to Quillpad 🪶',
        '',
        'Your notes are **plain .md files** in this folder — open it in Explorer and see.',
        'No database. No cloud. No subscription.',
        '',
        '## Try things',
        '- Link to another note with [[Ideas]] — click it to create + follow.',
        '- Tag anything with #getting-started, then click the tag in the sidebar.',
        '- Press `Ctrl+D` for today\'s daily note, `Ctrl+P` to switch notes fast.',
        '- Press `Ctrl+Shift+N` anywhere in Windows for quick capture → [[inbox]].',
        '- Press `Ctrl+E` to toggle full preview, `Ctrl+F` to search everything.',
        '',
      ].join('\n')
    );
  }
  rebuildIndex();
  startWatcher();
  saveSettings({ vaultPath: vault.root });
}

function markSelfWrite(rel) {
  selfWrites.set(rel.toLowerCase(), Date.now());
}

function startWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  try {
    watcher = fs.watch(vault.root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join('/');
      if (rel.startsWith('.') || rel.includes('/.')) return;
      const t = selfWrites.get(rel.toLowerCase());
      if (t && Date.now() - t < 1500) return; // our own write
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        try {
          rebuildIndex();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('vault-changed');
          }
        } catch (err) {
          console.error('watch refresh failed:', err);
        }
      }, 250);
    });
  } catch (err) {
    console.error('fs.watch failed:', err);
  }
}

// ---------- windows ----------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#0f1115',
    title: 'Quillpad',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  captureWindow = new BrowserWindow({
    width: 560,
    height: 180,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, 'capture', 'capture.html'));
  captureWindow.on('blur', () => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
  });
  captureWindow.on('closed', () => {
    captureWindow = null;
  });
}

// ---------- ipc ----------
function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault-changed');
}

function registerIpc() {
  ipcMain.handle('vault:info', () => ({ root: vault.root }));

  ipcMain.handle('vault:choose', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose your vault folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    openVault(res.filePaths[0]);
    return { root: vault.root };
  });

  ipcMain.handle('vault:openInExplorer', () => shell.openPath(vault.root));

  ipcMain.handle('tree:list', () => vault.tree());

  ipcMain.handle('note:read', (e, rel) => vault.read(rel));

  ipcMain.handle('note:write', (e, rel, content) => {
    markSelfWrite(rel);
    vault.write(rel, content);
    indexer.setFile(rel, content);
    return true;
  });

  ipcMain.handle('note:create', (e, rel, content) => {
    const actual = vault.create(rel, content || '');
    markSelfWrite(actual);
    indexer.setFile(actual, content || '');
    notifyChanged();
    return actual;
  });

  ipcMain.handle('note:rename', (e, oldRel, newRel) => {
    const actual = vault.rename(oldRel, newRel);
    markSelfWrite(oldRel);
    markSelfWrite(actual);
    if (/\.md$/i.test(actual)) indexer.renameFile(oldRel, actual);
    else rebuildIndex(); // folder rename moves many files
    notifyChanged();
    return actual;
  });

  ipcMain.handle('note:move', (e, rel, destFolder) => {
    const actual = vault.move(rel, destFolder);
    markSelfWrite(rel);
    markSelfWrite(actual);
    if (/\.md$/i.test(actual)) indexer.renameFile(rel, actual);
    else rebuildIndex();
    notifyChanged();
    return actual;
  });

  ipcMain.handle('note:delete', (e, rel) => {
    markSelfWrite(rel);
    vault.remove(rel);
    rebuildIndex();
    notifyChanged();
    return true;
  });

  ipcMain.handle('folder:create', (e, rel) => {
    const actual = vault.mkdir(rel);
    notifyChanged();
    return actual;
  });

  ipcMain.handle('index:names', () =>
    indexer.paths().map((p) => ({
      path: p,
      name: p.split('/').pop().replace(/\.md$/i, ''),
    }))
  );

  ipcMain.handle('index:backlinks', (e, rel) => indexer.backlinksTo(rel));

  ipcMain.handle('index:tags', () => {
    const map = indexer.tagMap();
    return [...map.entries()].map(([tag, paths]) => ({ tag, paths }));
  });

  ipcMain.handle('index:resolve', (e, target) => indexer.resolve(target));

  ipcMain.handle('search:query', (e, q) => vault.search(q));

  ipcMain.handle('daily:open', () => {
    const rel = Vault.dailyPath();
    const existed = vault.exists(rel);
    markSelfWrite(rel);
    const actual = vault.openDaily();
    if (!existed) {
      indexer.setFile(actual, vault.read(actual));
      notifyChanged();
    }
    return actual;
  });

  ipcMain.handle('capture:append', (e, text) => {
    if (String(text).trim()) {
      markSelfWrite('inbox.md');
      vault.appendInbox(text);
      indexer.setFile('inbox.md', vault.read('inbox.md'));
      notifyChanged();
    }
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
    return true;
  });

  ipcMain.handle('capture:close', () => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
    return true;
  });
}

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const settings = loadSettings();
  openVault(settings.vaultPath || defaultVaultPath());
  registerIpc();
  createMainWindow();

  const ok = globalShortcut.register('CommandOrControl+Shift+N', () => createCaptureWindow());
  if (!ok) console.warn('Quick-capture shortcut (Ctrl+Shift+N) already taken by another app.');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (watcher) watcher.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
