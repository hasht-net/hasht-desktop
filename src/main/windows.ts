import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
} from "electron";
import path from "node:path";
import type { ServerEntry } from "./serverStore";
import {
  getActiveServer,
  getClipboardRead,
  getWindowBounds,
  setActiveServer,
  setClipboardRead,
  setWindowBounds,
  threadWindowBoundsId,
} from "./serverStore";
import { clearUnread } from "./tray";
import { enableScreenShare } from "./screenShare";
import { enableSpelling } from "./spelling";

// Height of the draggable strip the page reserves at the top of the window.
// macOS traffic lights are small and inset (28px fits); Windows caption
// buttons need the system's own 32px title bar height or Electron's overlay
// controls won't fit.
export const TITLEBAR_HEIGHT = process.platform === "darwin" ? 28 : 32;

// Caption-button overlay, Windows/Linux only. `color` is a solid rectangle
// behind the buttons, so it has to be the same color the page paints the
// window bar — --bg-rail in the web app (desktop-shell flattens the top of
// every column to it). These are the first-paint guess; the page sends the
// live tokens once it knows the theme (see setWindowButtons).
const TITLEBAR_OVERLAY = {
  dark: { color: "#0e0f11", symbolColor: "#dbdee1" },
  light: { color: "#e3e5e8", symbolColor: "#060607" },
} as const;

export function titleBarOverlayOptions(theme: "dark" | "light" = "dark") {
  return { ...TITLEBAR_OVERLAY[theme], height: TITLEBAR_HEIGHT };
}

// The isolated preload records a trusted click on the composer's Paste item.
// Consume that signal when handling the first clipboard permission request.
const PASTE_GESTURE_WINDOW_MS = 1000;

// Every window showing a server's page, keyed by its webContents id. They all
// share the server's session, so permission and clipboard checks accept any.
// Thread windows are pop-outs: they aren't the server's notification or
// unread connection, and closing one really closes it.
type WindowRole = "server" | "thread";
type ServerPage = { entry: ServerEntry; win: BrowserWindow; role: WindowRole; pasteGestureAt: number | null };
const serverPages = new Map<number, ServerPage>();
const clipboardPrompts = new Map<string, Promise<boolean>>();
let clipboardGestureListenerInstalled = false;

const serverWindows = new Map<string, BrowserWindow>();
// Keyed by `${serverId} ${path}`, so popping out a thread again focuses it.
const threadWindows = new Map<string, BrowserWindow>();
const THREAD_PATH = /^\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let pickerWindow: BrowserWindow | null = null;
let isQuitting = false;
const focusedServerIds = new Set<string>();
let activatingWindows = false;

export function setQuitting(value: boolean): void {
  isQuitting = value;
}

export function serverIdForWebContents(webContentsId: number): string | undefined {
  return serverPages.get(webContentsId)?.entry.id;
}

/** Only the server's main window, for unread counts and notification clicks. */
export function serverWindowIdForWebContents(webContentsId: number): string | undefined {
  const page = serverPages.get(webContentsId);
  return page?.role === "server" ? page.entry.id : undefined;
}

// One BrowserWindow + one isolated session partition per server (matches
// Mattermost/Rocket.Chat Desktop): a malicious self-hosted server gets its
// own cookie jar/localStorage, never direct Node/Electron access.
export function openServerWindow(entry: ServerEntry, { show = true } = {}): BrowserWindow {
  const existing = serverWindows.get(entry.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const win = openServerPageWindow(
    entry,
    {
      width: 1280,
      height: 800,
      ...restorableBounds(entry.id),
      minWidth: 720,
      minHeight: 480,
      show,
      title: entry.name,
    },
    // A hidden window is still the live connection to the server; letting
    // Chromium throttle its timers delays notifications and reconnects.
    { backgroundThrottling: false },
    "server",
  );

  win.on("focus", () => {
    if (activatingWindows) return;
    focusedServerIds.delete(entry.id);
    focusedServerIds.add(entry.id);
    setActiveServer(entry.id);
  });

  win.loadURL(entry.url);

  // Electron has no Push API, so the renderer is the only live connection —
  // closing it would kill unread counts and notifications. Hide instead.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    clearUnread(entry.id);
    serverWindows.delete(entry.id);
    focusedServerIds.delete(entry.id);
  });

  // 'resized'/'moved' fire once the user lets go, not on every intermediate
  // frame of the drag — persisting on `closed` would miss the final state
  // when the app quits via Cmd+Q instead of a window close.
  const persistBounds = () => setWindowBounds(entry.id, win.getBounds());
  win.on("resized", persistBounds);
  win.on("moved", persistBounds);

  serverWindows.set(entry.id, win);
  return win;
}

/** `path` comes from an untrusted page, so only a thread path on the server's own origin opens. */
export function openThreadWindow(entry: ServerEntry, path: string): boolean {
  if (!THREAD_PATH.test(path)) return false;
  const key = `${entry.id} ${path}`;
  const existing = threadWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }

  const boundsId = threadWindowBoundsId(entry.id);
  const win = openServerPageWindow(
    entry,
    {
      width: 480,
      height: 720,
      ...restorableBounds(boundsId),
      minWidth: 360,
      minHeight: 480,
      title: entry.name,
    },
    {},
    "thread",
  );
  win.loadURL(new URL(path, entry.url).toString());

  // One shared size and position for every thread window of the server.
  const persistBounds = () => setWindowBounds(boundsId, win.getBounds());
  win.on("resized", persistBounds);
  win.on("moved", persistBounds);
  win.on("closed", () => threadWindows.delete(key));
  threadWindows.set(key, win);
  return true;
}

/** A thread window hands navigation to its server window and raises it. */
export function showServerWindowForThread(webContentsId: number): boolean {
  const page = serverPages.get(webContentsId);
  if (page?.role !== "thread") return false;
  openServerWindow(page.entry);
  return true;
}

// A window showing one of the server's own pages, with that server's session
// and the guards every such window needs. The caller loads the URL.
function openServerPageWindow(
  entry: ServerEntry,
  options: Electron.BrowserWindowConstructorOptions,
  webPreferences: Electron.WebPreferences,
  role: WindowRole,
): BrowserWindow {
  const isMac = process.platform === "darwin";
  const serverSession = session.fromPartition(`persist:server-${entry.id}`);
  const win = new BrowserWindow({
    ...options,
    icon: process.platform === "linux"
      ? path.join(__dirname, "../../build/icon.png")
      : undefined,
    // No native title bar: the page paints the whole window and reserves a
    // drag strip at the top (see TITLEBAR_HEIGHT in the preload), so the app's
    // own background runs edge to edge instead of sitting under grey chrome.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 13, y: 8 } : undefined,
    // Windows/Linux have no traffic lights to inherit, so Electron draws the
    // controls over our strip instead. Match the OS theme until the page
    // reports its own (a pinned theme can disagree with the system).
    titleBarOverlay: isMac
      ? undefined
      : titleBarOverlayOptions(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    // Painted before the page loads, so a cold start doesn't flash white.
    backgroundColor: "#131417",
    webPreferences: {
      ...webPreferences,
      session: serverSession,
      preload: path.join(__dirname, "../preload/serverPreload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A sandboxed preload can't import from main, so TITLEBAR_HEIGHT and the
      // app version are passed as argv flags instead of being duplicated or
      // IPC-fetched there.
      additionalArguments: [
        `--titlebar-height=${TITLEBAR_HEIGHT}`,
        `--app-version=${app.getVersion()}`,
      ],
    },
  });

  // Electron grants every permission request when no handler is installed, so
  // an untrusted server would get mic/cam/geolocation for free. Allow voice,
  // notifications, video fullscreen and clipboard writes only from the
  // server's own origin. Clipboard reads ask the user (askClipboardRead).
  // These handlers are per session and capture no window, so each window of
  // the server can reinstall them.
  serverSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === "clipboard-read") {
      void askClipboardRead(entry, contents, details.requestingUrl).then(callback);
      return;
    }
    callback(isPermitted(permission, details.requestingUrl, entry.url));
  });

  // The request handler only covers prompts; navigator.permissions.query and
  // some getUserMedia/device-enumeration paths go through this synchronous
  // check instead, which also defaults to allow.
  serverSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === "clipboard-read"
      ? getClipboardRead(entry.id) === "granted" && isSameOrigin(requestingOrigin, entry.url)
      : isPermitted(permission, requestingOrigin, entry.url),
  );

  // Without this `getDisplayMedia()` is refused before any picker appears.
  enableScreenShare(serverSession);

  // No page API exposes this channel. The preload sends synchronously so the
  // signal arrives before the page's click handler requests clipboard access.
  // Every sender gets a reply, including unregistered popup windows that
  // inherit the preload, so those renderers cannot hang.
  if (!clipboardGestureListenerInstalled) {
    ipcMain.on("clipboard-paste-gesture", (event) => {
      event.returnValue = false;
      const page = serverPages.get(event.sender.id);
      if (!page || event.senderFrame !== page.win.webContents.mainFrame) return;
      if (!isSameOrigin(event.senderFrame.url, page.entry.url)) return;
      page.pasteGestureAt = Date.now();
      event.returnValue = true;
    });
    clipboardGestureListenerInstalled = true;
  }

  enableSpelling(win.webContents);

  // Everything on the server's own origin stays in-window; anything else
  // (e.g. a link-preview target, an external link in a message) opens in
  // the OS default browser instead of becoming a second app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // /api/ URLs (attachments, image originals) are files, not app pages.
    if (isSameOrigin(url, entry.url) && !isApiPath(url)) {
      return { action: "allow" };
    }
    openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isSameOrigin(url, entry.url)) return;
    event.preventDefault();
    openExternal(url);
  });

  // Captured up front: `closed` fires after the native object is gone, so
  // reaching for win.webContents there throws "Object has been destroyed".
  const webContentsId = win.webContents.id;
  serverPages.set(webContentsId, { entry, win, role, pasteGestureAt: null });
  win.on("closed", () => serverPages.delete(webContentsId));
  return win;
}

async function askClipboardRead(
  entry: ServerEntry,
  contents: Electron.WebContents,
  requestingUrl: string,
): Promise<boolean> {
  if (!isSameOrigin(requestingUrl, entry.url)) return false;
  const page = serverPages.get(contents.id);
  if (page?.entry.id !== entry.id) return false;
  const answer = getClipboardRead(entry.id);
  if (answer) return answer === "granted";
  const pending = clipboardPrompts.get(entry.id);
  if (pending) return pending;
  const gestureAt = page.pasteGestureAt;
  page.pasteGestureAt = null;
  if (gestureAt === null || Date.now() - gestureAt > PASTE_GESTURE_WINDOW_MS) return false;
  const prompt = dialog
    .showMessageBox(page.win, {
      type: "question",
      buttons: ["Allow", "Don't Allow"],
      defaultId: 0,
      cancelId: 1,
      message: `Allow ${new URL(entry.url).host} to read your clipboard?`,
      detail: "This lets Paste in the message box work. You won't be asked again for this server.",
    })
    .then(({ response }) => {
      setClipboardRead(entry.id, response === 0 ? "granted" : "denied");
      return response === 0;
    })
    .finally(() => clipboardPrompts.delete(entry.id));
  clipboardPrompts.set(entry.id, prompt);
  return prompt;
}

// Closing hides a server window. App activation must prefer windows still
// open, rather than resurrecting a hidden server while another is in use.
export function activateServerWindows(): void {
  const open = new Map([...serverWindows].filter(([, win]) =>
    !win.isDestroyed() && (win.isVisible() || win.isMinimized()),
  ));
  if (open.size === 0) {
    const active = getActiveServer();
    if (active) openServerWindow(active);
    else openPickerWindow();
    return;
  }

  const recentId = [...focusedServerIds].reverse().find((id) => open.has(id));
  const target = (recentId ? open.get(recentId) : undefined)
    ?? open.get(getActiveServer()?.id ?? "")
    ?? open.values().next().value!;

  // Restoring a minimized window can focus it. Select the target beforehand
  // and ignore those incidental focus events while raising the other windows.
  activatingWindows = true;
  try {
    for (const win of open.values()) {
      if (win === target) continue;
      if (win.isMinimized()) win.restore();
      win.showInactive();
      win.moveTop();
    }
  } finally {
    activatingWindows = false;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

export function closeServerWindow(id: string): void {
  // close() only hides now, so callers that really mean "this server is gone"
  // need destroy().
  const win = serverWindows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
  for (const page of [...serverPages.values()]) {
    if (page.entry.id === id && !page.win.isDestroyed()) page.win.destroy();
  }
}

export function getServerWindow(id: string): BrowserWindow | undefined {
  return serverWindows.get(id);
}

export function getAllServerWindows(): BrowserWindow[] {
  return [...serverWindows.values()];
}

/** Server windows and their thread windows. */
export function getAllServerPageWindows(): BrowserWindow[] {
  return [...serverPages.values()].map((page) => page.win);
}

export function openPickerWindow(): BrowserWindow {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.show();
    pickerWindow.focus();
    return pickerWindow;
  }

  pickerWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: "Welcome to Hasht",
    icon: process.platform === "linux"
      ? path.join(__dirname, "../../build/icon.png")
      : undefined,
    // --bg-rail in picker.html, so the window doesn't flash the other theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0f11" : "#e8eaec",
    webPreferences: {
      preload: path.join(__dirname, "../preload/pickerPreload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  pickerWindow.setMenuBarVisibility(false);
  // __dirname-relative, not app.getAppPath(): the latter is the repo root under
  // `electron .` but dist/main under `electron dist/main/main.js` (what the dev
  // script runs), which broke the picker outright.
  pickerWindow.loadFile(
    path.join(__dirname, "../../src/renderer-picker/picker.html"),
  );
  pickerWindow.on("closed", () => (pickerWindow = null));
  return pickerWindow;
}

export function closePickerWindow(): void {
  pickerWindow?.close();
}

function isPermitted(
  permission: string,
  requestingUrl: string | undefined,
  serverUrl: string,
): boolean {
  // "display-capture" is screen sharing. The handler installed by
  // enableScreenShare is what actually picks the surface — this only decides
  // whether the origin may ask at all, same as it does for mic and camera.
  if (
    permission !== "media" &&
    permission !== "notifications" &&
    permission !== "display-capture" &&
    permission !== "fullscreen" &&
    permission !== "clipboard-sanitized-write"
  )
    return false;
  return isSameOrigin(requestingUrl ?? "", serverUrl);
}

// Hand the OS only schemes a browser/mail client should handle; a server-
// supplied file:// or custom-scheme URL would otherwise be a launcher.
function openExternal(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
    shell.openExternal(url);
  }
}

// Saved bounds can point at a display that's since been unplugged (laptop
// undocked, monitor turned off) — restoring blindly would put the window
// off-screen where the user can't reach it. Only reuse bounds that still
// overlap some connected display.
function restorableBounds(id: string): Electron.Rectangle | undefined {
  const bounds = getWindowBounds(id);
  if (!bounds) return undefined;
  const onScreen = screen
    .getAllDisplays()
    .some((display) => rectanglesOverlap(bounds, display.workArea));
  return onScreen ? bounds : undefined;
}

function rectanglesOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isApiPath(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isSameOrigin(url: string, serverUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** Remove only this entry's partition; duplicate accounts have other partitions. */
export async function forgetServerAccount(entry: ServerEntry): Promise<void> {
  const partition = session.fromPartition(`persist:server-${entry.id}`);
  const existing = getServerWindow(entry.id);
  let cleanup: BrowserWindow | undefined;
  let token: string | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    let contents = existing?.webContents;
    if (!contents || new URL(contents.getURL()).origin !== new URL(entry.url).origin) {
      cleanup = new BrowserWindow({ show: false, webPreferences: {
        session: partition, contextIsolation: true, sandbox: true, nodeIntegration: false,
      } });
      cleanup.webContents.on("will-redirect", (event, url) => {
        if (new URL(url).origin !== new URL(entry.url).origin) event.preventDefault();
      });
      await Promise.race([
        cleanup.loadURL(new URL("/api/health", entry.url).toString()),
        new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("Server unavailable")), 10000); }),
      ]);
      contents = cleanup.webContents;
    }
    if (new URL(contents.getURL()).origin === new URL(entry.url).origin) {
      const auth = await contents.executeJavaScript("localStorage.getItem('chat_auth')");
      token = JSON.parse(auth || "null")?.token;
    }
  } catch { /* Local removal also works when the server cannot be reached. */ }
  finally {
    clearTimeout(cleanupTimer);
    cleanup?.destroy();
    closeServerWindow(entry.id);
    await partition.clearStorageData();
    await partition.clearCache();
  }
  if (token) {
    try {
      await partition.fetch(new URL("/api/auth/logout", entry.url).toString(), {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* Revocation requires a reachable server; local auth is gone. */ }
  }
}
