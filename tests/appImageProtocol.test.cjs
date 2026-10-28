const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/main/appImageProtocol.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
function load(platform = 'linux', env = { APPIMAGE: '/apps/Hasht.AppImage' }, result = 'net.hasht.app.AppImage.desktop\n') {
  const calls = [];
  const exports = {};
  vm.runInNewContext(code, { exports, process: { platform, env }, require(name) {
    if (name === 'node:fs') return {
      mkdirSync: (...args) => calls.push(['mkdir', ...args]),
      writeFileSync: (...args) => calls.push(['write', ...args]),
    };
    if (name === 'node:child_process') return { execFileSync: (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'query' ? result : '';
    } };
    if (name === 'node:os') return { homedir: () => '/home/test' };
    return require(name);
  } });
  return { ...exports, calls };
}
test('registers a persistent launcher with URL forwarding and verifies the association', () => {
  const app = load(); app.registerAppImageProtocol();
  const write = app.calls.find(c => c[0] === 'write');
  assert.equal(write[1], '/home/test/.local/share/applications/net.hasht.app.AppImage.desktop');
  assert.match(write[2], /Exec="\/apps\/Hasht.AppImage" %u/);
  assert.match(write[2], /MimeType=x-scheme-handler\/hasht;/);
  assert.deepEqual(Array.from(app.calls.at(-1)), ['xdg-mime', 'query', 'default', 'x-scheme-handler/hasht']);
});
test('honors absolute XDG_DATA_HOME and refreshes a moved image path', () => {
  const app = load('linux', { APPIMAGE: '/new/Hasht.AppImage', XDG_DATA_HOME: '/data' });
  app.registerAppImageProtocol();
  const write = app.calls.find(c => c[0] === 'write');
  assert.equal(write[1], '/data/applications/net.hasht.app.AppImage.desktop');
  assert.match(write[2], /Exec="\/new\/Hasht.AppImage" %u/);
});
test('skips other platforms and installed Linux packages', () => {
  for (const app of [load('darwin'), load('linux', {})]) {
    app.registerAppImageProtocol(); assert.equal(app.calls.length, 0);
  }
});
test('rejects failed association verification', () => {
  assert.throws(() => load('linux', { APPIMAGE: '/apps/Hasht.AppImage' }, '').registerAppImageProtocol(), /did not register/);
});
test('escapes desktop field codes and reserved Exec characters without shell evaluation', () => {
  const app = load();
  assert.equal(app.appImageDesktopEntry('/apps/a b%"$`\\.AppImage').split('\n')[3],
    'Exec="/apps/a b%%\\\\"\\\\$\\\\`\\\\\\\\.AppImage" %u');
  for (const value of ['relative.AppImage', '/apps/bad\nExec=evil', '/apps/bad\0name']) {
    assert.throws(() => app.appImageDesktopEntry(value), /absolute path/);
  }
});
