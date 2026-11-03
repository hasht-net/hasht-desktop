const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const transpile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const code = transpile('src/main/loginItem.ts');
const protocolCode = transpile('src/main/appImageProtocol.ts');
const AUTOSTART = '/home/test/.config/autostart/net.hasht.app.desktop';

function load({ platform = 'linux', env = {}, argv = ['/opt/Hasht/hasht-desktop'], files = {}, login = {} } = {}) {
  const disk = { ...files };
  const calls = [];
  const process = { platform, env, argv, execPath: '/opt/Hasht/hasht-desktop' };
  const fsMock = {
    mkdirSync: () => {},
    readFileSync: (file) => {
      if (!(file in disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return disk[file];
    },
    writeFileSync: (file, data) => { disk[file] = data; },
    renameSync: (from, to) => { disk[to] = disk[from]; delete disk[from]; },
    rmSync: (file) => { delete disk[file]; },
  };
  const app = {
    isPackaged: true,
    getLoginItemSettings: (options) => { calls.push(['get', options]); return login; },
    setLoginItemSettings: (settings) => calls.push(['set', settings]),
  };
  const req = (name) => {
    if (name === 'electron') return { app };
    if (name === 'node:fs') return fsMock;
    if (name === 'node:os') return { homedir: () => '/home/test' };
    if (name === 'node:child_process') return { execFileSync: () => '' };
    if (name === './appImageProtocol') {
      const exports = {};
      vm.runInNewContext(protocolCode, { exports, process, require: req });
      return exports;
    }
    return require(name);
  };
  const exports = {};
  vm.runInNewContext(code, { exports, process, require: req, console });
  return { ...exports, disk, calls };
}

test('Linux packages autostart their installed binary with the login flag', () => {
  const item = load();
  assert.equal(item.isOpenAtLogin(), false);
  item.setOpenAtLogin(true);
  assert.match(item.disk[AUTOSTART], /^Exec=\/opt\/Hasht\/hasht-desktop --at-login$/m);
  assert.match(item.disk[AUTOSTART], /^TryExec=\/opt\/Hasht\/hasht-desktop$/m);
  assert.equal(item.isOpenAtLogin(), true);
  item.setOpenAtLogin(false);
  assert.equal(AUTOSTART in item.disk, false);
  assert.equal(item.isOpenAtLogin(), false);
});

test('an AppImage autostarts the image file and follows it when moved', () => {
  const item = load({ env: { APPIMAGE: '/apps/My Apps/Hasht.AppImage', XDG_CONFIG_HOME: '/xdg' } });
  item.setOpenAtLogin(true);
  const file = '/xdg/autostart/net.hasht.app.desktop';
  assert.match(item.disk[file], /^Exec="\/apps\/My Apps\/Hasht.AppImage" --at-login$/m);
  assert.match(item.disk[file], /^TryExec=\/apps\/My Apps\/Hasht.AppImage$/m);

  const moved = load({ env: { APPIMAGE: '/apps/Hasht.AppImage', XDG_CONFIG_HOME: '/xdg' }, files: item.disk });
  moved.refreshOpenAtLogin();
  assert.match(moved.disk[file], /^Exec=\/apps\/Hasht.AppImage --at-login$/m);
});

test('refresh leaves autostart alone when it is off', () => {
  const item = load({ env: { APPIMAGE: '/apps/Hasht.AppImage' } });
  item.refreshOpenAtLogin();
  assert.equal(AUTOSTART in item.disk, false);
});

test('an entry switched off in desktop settings reads as off', () => {
  for (const line of ['Hidden=true', 'X-GNOME-Autostart-enabled=false']) {
    const item = load({ files: { [AUTOSTART]: `[Desktop Entry]\nExec=/opt/Hasht/hasht-desktop\n${line}\n` } });
    assert.equal(item.isOpenAtLogin(), false, line);
  }
});

test('Windows registers and checks the Run entry with the login flag', () => {
  const item = load({ platform: 'win32', login: { openAtLogin: true, executableWillLaunchAtLogin: false } });
  item.setOpenAtLogin(true);
  // Objects from the vm context fail deepEqual's prototype check.
  assert.equal(JSON.stringify(item.calls[0]), JSON.stringify(['set', { openAtLogin: true, args: ['--at-login'] }]));
  // Disabled in Task Manager.
  assert.equal(item.isOpenAtLogin(), false);
  assert.equal(JSON.stringify(item.calls[1]), JSON.stringify(['get', { args: ['--at-login'] }]));
});

test('a login launch is detected from argv, or from macOS itself', () => {
  assert.equal(load({ argv: ['/opt/Hasht/hasht-desktop', '--at-login'] }).launchedAtLogin(), true);
  assert.equal(load().launchedAtLogin(), false);
  assert.equal(load({ platform: 'darwin', login: { wasOpenedAtLogin: true } }).launchedAtLogin(), true);
  assert.equal(load({ platform: 'darwin', login: { status: 'requires-approval' } }).loginItemNeedsApproval(), true);
});
