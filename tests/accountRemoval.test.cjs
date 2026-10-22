const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

function moduleWithMocks(file, mocks) {
  const source = path.resolve(__dirname, '../dist/main/', file);
  const realRequire = createRequire(source);
  const exports = {};
  vm.runInNewContext(readFileSync(source, 'utf8'), {
    exports, URL, __dirname, process, AbortSignal, setTimeout, clearTimeout,
    require: name => mocks[name] || realRequire(name),
  });
  return exports;
}

test('removing one desktop account clears only its partition and revokes the saved token', async () => {
  const partitions = [], requests = [];
  let cleared = 0, destroyed = 0, target;
  const partition = {
    clearStorageData: async () => { cleared++; }, clearCache: async () => {},
    fetch: async (...args) => requests.push(args),
  };
  class BrowserWindow {
    constructor(options) {
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.preload, undefined);
      this.webContents = { on() {}, getURL: () => target, executeJavaScript: async () => JSON.stringify({ token: 'selected-session' }) };
    }
    async loadURL(url) { target = url; }
    destroy() { destroyed++; }
  }
  const windows = moduleWithMocks('windows.js', {
    electron: { BrowserWindow, session: { fromPartition: name => { partitions.push(name); return partition; } } },
    './serverStore': {}, './tray': {}, './screenShare': {},
  });
  await windows.forgetServerAccount({ id: 'selected', url: 'https://chat.test' });
  assert.deepEqual(partitions, ['persist:server-selected']);
  assert.equal(cleared, 1);
  assert.equal(destroyed, 1);
  assert.equal(requests[0][0], 'https://chat.test/api/auth/logout');
  assert.equal(requests[0][1].headers.Authorization, 'Bearer selected-session');
  assert.equal(requests[0][1].redirect, 'error');
});

test('cancelling an in-flight desktop handoff revokes its result instead of restoring a removed account', async () => {
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const native = moduleWithMocks('nativeAuth.js', {
    electron: { shell: { openExternal() {} }, net: { fetch: async (url, options) => {
      requests.push([url, options]);
      if (url.endsWith('/start')) return { ok: true, json: async () => ({ request_id: 'request-one', match_code: 'match' }) };
      if (url.endsWith('/exchange')) { await gate; return { ok: true, json: async () => ({ token: 'unused-session' }) }; }
      return { ok: true };
    } } },
  });
  await native.beginBrowserSignIn({ id: 'removed', url: 'https://chat.test' });
  const completion = native.completeBrowserSignIn('hasht://auth?request_id=request-one&code=test-code');
  native.cancelBrowserSignIn('removed');
  release();
  assert.equal(await completion, null);
  const logout = requests.find(([url]) => url.endsWith('/logout'));
  assert.equal(logout[0], 'https://chat.test/api/auth/logout');
  assert.equal(logout[1].headers.Authorization, 'Bearer unused-session');
  assert.equal(logout[1].redirect, 'error');
});
