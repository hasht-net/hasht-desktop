const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function permissionHandlers(platform) {
  let request;
  let check;
  const serverSession = {
    setPermissionRequestHandler(handler) { request = handler; },
    setPermissionCheckHandler(handler) { check = handler; },
  };
  class Window {
    constructor() { this.webContents = { id: 1, on() {}, setWindowOpenHandler() {} }; }
    loadURL() {}
    on() {}
  }
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../dist/main/windows.js"), "utf8"), {
    exports, URL, __dirname, process: { platform },
    require(name) {
      if (name === "electron") return {
        app: { getVersion: () => "test" }, nativeTheme: { shouldUseDarkColors: true }, BrowserWindow: Window, session: { fromPartition: () => serverSession }, shell: {},
      };
      if (name === "./serverStore") return { getWindowBounds() {}, setActiveServer() {}, setWindowBounds() {} };
      if (name === "./tray") return { clearUnread() {} };
      if (name === "./screenShare") return { enableScreenShare() {} };
      return require(name);
    },
  });
  exports.openServerWindow({ id: "test", name: "Test", url: "https://chat.example.com" });
  return { request, check };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: both fullscreen handlers allow the server and reject other origins`, () => {
    const { request, check } = permissionHandlers(platform);
    for (const [url, expected] of [
      ["https://chat.example.com/channel/test", true],
      ["https://chat.example.com", true],
      ["https://other.example.com", false],
      ["http://chat.example.com", false],
      ["https://chat.example.com:8443", false],
      ["invalid URL", false],
      [undefined, false],
    ]) {
      assert.equal(check(null, "fullscreen", url), expected);
      let granted;
      request(null, "fullscreen", (value) => { granted = value; }, { requestingUrl: url });
      assert.equal(granted, expected);
    }
    for (const permission of ["media", "notifications", "display-capture"]) {
      assert.equal(check(null, permission, "https://chat.example.com"), true);
    }
    for (const permission of ["automatic-fullscreen", "geolocation", "clipboard-read", "unknown"]) {
      assert.equal(check(null, permission, "https://chat.example.com"), false);
    }
  });
}
