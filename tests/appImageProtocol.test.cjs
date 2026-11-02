const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/main/appImageProtocol.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
function load(platform = 'linux', env = { APPIMAGE: '/apps/Hasht.AppImage' }, {
  query = 'net.hasht.app.AppImage.desktop\n', files = {}, tools = ['xdg-mime', 'update-desktop-database'], readOnly,
} = {}) {
  const calls = [];
  const disk = { ...files };
  const exports = {};
  vm.runInNewContext(code, { exports, process: { platform, env }, require(name) {
    if (name === 'node:fs') return {
      mkdirSync: (...args) => calls.push(['mkdir', ...args]),
      readFileSync: (file) => { if (!(file in disk)) throw enoent(); return disk[file]; },
      writeFileSync: (file, data, ...rest) => {
        if (file === readOnly) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        calls.push(['write', file, data, ...rest]); disk[file] = data; },
      renameSync: (from, to) => { calls.push(['rename', from, to]); disk[to] = disk[from]; delete disk[from]; },
    };
    if (name === 'node:child_process') return { execFileSync: (file, args) => {
      calls.push([file, ...args]);
      if (!tools.includes(file)) throw enoent();
      return args[0] === 'query' ? query : '';
    } };
    if (name === 'node:os') return { homedir: () => '/home/test' };
    return require(name);
  } });
  return { ...exports, calls, disk };
}
test('registers a persistent launcher with URL forwarding and verifies the association', () => {
  const app = load(); app.registerAppImageProtocol();
  const write = app.calls.find(c => c[0] === 'write');
  assert.equal(write[1], '/home/test/.local/share/applications/net.hasht.app.AppImage.desktop');
  assert.match(write[2], /Exec="\/apps\/Hasht.AppImage" %u/);
  assert.match(write[2], /MimeType=x-scheme-handler\/hasht;/);
  assert.equal(app.disk['/home/test/.config/mimeapps.list'],
    '[Default Applications]\nx-scheme-handler/hasht=net.hasht.app.AppImage.desktop\n');
  assert.deepEqual(Array.from(app.calls.at(-1)), ['xdg-mime', 'query', 'default', 'x-scheme-handler/hasht']);
});
test('honors absolute XDG_DATA_HOME and XDG_CONFIG_HOME and refreshes a moved image path', () => {
  const app = load('linux', { APPIMAGE: '/new/Hasht.AppImage', XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/cfg' });
  app.registerAppImageProtocol();
  const write = app.calls.find(c => c[0] === 'write');
  assert.equal(write[1], '/data/applications/net.hasht.app.AppImage.desktop');
  assert.match(write[2], /Exec="\/new\/Hasht.AppImage" %u/);
  assert.match(app.disk['/cfg/mimeapps.list'], /hasht=net.hasht.app.AppImage.desktop/);
});
test('works without xdg-utils or desktop-file-utils installed', () => {
  const app = load(undefined, undefined, { tools: [] });
  app.registerAppImageProtocol();
  assert.match(app.disk['/home/test/.config/mimeapps.list'], /x-scheme-handler\/hasht=net.hasht.app.AppImage.desktop/);
});
test('skips other platforms and installed Linux packages', () => {
  for (const app of [load('darwin'), load('linux', {})]) {
    app.registerAppImageProtocol(); assert.equal(app.calls.length, 0);
  }
});
test('reports a handler that overrides Hasht', () => {
  assert.throws(() => load(undefined, undefined, { query: 'other.desktop\n' }).registerAppImageProtocol(),
    /opens hasht:\/\/ links with other.desktop/);
  assert.throws(() => load(undefined, undefined, { query: '' }).registerAppImageProtocol(), /did not accept/);
});
test('reports unwritable desktop settings with the cause', () => {
  const app = load(undefined, undefined, { readOnly: '/home/test/.config/mimeapps.list.hasht-tmp' });
  assert.throws(() => app.registerAppImageProtocol(), /desktop settings could not be updated \(EACCES/);
});
test('merges into an existing mimeapps.list without losing other entries', () => {
  const app = load();
  assert.equal(app.withHashtDefault(
    '[Added Associations]\nx-scheme-handler/hasht=old.desktop;\n\n[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/hasht=old.desktop\n'),
    '[Added Associations]\nx-scheme-handler/hasht=old.desktop;\n\n[Default Applications]\nx-scheme-handler/hasht=net.hasht.app.AppImage.desktop\ntext/html=firefox.desktop\n');
  assert.equal(app.withHashtDefault('[Added Associations]\ntext/plain=gedit.desktop'),
    '[Added Associations]\ntext/plain=gedit.desktop\n\n[Default Applications]\nx-scheme-handler/hasht=net.hasht.app.AppImage.desktop\n');
});
test('escapes desktop field codes and reserved Exec characters without shell evaluation', () => {
  const app = load();
  assert.equal(app.appImageDesktopEntry('/apps/a b%"$`\\.AppImage').split('\n')[3],
    'Exec="/apps/a b%%\\\\"\\\\$\\\\`\\\\\\\\.AppImage" %u');
  for (const value of ['relative.AppImage', '/apps/bad\nExec=evil', '/apps/bad\0name']) {
    assert.throws(() => app.appImageDesktopEntry(value), /absolute path/);
  }
});
