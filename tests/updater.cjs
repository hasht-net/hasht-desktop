const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync('src/main/updater.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const DAY = 24 * 60 * 60 * 1000;

function load({
  platform = 'darwin', mas = false, packaged = true, version = '0.1.15-beta.4', response = 0, appImage = false,
  idle = 'idle', online = true, battery = false, audible = false, saved,
} = {}) {
  const calls = [];
  const timers = [];
  const env = { idle, online, battery, audible, now: 10 * DAY };
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => calls.push('check');
  updater.downloadUpdate = async () => calls.push('download');
  updater.quitAndInstall = () => calls.push('install');
  const power = new EventEmitter();
  power.getSystemIdleState = () => env.idle;
  power.isOnBatteryPower = () => env.battery;
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { isCurrentlyAudible: () => env.audible, send: (channel) => sent.push(channel) },
  };
  let data = { updater: saved ?? { lastCheckAt: 0, availableSince: null, queued: false } };
  const exported = {};
  vm.runInNewContext(code, {
    exports: exported,
    process: { platform, mas, env: appImage ? { APPIMAGE: '/app/Hasht.AppImage' } : {} },
    console: { error() {} },
    Date: { now: () => env.now },
    Math,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    require(name) {
      if (name === 'electron') return {
        app: { isPackaged: packaged, getVersion: () => version },
        dialog: { showMessageBox: async options => { calls.push(options.message); return { response }; } },
        net: { isOnline: () => env.online },
        powerMonitor: power,
      };
      if (name === 'electron-store') return { default: class {
        get(key) { return data[key]; }
        set(key, value) { data = { ...data, [key]: value }; }
      } };
      if (name === 'electron-updater') return { autoUpdater: updater };
      if (name === './windows') return {
        setQuitting: value => calls.push(`quitting:${value}`),
        getAllServerWindows: () => [win],
      };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  let changes = 0;
  const init = () => exported.initAutoUpdater(() => changes++);
  return {
    ...exported, init, updater, power, calls, timers, env, sent,
    saved: () => data.updater,
    changes: () => changes,
    state: () => exported.getUpdateState().state,
    // The launch check is the first timer; ticks are the rest.
    launch: async () => { await timers[0].fn(); await settle(); },
    tick: async () => { await timers.at(-1).fn(); await settle(); },
  };
}
// Objects built inside the vm context have that context's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

test('launch checks after a delay and never downloads on its own', async () => {
  const app = load();
  app.init();
  assert.equal(app.updater.autoDownload, false);
  assert.equal(app.updater.autoInstallOnAppQuit, true);
  assert.equal(app.updater.allowPrerelease, true);
  assert.deepEqual(app.calls, []);
  assert.equal(app.timers[0].ms, 60 * 1000);
  await app.launch();
  app.updater.emit('update-available', { version: '0.1.15-beta.5' });
  assert.deepEqual(app.calls, ['check']);
  assert.deepEqual(plain(app.getUpdateState()), { state: 'available', version: '0.1.15-beta.5' });
  assert.ok(app.sent.includes('update-state'));
});

test('idle ticks are fuzzy and between 20 and 40 minutes apart', () => {
  const app = load();
  app.init();
  const tick = app.timers[1].ms;
  assert.ok(tick >= 20 * 60 * 1000 && tick <= 40 * 60 * 1000);
});

test('a queued update downloads only once the user is away', async () => {
  const app = load({ idle: 'active' });
  app.init();
  await app.launch();
  app.updater.emit('update-available', { version: '0.1.16' });
  app.queueUpdate();
  assert.equal(app.state(), 'queued');
  assert.equal(app.saved().queued, true);

  await app.tick();
  assert.equal(app.calls.includes('download'), false);

  app.env.idle = 'locked';
  await app.tick();
  assert.deepEqual(app.calls, ['check', 'download']);
  assert.equal(app.state(), 'downloading');
  app.updater.emit('update-downloaded', { version: '0.1.16' });
  assert.equal(app.state(), 'ready');
});

test('locking the screen runs the same away check immediately', async () => {
  const app = load();
  app.init();
  await app.launch();
  app.updater.emit('update-available', { version: '0.1.16' });
  app.queueUpdate();
  app.power.emit('lock-screen');
  await settle();
  assert.ok(app.calls.includes('download'));
});

test('offline, battery or audible windows hold the download', async () => {
  for (const blocker of [{ online: false }, { battery: true }, { audible: true }]) {
    const app = load(blocker);
    app.init();
    await app.launch();
    app.updater.emit('update-available', { version: '0.1.16' });
    app.queueUpdate();
    await app.tick();
    assert.equal(app.calls.includes('download'), false, JSON.stringify(blocker));
  }
});

test('idle ticks check the feed at most once a day', async () => {
  const app = load();
  app.init();
  await app.launch();
  await app.tick();
  assert.deepEqual(app.calls, ['check']);
  app.env.now += DAY;
  await app.tick();
  assert.deepEqual(app.calls, ['check', 'check']);
});

test('an unqueued update downloads when idle after three days', async () => {
  const app = load();
  app.init();
  await app.launch();
  app.updater.emit('update-available', { version: '0.1.16' });
  await app.tick();
  assert.equal(app.calls.includes('download'), false);
  app.env.now += 3 * DAY;
  await app.tick();
  assert.ok(app.calls.includes('download'));
});

test('the opt-in survives a relaunch', async () => {
  const app = load({ saved: { lastCheckAt: 0, availableSince: 1, queued: true } });
  app.init();
  await app.launch();
  app.updater.emit('update-available', { version: '0.1.16' });
  assert.equal(app.state(), 'queued');
});

test('being current clears a stale opt-in', async () => {
  const app = load({ saved: { lastCheckAt: 0, availableSince: 1, queued: true } });
  app.init();
  await app.launch();
  app.updater.emit('update-not-available');
  assert.deepEqual(plain(app.saved()), { lastCheckAt: 10 * DAY, availableSince: null, queued: false });
  assert.equal(app.state(), 'none');
});

test('install restarts only once an update is staged, with close handlers released', async () => {
  const app = load();
  app.init();
  app.installUpdate();
  assert.deepEqual(app.calls, []);
  app.updater.emit('update-downloaded', { version: '0.1.16' });
  app.installUpdate();
  assert.deepEqual(app.calls, ['quitting:true', 'install']);
});

test('a downloaded update never raises a dialog by itself', async () => {
  const app = load();
  app.init();
  app.updater.emit('update-downloaded', { version: '0.1.16' });
  await settle();
  assert.deepEqual(app.calls, []);
  assert.ok(app.changes() > 0);
});

test('MAS and TestFlight never check the GitHub feed', async () => {
  const app = load({ mas: true });
  app.init();
  assert.deepEqual(app.timers, []);
  await app.checkForUpdatesFromMenu();
  assert.deepEqual(app.calls, ['Updates are managed by the App Store or TestFlight.']);
});

test('stable builds on macOS and Windows reject prereleases', () => {
  for (const platform of ['darwin', 'win32']) {
    const app = load({ platform, version: '0.1.15' });
    app.init();
    assert.equal(app.updater.allowPrerelease, false);
  }
});

test('manual check offers to wait for idle and cleans up temporary listeners', async () => {
  const app = load({ idle: 'active' });
  app.init();
  const pending = app.checkForUpdatesFromMenu();
  await pending;
  app.updater.emit('update-available', { version: '0.1.16' });
  await settle();
  assert.deepEqual(app.calls, ['check', 'Hasht 0.1.16 is available.']);
  assert.equal(app.state(), 'queued');
  assert.equal(app.updater.listenerCount('update-not-available'), 1);
  assert.equal(app.updater.listenerCount('error'), 1);
});

test('manual check can download right away', async () => {
  const app = load({ idle: 'active', response: 1 });
  app.init();
  await app.checkForUpdatesFromMenu();
  app.updater.emit('update-available', { version: '0.1.16' });
  await settle();
  assert.ok(app.calls.includes('download'));
});

test('development and package-manager installs do not auto-update; AppImage does', () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }]) {
    const app = load(options);
    app.init();
    assert.deepEqual(app.timers, []);
  }
  const app = load({ platform: 'linux', appImage: true });
  app.init();
  assert.equal(app.timers.length, 2);
});
