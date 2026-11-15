// Run after npm run build: npx electron tests/electron/store.cjs
// Exercise real ESM dependencies and legacy persisted data in Electron's main
// process; the unit tests stub these dependencies and cannot catch load errors.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hasht-store-smoke-'));
app.setPath('userData', userData);
const legacy = {
  servers: [{ id: 'existing', url: 'https://example.com/', name: 'Existing', clipboardRead: 'denied' }],
  activeServerId: 'existing',
  windowBounds: { existing: { x: 10, y: 20, width: 800, height: 600 } },
  openAtLoginOffered: true,
};
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(legacy));
const timeout = setTimeout(() => { console.error('Electron smoke test timed out'); app.exit(1); }, 30_000);

app.whenReady().then(async () => {
  const storePath = require.resolve('../../dist/main/serverStore.js');
  let store = require(storePath);
  assert.deepEqual(store.listServers(), legacy.servers);
  assert.equal(store.getActiveServer().id, 'existing');
  assert.deepEqual(store.getWindowBounds('existing'), legacy.windowBounds.existing);
  assert.equal(store.getOpenAtLoginOffered(), true);
  assert.equal(store.getClipboardRead('existing'), 'denied');
  const added = store.addServer('https://new.example.com', 'New');
  store.renameServer(added.id, 'Renamed');
  delete require.cache[storePath];
  store = require(storePath);
  assert.equal(store.getActiveServer().name, 'Renamed');
  assert.equal(store.listServers().length, 2);
  store.removeServer(added.id);
  assert.deepEqual(store.listServers(), legacy.servers);
  assert.equal(store.getActiveServer().id, 'existing');
  // Also load the real updater dependency chain, which imports electron-store.
  require('../../dist/main/updater.js');
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../../dist/preload/pickerPreload.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await win.loadURL('about:blank');
  assert.equal(await win.webContents.executeJavaScript('typeof window.picker.listServers'), 'function');
  console.log(`Electron ${process.versions.electron}: legacy store, persistence, updater imports and sandboxed preload passed`);
}).then(() => {
  clearTimeout(timeout);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}).catch(error => {
  clearTimeout(timeout);
  console.error(error);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(1);
});
