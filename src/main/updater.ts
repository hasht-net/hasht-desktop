import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { setQuitting } from "./windows";

// Six hours: long enough that a long-running window isn't checking constantly,
// short enough that a machine left open for days still picks up a release.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Auto-updates against the GitHub releases the release workflow publishes.
// The feed URL comes from electron-builder.yml's `publish` block, baked into
// app-update.yml at package time — change the repo there, not here.
export function initAutoUpdater(): void {
  // App Store and TestFlight own updates for sandboxed MAS builds.
  if (process.mas) return;
  if (!isUpdatable()) return;

  // Signed macOS ZIP updates are staged by Squirrel.Mac, which validates the
  // app signature and replaces the installed app when it restarts.
  autoUpdater.autoDownload = true;
  // The update is staged on disk and swapped in on the next quit, so a user
  // who ignores the prompt still ends up current without another download.
  autoUpdater.autoInstallOnAppQuit = true;
  // Keep users on the track they opted into: a 0.1.0-beta.1 build should
  // keep seeing betas, a stable build should never be pulled onto one.
  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  autoUpdater.on("update-downloaded", (info) => {
    void promptToInstall(info.version);
  });

  // A failed check must never interrupt anyone — the cost is staying on the
  // current version until the next check, which is not worth a dialog.
  autoUpdater.on("error", (err) => {
    console.error("[updater]", err);
  });

  void check();
  setInterval(check, CHECK_INTERVAL_MS);
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
  const onAvailable = (info: { version: string }) => {
    cleanup();
    void dialog.showMessageBox({
      type: "info",
      message: `Hasht ${info.version} is downloading.`,
      detail: "You'll be asked to restart once it's ready to install.",
    });
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
  autoUpdater.checkForUpdates().catch(() => {
    /* surfaced via the "error" event */
  });
}

function check(): void {
  // checkForUpdates rejects on network/feed errors as well as emitting
  // "error"; without a catch that's an unhandled rejection.
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] check failed", err);
  });
}

async function promptToInstall(version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Hasht ${version} is ready to install.`,
    detail: "Restart to finish updating, or keep working and it'll be applied the next time you quit.",
  });
  if (response !== 0) return;

  // Server windows hide instead of closing, so without this their close
  // handler cancels the quit and the install never runs.
  setQuitting(true);
  autoUpdater.quitAndInstall();
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
