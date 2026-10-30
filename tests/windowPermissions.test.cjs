const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function permissionHandlers(platform, { dialogResponse = 0 } = {}) {
  let request;
  let check;
  let window;
  const inputHandlers = [];
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
        on(event, handler) { if (event === "input-event") inputHandlers.push(handler); },
        setWindowOpenHandler() {},
      };
    }
    loadURL() {}
    on() {}
  }
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../dist/main/windows.js"), "utf8"), {
    exports, URL, __dirname, process: { platform },
    require(name) {
      if (name === "electron") return {
        app: { getVersion: () => "test" }, nativeTheme: { shouldUseDarkColors: true }, BrowserWindow: Window, session: { fromPartition: () => serverSession }, shell: {},
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
  const userInput = (input) => inputHandlers.forEach((handler) => handler({}, { modifiers: [], ...input }));
  const rightClickThenPaste = () => {
    userInput({ type: "mouseDown", button: "right" });
    userInput({ type: "mouseUp", button: "left" });
  };
  const requestClipboardRead = (contents = window.webContents, url = "https://chat.example.com/") =>
    new Promise((resolve) => request(contents, "clipboard-read", resolve, { requestingUrl: url }));
  return { request, check, userInput, rightClickThenPaste, requestClipboardRead, prompts, stored };
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

test("clipboard read is refused without a prompt unless the user is picking from a context menu", async () => {
  const { userInput, requestClipboardRead, prompts, stored } = permissionHandlers("win32");
  assert.equal(await requestClipboardRead(), false);
  userInput({ type: "rawKeyDown", key: "a" });
  userInput({ type: "mouseUp", button: "left" });
  assert.equal(await requestClipboardRead(), false);
  assert.deepEqual(prompts, []);
  assert.deepEqual(stored, {});
});

test("clipboard read asks once from a context-menu Paste and remembers the answer", async () => {
  const { check, rightClickThenPaste, requestClipboardRead, prompts, stored } = permissionHandlers("win32");
  rightClickThenPaste();
  assert.equal(await requestClipboardRead(), true);
  assert.deepEqual(prompts, ["Allow chat.example.com to read your clipboard?"]);
  assert.deepEqual(stored, { test: "granted" });
  assert.equal(await requestClipboardRead(), true);
  assert.equal(prompts.length, 1);
  assert.equal(check(null, "clipboard-read", "https://chat.example.com"), true);
  assert.equal(check(null, "clipboard-read", "https://other.example.com"), false);
});

test("a denied clipboard read stays denied without asking again", async () => {
  const { check, userInput, rightClickThenPaste, requestClipboardRead, prompts, stored } = permissionHandlers("win32", { dialogResponse: 1 });
  userInput({ type: "rawKeyDown", key: "F10", modifiers: ["shift"] });
  userInput({ type: "rawKeyDown", key: "Enter" });
  assert.equal(await requestClipboardRead(), false);
  rightClickThenPaste();
  assert.equal(await requestClipboardRead(), false);
  assert.equal(prompts.length, 1);
  assert.deepEqual(stored, { test: "denied" });
  assert.equal(check(null, "clipboard-read", "https://chat.example.com"), false);
});

test("clipboard read from another origin or webContents never prompts", async () => {
  const { rightClickThenPaste, requestClipboardRead, prompts } = permissionHandlers("win32");
  rightClickThenPaste();
  assert.equal(await requestClipboardRead(undefined, "https://other.example.com/"), false);
  assert.equal(await requestClipboardRead({ id: 2 }), false);
  assert.deepEqual(prompts, []);
});

test("macOS control-click opens the context menu that can prompt", async () => {
  const { userInput, requestClipboardRead, prompts } = permissionHandlers("darwin");
  userInput({ type: "mouseDown", button: "left", modifiers: ["control"] });
  userInput({ type: "mouseUp", button: "left" });
  assert.equal(await requestClipboardRead(), true);
  assert.equal(prompts.length, 1);
});
