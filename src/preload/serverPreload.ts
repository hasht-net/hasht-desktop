import { contextBridge, ipcRenderer } from "electron";

// Runs inside the untouched app page with contextIsolation on — this is the
// only bridge between a (possibly untrusted, self-hosted-by-someone-else)
// server's page and the privileged main process. Keep this list minimal:
// mirrors Mattermost Desktop's approach of a locked-down preload rather than
// exposing ipcRenderer/Node directly to the renderer.
contextBridge.exposeInMainWorld("chatDesktop", {
  isDesktopApp: true,
  openSecurityManagement: (ticket: string) => ipcRenderer.invoke("account:open-security-management", ticket),
  // Resolves with the code from the browser's hasht://step-up callback, or null.
  runSecurityStepUp: (ticket: string) => ipcRenderer.invoke("account:run-security-step-up", ticket),
  cancelSecurityStepUp: () => ipcRenderer.invoke("account:cancel-security-step-up"),
  openSecuritySettings: (userId: string) => ipcRenderer.invoke("account:open-security", userId),
  getDateTimePreferences: () => ipcRenderer.invoke("date-time:preferences"),
  // Supplied by the main process (see additionalArguments in windows.ts),
  // same as titlebarHeight() below — the page's About panel shows this
  // alongside its own frontend version.
  appVersion: appVersion(),
  // All platforms now, not just macOS: Electron has no browser extensions,
  // so 1Password-style passkeys never show up in the in-page picker.
  needsBrowserSignIn: true,
  // Browser runs the ceremony; page collects the session via takePendingAuth.
  supportsBrowserRegistration: true,
  cancelPasskeySignIn: () => ipcRenderer.invoke("native-auth:cancel"),
  startPasskeySignIn: (options?: unknown) => ipcRenderer.invoke("native-auth:start", options),
  takePendingAuth: () => ipcRenderer.invoke("native-auth:take"),
  // Who is signed in, for the server picker. Names only, never a token.
  setAccount: (account: { username: string | null; displayName: string | null }) =>
    ipcRenderer.invoke("account:set", account),
  // Coarse system activity keeps mobile push quiet while the user works in
  // another app. Main checks the window and returns only active/idle/unknown.
  getSystemActivity: () => ipcRenderer.invoke("system-activity:state"),
  // Screen sharing. The capture itself goes through getDisplayMedia (the main
  // process installs the handler that answers it); these two cover the part
  // the page can't see — macOS grants screen recording to the app, and neither
  // the status nor the way back from a denial is reachable from a web page.
  getScreenCaptureStatus: () => ipcRenderer.invoke("screen-capture:status"),
  openScreenCaptureSettings: () =>
    ipcRenderer.invoke("screen-capture:open-settings"),
  // Where a share can carry the computer's audio, so the page offers the
  // switch our pickers lack: loopback on Windows, and the macOS 15+ system
  // picker. Electron's own picker path on older macOS never delivers audio.
  systemAudioShare:
    process.platform === "win32" ||
    (process.platform === "darwin" &&
      Number(process.getSystemVersion().split(".")[0]) >= 15),
  // Windows/Linux caption buttons. The page passes the bar color; main
  // checks it's a plain hex before handing it to the overlay.
  setWindowButtons: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.send("desktop-theme", colors),
  // The window bar's update button. Changes arrive as a hasht:update-state
  // event, after which the page reads the state again.
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  queueUpdate: () => ipcRenderer.invoke("update:queue"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
});

// A notification's onclick calls window.focus(), which in Electron can't show
// a window that was closed (hidden) to the tray — the page navigated to the
// message in a window the user couldn't see. Wrap the page's Notification so a
// real click also asks main to raise this window; isTrusted keeps the page
// from raising itself with a synthetic click event.
contextBridge.executeInMainWorld({
  func: (raise: () => void) => {
    const Native = window.Notification;
    if (typeof Native !== "function") return;
    window.Notification = class extends Native {
      constructor(title: string, options?: NotificationOptions) {
        super(title, options);
        this.addEventListener("click", (event) => {
          if (event.isTrusted) raise();
        });
      }
    };
  },
  args: [() => ipcRenderer.send("notification-clicked")],
});

// The app already renders unread *channel* count (not message count) into
// document.title as "(N) ..." (see frontend/src/App.vue) for the browser-tab
// case. Reuse that signal for the tray badge/icon instead of asking the web
// app to change anything.
function reportTitle() {
  const match = document.title.match(/^\((\d+)\)/);
  const unread = match ? parseInt(match[1], 10) : 0;
  ipcRenderer.send("unread-count-changed", unread);
}

// Supplied by the main process (see additionalArguments in windows.ts) rather
// than hardcoded, because the height differs per platform — Windows caption
// buttons don't fit in macOS's 28px.
function titlebarHeight(): number {
  const arg = process.argv.find((a) => a.startsWith("--titlebar-height="));
  const parsed = arg ? parseInt(arg.split("=")[1], 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 28;
}

// Same argv-flag approach as titlebarHeight() — a sandboxed preload has no
// access to the main-process `app` module.
function appVersion(): string {
  const arg = process.argv.find((a) => a.startsWith("--app-version="));
  return arg ? arg.slice("--app-version=".length) : "unknown";
}

// Relayed as a DOM event since contextBridge can't push into the page directly.
ipcRenderer.on("show-about", () => {
  window.dispatchEvent(new Event("hasht:show-about"));
});
ipcRenderer.on("update-state", () => {
  window.dispatchEvent(new Event("hasht:update-state"));
});

// Tells the page it is running frameless so it can reserve room for the
// window controls and mark a drag region. The app owns the layout; the shell
// only supplies the flag and the height.
window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  root.style.setProperty("--desktop-titlebar-h", `${titlebarHeight()}px`);
  root.classList.add("desktop-shell");
});

window.addEventListener("DOMContentLoaded", () => {
  reportTitle();
  // Observe <head> rather than <title> directly: if the SPA ever replaces
  // the title element instead of mutating its text, a direct observer would
  // go silently dead. Also covers <title> not existing yet at DOMContentLoaded.
  new MutationObserver(reportTitle).observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });
});

// Observe browser-generated events in the isolated world. The page cannot call
// this channel or turn a synthetic menu click into permission to show a prompt.
// Keep the selectors in step with MarkdownComposer's clipboard menu.
let clipboardMenuOpenedAt: number | null = null;
window.addEventListener("contextmenu", (event) => {
  clipboardMenuOpenedAt = event.isTrusted && event.target instanceof Element && event.target.closest(".md-composer")
    ? Date.now() : null;
}, true);
window.addEventListener("pointerdown", (event) => {
  if (event.isTrusted && !(event.target instanceof Element && event.target.closest(".composer-clipboard-menu"))) {
    clipboardMenuOpenedAt = null;
  }
}, true);
window.addEventListener("keydown", (event) => {
  if (event.isTrusted && !["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) {
    clipboardMenuOpenedAt = null;
  }
}, true);
window.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  const openedAt = clipboardMenuOpenedAt;
  clipboardMenuOpenedAt = null;
  if (openedAt === null || Date.now() - openedAt > 30_000 || !(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(".composer-clipboard-menu button[role=menuitem]");
  if (!button || button.disabled || button.querySelector("span")?.textContent?.trim() !== "Paste") return;
  ipcRenderer.sendSync("clipboard-paste-gesture");
}, true);
