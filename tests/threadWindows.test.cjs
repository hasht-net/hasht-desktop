const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const ROOT = "0b6f6c2e-6a0e-4c1e-9f61-2d7b3c4a5e6f";

function harness() {
  const windows = [];
  const bounds = {};
  const prompts = [];
  let request;
  let gesture;
  let nextId = 1;
  const serverSession = {
    setPermissionRequestHandler(handler) { request = handler; },
    setPermissionCheckHandler() {},
  };
  class Window {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.destroyed = false;
      this.focused = 0;
      this.webContents = { id: nextId++, mainFrame: { url: "https://chat.example.com/" }, on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    loadURL(url) { this.url = url; }
    on(name, handler) { (this.handlers[name] ??= []).push(handler); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    hide() {}
    focus() { this.focused++; }
    getBounds() { return { x: 1, y: 2, width: 500, height: 700 }; }
    emit(name) { for (const handler of this.handlers[name] ?? []) handler({ preventDefault() {} }); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../dist/main/windows.js"), "utf8"), {
    exports, URL, Date, __dirname, process: { platform: "darwin" },
    require(name) {
      if (name === "electron") return {
        app: { getVersion: () => "test" }, nativeTheme: { shouldUseDarkColors: true }, BrowserWindow: Window,
        session: { fromPartition: () => serverSession }, shell: {}, screen: { getAllDisplays: () => [] },
        ipcMain: { on(channel, handler) { if (channel === "clipboard-paste-gesture") gesture = handler; } },
        dialog: { showMessageBox: async (win) => { prompts.push(win); return { response: 0 }; } },
      };
      if (name === "./serverStore") return {
        getWindowBounds: (id) => bounds[id], setActiveServer() {},
        setWindowBounds: (id, value) => { bounds[id] = value; },
        threadWindowBoundsId: (id) => `${id}/thread`,
        getClipboardRead() {}, setClipboardRead() {},
      };
      if (name === "./tray") return { clearUnread() {} };
      if (name === "./screenShare") return { enableScreenShare() {} };
      if (name === "./spelling") return { enableSpelling() {} };
      return require(name);
    },
  });
  const entry = { id: "server", name: "Test", url: "https://chat.example.com" };
  const server = exports.openServerWindow(entry);
  const paste = (win) => {
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    gesture(event);
    return event.returnValue;
  };
  const readClipboard = (win) =>
    new Promise((resolve) => request(win.webContents, "clipboard-read", resolve, { requestingUrl: "https://chat.example.com/" }));
  return { exports, entry, server, windows, bounds, prompts, paste, readClipboard };
}

test("only a thread path opens, at the server's own origin", () => {
  const { exports, entry, windows } = harness();
  for (const bad of [
    `https://evil.example.com/threads/${ROOT}`,
    `//evil.example.com/threads/${ROOT}`,
    `/threads/${ROOT}/extra`,
    `/threads/${ROOT}?x=1`,
    `/threads/${ROOT.toUpperCase()}`,
    "/threads/not-a-uuid",
    `/channels/${ROOT}`,
    `/threads/${ROOT}\n`,
  ]) {
    assert.equal(exports.openThreadWindow(entry, bad), false, bad);
  }
  assert.equal(windows.length, 1);
  assert.equal(exports.openThreadWindow(entry, `/threads/${ROOT}`), true);
  assert.equal(windows[1].url, `https://chat.example.com/threads/${ROOT}`);
});

test("popping out the same thread again focuses its window", () => {
  const { exports, entry, windows } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].focused, 1);
  windows[1].destroy();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  assert.equal(windows.length, 3);
});

test("a thread window is a server page but not the server window", () => {
  const { exports, entry, server, windows } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  const thread = windows[1];
  assert.equal(exports.serverIdForWebContents(thread.webContents.id), "server");
  assert.equal(exports.serverWindowIdForWebContents(thread.webContents.id), undefined);
  assert.equal(exports.serverWindowIdForWebContents(server.webContents.id), "server");
  assert.equal(exports.getAllServerWindows().length, 1);
  assert.equal(exports.getAllServerPageWindows().length, 2);
  thread.destroy();
  assert.equal(exports.serverIdForWebContents(thread.webContents.id), undefined);
});

test("closing a thread window closes it instead of hiding it", () => {
  const { exports, entry, server, windows } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  let prevented = 0;
  const closeEvent = { preventDefault() { prevented++; } };
  for (const handler of windows[1].handlers.close ?? []) handler(closeEvent);
  assert.equal(prevented, 0);
  for (const handler of server.handlers.close ?? []) handler(closeEvent);
  assert.equal(prevented, 1);
});

test("thread windows share one saved size per server", () => {
  const { exports, entry, windows, bounds } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  windows[1].emit("resized");
  assert.deepEqual(bounds["server/thread"], { x: 1, y: 2, width: 500, height: 700 });
  assert.equal(bounds.server, undefined);
});

test("Paste in a thread window prompts over that window", async () => {
  const { exports, entry, server, windows, prompts, paste, readClipboard } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  const thread = windows[1];
  // A gesture in one window doesn't unlock a read from another.
  assert.equal(paste(server), true);
  assert.equal(await readClipboard(thread), false);
  assert.equal(paste(thread), true);
  assert.equal(await readClipboard(thread), true);
  assert.deepEqual(prompts, [thread]);
});

test("removing the server closes its thread windows", () => {
  const { exports, entry, server, windows } = harness();
  exports.openThreadWindow(entry, `/threads/${ROOT}`);
  exports.closeServerWindow("server");
  assert.equal(server.destroyed, true);
  assert.equal(windows[1].destroyed, true);
  assert.equal(exports.getAllServerPageWindows().length, 0);
});
