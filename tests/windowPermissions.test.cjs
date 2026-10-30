const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function permissionHandlers(platform, { dialogResponse = 0 } = {}) {
  let request;
  let check;
  let window;
  const ipcHandlers = [];
  let now = 100_000;
  const prompts = [];
  const stored = {};
  const serverSession = {
    setPermissionRequestHandler(handler) { request = handler; },
    setPermissionCheckHandler(handler) { check = handler; },
  };
  class Window {
    constructor() {
      window = this;
      this.webContents = {
        id: 1,
        mainFrame: { url: "https://chat.example.com/" },
        on() {},
        setWindowOpenHandler() {},
      };
    }
    loadURL() {}
    on() {}
  }
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../dist/main/windows.js"), "utf8"), {
    exports, URL, Date: { now: () => now }, __dirname, process: { platform },
    require(name) {
      if (name === "electron") return {
        app: { getVersion: () => "test" }, nativeTheme: { shouldUseDarkColors: true }, BrowserWindow: Window, session: { fromPartition: () => serverSession }, shell: {},
        ipcMain: { on(channel, handler) { if (channel === "clipboard-paste-gesture") ipcHandlers.push(handler); } },
        dialog: { showMessageBox: async (_win, options) => { prompts.push(options.message); return { response: dialogResponse }; } },
      };
      if (name === "./serverStore") return {
        getWindowBounds() {}, setActiveServer() {}, setWindowBounds() {},
        getClipboardRead: (id) => stored[id],
        setClipboardRead: (id, value) => { stored[id] = value; },
      };
      if (name === "./tray") return { clearUnread() {} };
      if (name === "./screenShare") return { enableScreenShare() {} };
      return require(name);
    },
  });
  exports.openServerWindow({ id: "test", name: "Test", url: "https://chat.example.com" });
  const pasteGesture = (senderFrame = window.webContents.mainFrame, sender = window.webContents) => {
    const event = { senderFrame, sender };
    ipcHandlers.forEach((handler) => handler(event));
    return event.returnValue;
  };
  const requestClipboardRead = (contents = window.webContents, url = "https://chat.example.com/") =>
    new Promise((resolve) => request(contents, "clipboard-read", resolve, { requestingUrl: url }));
  return { request, check, pasteGesture, advance: (ms) => { now += ms; }, requestClipboardRead, prompts, stored };
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
    for (const permission of ["media", "notifications", "display-capture", "clipboard-sanitized-write"]) {
      assert.equal(check(null, permission, "https://chat.example.com"), true);
    }
    for (const permission of ["automatic-fullscreen", "geolocation", "clipboard-read", "unknown"]) {
      assert.equal(check(null, permission, "https://chat.example.com"), false);
    }
  });
}

test("clipboard read is refused without a trusted Paste signal", async () => {
  const { requestClipboardRead, prompts, stored } = permissionHandlers("win32");
  assert.equal(await requestClipboardRead(), false);
  assert.equal(await requestClipboardRead(), false);
  assert.deepEqual(prompts, []);
  assert.deepEqual(stored, {});
});

test("clipboard read asks once from a context-menu Paste and remembers the answer", async () => {
  const { check, pasteGesture, requestClipboardRead, prompts, stored } = permissionHandlers("win32");
  pasteGesture();
  assert.equal(await requestClipboardRead(), true);
  assert.deepEqual(prompts, ["Allow chat.example.com to read your clipboard?"]);
  assert.deepEqual(stored, { test: "granted" });
  assert.equal(await requestClipboardRead(), true);
  assert.equal(prompts.length, 1);
  assert.equal(check(null, "clipboard-read", "https://chat.example.com"), true);
  assert.equal(check(null, "clipboard-read", "https://other.example.com"), false);
});

test("a denied clipboard read stays denied without asking again", async () => {
  const { check, pasteGesture, requestClipboardRead, prompts, stored } = permissionHandlers("win32", { dialogResponse: 1 });
  pasteGesture();
  assert.equal(await requestClipboardRead(), false);
  pasteGesture();
  assert.equal(await requestClipboardRead(), false);
  assert.equal(prompts.length, 1);
  assert.deepEqual(stored, { test: "denied" });
  assert.equal(check(null, "clipboard-read", "https://chat.example.com"), false);
});

test("clipboard read from another origin or webContents never prompts", async () => {
  const { pasteGesture, requestClipboardRead, prompts } = permissionHandlers("win32");
  pasteGesture();
  assert.equal(await requestClipboardRead(undefined, "https://other.example.com/"), false);
  assert.equal(await requestClipboardRead({ id: 2 }), false);
  assert.deepEqual(prompts, []);
});

test("a Paste signal from a subframe cannot unlock the prompt", async () => {
  const { pasteGesture, requestClipboardRead, prompts } = permissionHandlers("darwin");
  assert.equal(pasteGesture({ url: "https://chat.example.com/" }), false);
  assert.equal(await requestClipboardRead(), false);
  assert.deepEqual(prompts, []);
});

test("an expired Paste signal is consumed and cannot unlock a later request", async () => {
  const { pasteGesture, advance, requestClipboardRead, prompts } = permissionHandlers("win32");
  pasteGesture();
  advance(1001);
  assert.equal(await requestClipboardRead(), false);
  assert.equal(await requestClipboardRead(), false);
  assert.deepEqual(prompts, []);
});

test("an unregistered popup receives a reply without unlocking the server prompt", async () => {
  const { pasteGesture, requestClipboardRead, prompts } = permissionHandlers("win32");
  assert.equal(pasteGesture({ url: "https://chat.example.com/" }, { id: 2 }), false);
  assert.equal(await requestClipboardRead(), false);
  assert.deepEqual(prompts, []);
});
