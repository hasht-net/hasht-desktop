import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  addServer,
  getActiveServer,
  hasScheme,
  listServers,
  normalizeUrl,
  removeServer,
  renameServer,
  setActiveServer,
  type ServerEntry,
} from "./serverStore";
import { buildAppMenu } from "./appMenu";
import {
  openServerWindow,
  openPickerWindow,
  closePickerWindow,
  closeServerWindow,
  serverIdForWebContents,
  setQuitting,
  TITLEBAR_HEIGHT,
} from "./windows";
import { clearUnread, initTray, refreshTrayMenu, setUnreadCount } from "./tray";
import {
  PROTOCOL,
  beginBrowserSignIn,
  completeBrowserSignIn,
  deepLinkFromArgv,
  signInLinkOrigin,
} from "./nativeAuth";
import { getServerWindow } from "./windows";
import { initAutoUpdater, checkForUpdatesFromMenu } from "./updater";
import { openScreenCaptureSettings, screenCaptureStatus } from "./screenShare";
import { getDateTimePreferences } from "./dateTimePreferences";

if (!app.requestSingleInstanceLock()) {
  // app.quit() only schedules a quit; evaluation would continue and whenReady
  // would still fire, opening a duplicate window.
  app.exit(0);
}

// Windows shows this ID's registered Display Name on notification toasts;
// without it Electron falls back to "electron.app.<name>" instead of "Hasht".
// Must match electron-builder's `appId`, which is what the NSIS installer
// registers as the Start Menu shortcut's AppUserModelID. No-op elsewhere.
app.setAppUserModelId("net.hasht.app");

// Windows and Linux deliver the deep link as an argv entry on the instance
// that already holds the lock; macOS uses open-url below.
app.on("second-instance", (_event, argv) => {
  const link = deepLinkFromArgv(argv);
  if (link) void handleDeepLink(link);

  const active = getActiveServer();
  if (!active) {
    openPickerWindow();
    return;
  }
  const win = openServerWindow(active);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on("before-quit", () => setQuitting(true));

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleDeepLink(url);
});

// Auth handed back by the browser, keyed by server: the window reloads and the
// page collects it through the preload rather than main writing into the app's
// own storage keys.
const pendingAuth = new Map<string, unknown>();

// Servers named by a `hasht://signin` link that aren't in the list yet. Added
// only once sign-in succeeds, so a link the user backs out of leaves nothing.
const provisionalServers = new Map<string, ServerEntry>();

async function handleDeepLink(link: string): Promise<void> {
  try {
    // open-url can fire before ready on a cold start.
    await app.whenReady();
    const origin = signInLinkOrigin(link);
    if (origin) return await signInFromLink(origin);

    const result = await completeBrowserSignIn(link);
    if (!result) return;

    let entry = listServers().find((s) => s.id === result.serverId);
    const provisional = provisionalServers.get(result.serverId);
    if (!entry && provisional) {
      provisionalServers.delete(result.serverId);
      entry = addServer(provisional.url, provisional.name);
      closePickerWindow();
      refreshMenus();
    }
    if (!entry) return;
    pendingAuth.set(entry.id, result.auth);

    const win = openServerWindow(entry);
    win.webContents.reload();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (err) {
    dialog.showErrorBox("Sign-in failed", (err as Error).message);
  }
}

/**
 * "Sign in to the App" in a browser's settings: runs the usual browser handoff
 * for that server. The link can come from any page naming any host, so the
 * dialog is the user's say-so, and doubles as the place the match code is
 * shown since no app screen started this.
 */
async function signInFromLink(origin: string): Promise<void> {
  const host = new URL(origin).host;
  const existing = listServers().find((s) => new URL(s.url).origin === origin);
  const entry = existing ?? {
    id: randomUUID(),
    url: normalizeUrl(origin),
    name: (await fetchInstanceName(origin)) ?? host,
  };
  if (!existing) provisionalServers.set(entry.id, entry);

  await beginBrowserSignIn(entry, async (code) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Continue", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: `Sign in to ${host}?`,
      detail: `Your browser will show a code. Only approve if it matches:\n\n${code.replace(/(.{4})(?=.)/g, "$1 ")}`,
    });
    if (response !== 0) provisionalServers.delete(entry.id);
    return response === 0;
  });
}

/** Best-effort: a server whose name can't be read is still fine to add. */
async function fetchInstanceName(origin: string): Promise<string | null> {
  try {
    const res = await net.fetch(new URL("/api/instance-settings", origin).toString());
    const name = res.ok ? ((await res.json()) as { app_name?: unknown }).app_name : null;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

function connectToServer(id: string) {
  const entry = listServers().find((s) => s.id === id);
  if (!entry) return;
  setActiveServer(id);
  closePickerWindow();
  openServerWindow(entry);
  refreshMenus();
}

// Pushes to the page instead of Electron's role: "about" panel.
function showAbout(): void {
  const active = getActiveServer();
  if (!active) return;
  const win = openServerWindow(active);
  win.webContents.send("show-about");
}

// Tray and the app menu both list the same servers, so any change to the
// list (add/remove/rename) has to refresh both or one goes stale.
function refreshMenus(): void {
  refreshTrayMenu(trayCallbacks);
  buildAppMenu(appMenuCallbacks);
}

const trayCallbacks = {
  onSwitchServer: connectToServer,
  onAddServer: () => openPickerWindow(),
  onQuit: () => app.quit(),
};

const appMenuCallbacks = {
  onSwitchServer: connectToServer,
  onManageBackends: () => openPickerWindow(),
  onAbout: showAbout,
  onCheckForUpdates: () => void checkForUpdatesFromMenu(),
  onQuit: () => app.quit(),
};

app.whenReady().then(() => {
  registerProtocol();
  initTray(trayCallbacks);
  buildAppMenu(appMenuCallbacks);
  initAutoUpdater();

  ipcMain.handle("date-time:preferences", (event) => {
    if (!serverIdForWebContents(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Date/time preferences are only available to server windows");
    }
    return getDateTimePreferences();
  });

  const active = getActiveServer();
  if (active) {
    openServerWindow(active);
  } else {
    openPickerWindow();
  }

  // Windows and Linux hand a cold-start deep link to this instance as argv.
  const startupLink = deepLinkFromArgv(process.argv);
  if (startupLink) void handleDeepLink(startupLink);

  ipcMain.handle("picker:list-servers", () => listServers());

  ipcMain.handle(
    "picker:add-server",
    async (_e, rawUrl: string, name: string) => {
      const url = await resolveServerUrl(rawUrl); // throws with a friendly message
      // Adding a server that's already in the list (common with the one-click
      // hosted option) just switches to it rather than making a duplicate.
      const existing = listServers().find(
        (s) => new URL(s.url).origin === new URL(url).origin,
      );
      const entry = existing ?? addServer(url, name);
      connectToServer(entry.id);
      return entry;
    },
  );

  ipcMain.handle("picker:connect-existing", (_e, id: string) =>
    connectToServer(id),
  );

  ipcMain.handle("picker:remove-server", (_e, id: string) => {
    closeServerWindow(id);
    clearUnread(id);
    removeServer(id);
    refreshMenus();
  });

  ipcMain.handle("picker:rename-server", (_e, id: string, name: string) => {
    renameServer(id, name);
    refreshMenus();
    const win = getServerWindow(id);
    if (win) win.setTitle(name.trim() || win.getTitle());
  });

  // Started from the app's own login screen: hands off to the system browser.
  ipcMain.handle("native-auth:start", async (event) => {
    const serverId = serverIdForWebContents(event.sender.id);
    const entry = listServers().find((s) => s.id === serverId);
    if (!entry) throw new Error("Unknown server.");
    return beginBrowserSignIn(entry);
  });

  ipcMain.handle("native-auth:take", (event) => {
    const serverId = serverIdForWebContents(event.sender.id);
    if (!serverId) return null;
    const auth = pendingAuth.get(serverId) ?? null;
    pendingAuth.delete(serverId);
    return auth;
  });

  // Screen recording is granted to the app by the OS, not to the page, so the
  // renderer can neither read the status nor raise the prompt. It asks us.
  ipcMain.handle("screen-capture:status", () => screenCaptureStatus());
  ipcMain.handle("screen-capture:open-settings", () => openScreenCaptureSettings());

  // Expose only the activity verdict needed for presence, never exact idle
  // time or raw input. The threshold matches the web client's five minutes.
  ipcMain.handle("system-activity:state", (event) => {
    if (!serverIdForWebContents(event.sender.id)) return null;
    const state = powerMonitor.getSystemIdleState(5 * 60);
    if (state === "active") return true;
    if (state === "idle" || state === "locked") return false;
    return null;
  });

  // The page's window bar is --bg-rail, which depends on the theme. The
  // caption overlay is a native rectangle we paint separately; leave it at
  // the first-paint guess and it reads as a patch behind the buttons.
  ipcMain.on("desktop-theme", (event, payload: unknown) => {
    if (process.platform === "darwin") return;
    const colors = payload as { color?: unknown; symbolColor?: unknown };
    const hex = /^#[0-9a-fA-F]{6}$/;
    if (typeof colors?.color !== "string" || !hex.test(colors.color)) return;
    if (typeof colors?.symbolColor !== "string" || !hex.test(colors.symbolColor)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: TITLEBAR_HEIGHT,
    });
  });

  ipcMain.on("unread-count-changed", (event, count: number) => {
    const serverId = serverIdForWebContents(event.sender.id);
    if (serverId) {
      setUnreadCount(serverId, count);
      refreshTrayMenu(trayCallbacks);
    }
  });

  // Server windows hide rather than close, so "no windows exist" is no longer
  // the signal here — just resurface the active server.
  app.on("activate", () => {
    const a = getActiveServer();
    if (a) openServerWindow(a);
    else if (BrowserWindow.getAllWindows().length === 0) openPickerWindow();
  });
});

// Registering this at all suppresses Electron's default quit-on-last-window-close;
// quitting stays explicit, via the tray menu or Cmd/Ctrl+Q.
app.on("window-all-closed", () => {});

// A bare host ("192.168.1.5:3000") is the first thing a self-hoster types and
// is usually plain HTTP, so probe TLS first and fall back rather than failing.
async function resolveServerUrl(rawUrl: string): Promise<string> {
  const candidates = hasScheme(rawUrl)
    ? [normalizeUrl(rawUrl)]
    : [normalizeUrl(rawUrl, "https"), normalizeUrl(rawUrl, "http")];

  let lastError: Error | undefined;
  for (const url of candidates) {
    try {
      await verifyReachable(url);
      // Falling back is a downgrade the user never asked for — they typed no
      // scheme — so make dropping TLS their decision, not ours.
      if (url.startsWith("http://") && !(await confirmInsecure(url))) {
        throw new Error("Cancelled — that server isn't serving HTTPS.");
      }
      return url;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("Couldn't reach that server.");
}

// Unpackaged builds run through the electron binary, so the scheme has to be
// registered against it explicitly or the OS has nothing to hand the link to.
function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

async function confirmInsecure(url: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Connect anyway"],
    defaultId: 0,
    cancelId: 0,
    message: `${new URL(url).host} isn't serving HTTPS.`,
    detail:
      "Your messages and login token would travel unencrypted, readable by anyone on the network path. Only continue on a network you trust.",
  });
  return response === 1;
}

async function verifyReachable(url: string): Promise<void> {
  let res: Response;
  try {
    res = await net.fetch(new URL("/manifest.webmanifest", url).toString(), {
      method: "GET",
    });
  } catch (err) {
    throw new Error(describeFetchFailure(url, err));
  }
  if (!res.ok) {
    throw new Error(`Server responded with ${res.status} — check the URL.`);
  }
}

// net.fetch surfaces TLS problems as an opaque ERR_CERT_* string; spell out
// what a self-signed cert means so the user has something to act on.
function describeFetchFailure(url: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const host = new URL(url).host;
  if (/ERR_CERT|ERR_SSL|CERT_AUTHORITY/i.test(detail)) {
    return `${host} presented a certificate this machine doesn't trust (${detail}). Install the server's CA certificate, or use http:// if it isn't serving TLS.`;
  }
  return `Couldn't reach ${host} (${detail}).`;
}

const reportedCertHosts = new Set<string>();

// Never blanket-accept a bad certificate — reject it, but say so instead of
// leaving the window blank.
app.on("certificate-error", (event, _contents, url, error, _cert, callback) => {
  event.preventDefault();
  callback(false);

  const host = new URL(url).host;
  if (reportedCertHosts.has(host)) return;
  reportedCertHosts.add(host);
  dialog.showErrorBox(
    "Certificate error",
    `${host} presented a certificate this machine doesn't trust (${error}). Install the server's CA certificate, or connect over http:// if it isn't serving TLS.`,
  );
});
