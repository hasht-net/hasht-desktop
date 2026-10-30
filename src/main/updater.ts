import { app, dialog, net, powerMonitor } from "electron";
import Store from "electron-store";
import { autoUpdater } from "electron-updater";
import { getAllServerWindows, setQuitting } from "./windows";

export type UpdateState = "none" | "available" | "queued" | "downloading" | "ready";

// Downloading, verifying and staging a ~130 MB update slows the machine
// noticeably (Windows especially), so nothing heavy runs while someone is
// using it. Launch always checks; after that, at most one check a day, and
// downloads wait until the user steps away.
const LAUNCH_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Downloads normally wait for the user to opt in from the window bar. One they
// have ignored this long downloads anyway, so nobody is stranded on an old build.
const UNASKED_DOWNLOAD_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const IDLE_SECONDS = 10 * 60;
// The away check only reads OS state; the jitter keeps clients from all
// hitting the feed together after a release.
const TICK_MIN_MS = 20 * 60 * 1000;
const TICK_JITTER_MS = 20 * 60 * 1000;

interface Persisted {
  lastCheckAt: number;
  /** First time any pending update was seen; kept across newer releases. */
  availableSince: number | null;
  queued: boolean;
}

const store = new Store<{ updater: Persisted }>({
  name: "updater",
  defaults: { updater: { lastCheckAt: 0, availableSince: null, queued: false } },
});

let state: UpdateState = "none";
let version: string | null = null;
let onChange: () => void = () => {};

// Auto-updates against the GitHub releases the release workflow publishes.
// The feed URL comes from electron-builder.yml's `publish` block, baked into
// app-update.yml at package time — change the repo there, not here.
export function initAutoUpdater(onStateChange: () => void): void {
  // App Store and TestFlight own updates for sandboxed MAS builds.
  if (process.mas) return;
  if (!isUpdatable()) return;
  onChange = onStateChange;

  // Signed macOS ZIP updates are staged by Squirrel.Mac, which validates the
  // app signature and replaces the installed app when it restarts.
  autoUpdater.autoDownload = false;
  // The update is staged on disk and swapped in on the next quit, so a user
  // who never restarts from the window bar still ends up current.
  autoUpdater.autoInstallOnAppQuit = true;
  // Keep users on the track they opted into: a 0.1.0-beta.1 build should
  // keep seeing betas, a stable build should never be pulled onto one.
  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  autoUpdater.on("update-available", (info) => found(info.version));
  autoUpdater.on("update-not-available", () => {
    if (state === "downloading" || state === "ready") return;
    store.set("updater", { ...persisted(), availableSince: null, queued: false });
    setState("none", null);
  });
  autoUpdater.on("update-downloaded", (info) => setState("ready", info.version));

  // A failed check must never interrupt anyone — the cost is staying on the
  // current version until the next check, which is not worth a dialog.
  autoUpdater.on("error", (err) => {
    console.error("[updater]", err);
  });

  setTimeout(() => void check(), LAUNCH_CHECK_DELAY_MS);
  powerMonitor.on("lock-screen", () => void tick());
  scheduleTick();
}

export function getUpdateState(): { state: UpdateState; version: string | null } {
  return { state, version };
}

/** The window bar's "Update available": download on the next idle window. */
export function queueUpdate(): void {
  if (state !== "available") return;
  store.set("updater", { ...persisted(), queued: true });
  setState("queued");
}

export function installUpdate(): void {
  if (state !== "ready") return;
  // Server windows hide instead of closing, so without this their close
  // handler cancels the quit and the install never runs.
  setQuitting(true);
  autoUpdater.quitAndInstall();
}

/** Wired to a "Check for Updates…" menu item — always gives the user feedback,
 *  including "you're up to date" and errors, unlike the silent background run. */
export async function checkForUpdatesFromMenu(): Promise<void> {
  if (process.mas) {
    await dialog.showMessageBox({
      type: "info",
      message: "Updates are managed by the App Store or TestFlight.",
    });
    return;
  }
  if (!isUpdatable()) {
    await dialog.showMessageBox({
      type: "info",
      message: "This build updates through your package manager.",
      detail: "Use apt, dnf or your AUR helper to get the latest version.",
    });
    return;
  }
  if (state === "ready") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Hasht ${version} is ready to install.`,
      detail: "Restart to finish updating, or it will be applied the next time you quit.",
    });
    if (response === 0) installUpdate();
    return;
  }
  if (state === "downloading") {
    await dialog.showMessageBox({ type: "info", message: `Hasht ${version} is downloading.` });
    return;
  }

  const cleanup = () => {
    autoUpdater.removeListener("update-not-available", onNotAvailable);
    autoUpdater.removeListener("update-available", onAvailable);
    autoUpdater.removeListener("error", onError);
  };
  const onNotAvailable = () => {
    cleanup();
    void dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      detail: `Hasht ${app.getVersion()} is the latest version.`,
    });
  };
  const onAvailable = async (info: { version: string }) => {
    cleanup();
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download When Away", "Download Now"],
      defaultId: 0,
      cancelId: 0,
      message: `Hasht ${info.version} is available.`,
      detail: "Downloading can slow your computer for a few minutes, so by default it waits until you step away.",
    });
    if (response === 1) download();
    else queueUpdate();
  };
  const onError = (err: Error) => {
    cleanup();
    void dialog.showMessageBox({
      type: "warning",
      message: "Couldn't check for updates.",
      detail: err.message,
    });
  };

  autoUpdater.once("update-not-available", onNotAvailable);
  autoUpdater.once("update-available", onAvailable);
  autoUpdater.once("error", onError);
  await check();
}

function found(next: string): void {
  if (state === "downloading" || state === "ready") return;
  const saved = persisted();
  if (saved.availableSince === null) store.set("updater", { ...saved, availableSince: Date.now() });
  setState(saved.queued ? "queued" : "available", next);
}

function scheduleTick(): void {
  setTimeout(() => {
    void tick();
    scheduleTick();
  }, TICK_MIN_MS + Math.random() * TICK_JITTER_MS);
}

async function tick(): Promise<void> {
  if (state === "downloading" || state === "ready" || !isAway()) return;
  if (Date.now() - persisted().lastCheckAt >= CHECK_INTERVAL_MS) await check();
  const { availableSince } = persisted();
  const unaskedTooLong = availableSince !== null && Date.now() - availableSince >= UNASKED_DOWNLOAD_AFTER_MS;
  if (state === "queued" || (state === "available" && unaskedTooLong)) download();
}

// Idle or locked, online, plugged in, and not in a call: input-idle alone
// would also match someone listening to a voice channel.
function isAway(): boolean {
  if (!net.isOnline() || powerMonitor.isOnBatteryPower()) return false;
  if (powerMonitor.getSystemIdleState(IDLE_SECONDS) === "active") return false;
  return !getAllServerWindows().some((win) => !win.isDestroyed() && win.webContents.isCurrentlyAudible());
}

async function check(): Promise<void> {
  // checkForUpdates rejects on network/feed errors as well as emitting
  // "error"; without a catch that's an unhandled rejection.
  try {
    await autoUpdater.checkForUpdates();
    store.set("updater", { ...persisted(), lastCheckAt: Date.now() });
  } catch (err) {
    console.error("[updater] check failed", err);
  }
}

function download(): void {
  const previous = state;
  setState("downloading");
  autoUpdater.downloadUpdate().catch((err) => {
    console.error("[updater] download failed", err);
    if (state === "downloading") setState(previous);
  });
}

function persisted(): Persisted {
  return store.get("updater");
}

function setState(next: UpdateState, nextVersion?: string | null): void {
  state = next;
  if (nextVersion !== undefined) version = nextVersion;
  onChange();
  // The page asks for the state itself; contextBridge can't carry it in an event.
  for (const win of getAllServerWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update-state");
  }
}

function isUpdatable(): boolean {
  // app-update.yml only exists inside a packaged build; in dev electron-updater
  // throws looking for it.
  if (!app.isPackaged) return false;

  // Linux is the awkward one. Only AppImage can replace itself — and APPIMAGE
  // in the environment is how electron-updater itself detects that. deb, rpm
  // and the AUR package are owned by apt/dnf/pacman, and swapping the binary
  // out from under a package manager leaves it describing files that no longer
  // match. Those users update through their distro instead.
  if (process.platform === "linux" && !process.env.APPIMAGE) return false;

  return true;
}
