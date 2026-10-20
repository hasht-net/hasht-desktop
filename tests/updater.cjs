const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync('src/main/updater.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load({ platform = 'darwin', mas = false, packaged = true, version = '0.1.15-beta.4', response = 0, appImage = false } = {}) {
  const calls = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => calls.push('check');
  updater.quitAndInstall = () => calls.push('install');
  const exported = {};
  vm.runInNewContext(code, {
    exports: exported,
    process: { platform, mas, env: appImage ? { APPIMAGE: '/app/Hasht.AppImage' } : {} },
    console,
    setInterval: () => calls.push('interval'),
    require(name) {
      if (name === 'electron') return {
        app: { isPackaged: packaged, getVersion: () => version },
        dialog: { showMessageBox: async options => { calls.push(options.message); return { response }; } },
      };
      if (name === 'electron-updater') return { autoUpdater: updater };
      if (name === './windows') return { setQuitting: value => calls.push(`quitting:${value}`) };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { ...exported, updater, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('signed macOS beta downloads automatically and restarts with close handlers released', async () => {
  const app = load();
  app.initAutoUpdater();
  assert.equal(app.updater.autoDownload, true);
  assert.equal(app.updater.autoInstallOnAppQuit, true);
  assert.equal(app.updater.allowPrerelease, true);
  assert.deepEqual(app.calls, ['check', 'interval']);
  app.updater.emit('update-downloaded', { version: '0.1.15-beta.5' });
  await settle();
  assert.deepEqual(app.calls.slice(-2), ['quitting:true', 'install']);
});

test('Later leaves the staged update without quitting or installing immediately', async () => {
  const app = load({ response: 1 });
  app.initAutoUpdater();
  app.updater.emit('update-downloaded', { version: '0.1.15-beta.5' });
  await settle();
  assert.equal(app.calls.includes('install'), false);
  assert.equal(app.calls.includes('quitting:true'), false);
});

test('MAS and TestFlight never check the GitHub feed', async () => {
  const app = load({ mas: true });
  app.initAutoUpdater();
  await app.checkForUpdatesFromMenu();
  assert.deepEqual(app.calls, ['Updates are managed by the App Store or TestFlight.']);
});

test('stable builds on macOS and Windows reject prereleases', () => {
  for (const platform of ['darwin', 'win32']) {
    const app = load({ platform, version: '0.1.15' });
    app.initAutoUpdater();
    assert.equal(app.updater.allowPrerelease, false);
  }
});

test('manual macOS update check reports download and cleans up temporary listeners', async () => {
  const app = load();
  await app.checkForUpdatesFromMenu();
  app.updater.emit('update-available', { version: '0.1.16' });
  await settle();
  assert.deepEqual(app.calls, ['check', 'Hasht 0.1.16 is downloading.']);
  assert.equal(app.updater.listenerCount('update-not-available'), 0);
  assert.equal(app.updater.listenerCount('error'), 0);
});

test('development and package-manager installs do not auto-update; AppImage does', () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }]) {
    const app = load(options);
    app.initAutoUpdater();
    assert.deepEqual(app.calls, []);
  }
  const app = load({ platform: 'linux', appImage: true });
  app.initAutoUpdater();
  assert.ok(app.calls.includes('check'));
});
