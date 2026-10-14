import { app, dialog, net, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setQuitting } from "./windows";

// Six hours: long enough that a long-running window isn't checking constantly,
// short enough that a machine left open for days still picks up a release.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const REPO = "Hasht-net/hasht-desktop";

// Auto-updates against the GitHub releases the release workflow publishes.
// The feed URL comes from electron-builder.yml's `publish` block, baked into
// app-update.yml at package time — change the repo there, not here.
export function initAutoUpdater(): void {
  // Store packages must stay on the Store audience/flight assigned to them.
  if (process.windowsStore) return;
  // macOS gets the download-and-open-the-DMG fallback (see macUpdateFlow):
  // Squirrel.Mac refuses to swap in our unsigned build, so electron-updater's
  // in-place update can't work here yet.
  if (process.platform === "darwin") {
    void checkForMacUpdate({ manual: false });
    setInterval(() => void checkForMacUpdate({ manual: false }), CHECK_INTERVAL_MS);
    return;
  }

  if (!isUpdatable()) return;

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
  if (process.windowsStore) {
    await shell.openExternal("ms-windows-store://downloadsandupdates");
    return;
  }

  if (process.platform === "darwin") {
    await checkForMacUpdate({ manual: true });
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

// --- macOS DMG fallback --------------------------------------------------------
//
// electron-updater's in-place update relies on Squirrel.Mac, which will not
// replace an app whose code signature it can't validate — and our macOS builds
// are unsigned/ad-hoc signed (see electron-builder.yml). So instead of swapping
// the app out from under itself, we fetch the DMG built for this Mac's
// architecture and open it, leaving the user to drag the new Hasht over the old
// one. Once we ship a signed, notarized build, delete everything below and let
// the Windows/Linux path (autoDownload + quitAndInstall) run on macOS too.

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

async function checkForMacUpdate(opts: { manual: boolean }): Promise<void> {
  if (!app.isPackaged) return;
  const { manual } = opts;

  let release: GithubRelease;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (manual) {
      await dialog.showMessageBox({
        type: "warning",
        message: "Couldn't check for updates.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const latest = release.tag_name.replace(/^v/, "");
  if (!isNewer(latest, app.getVersion())) {
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        message: "You're up to date.",
        detail: `Hasht ${app.getVersion()} is the latest version.`,
      });
    }
    return;
  }

  // Artifact names look like `Hasht-0.1.4-arm64.dmg` (electron-builder.yml
  // forces the arch suffix onto every mac dmg, x64 included, so there's no
  // "default" filename that's missing it).
  const asset = release.assets.find(
    (a) => a.name.endsWith(`-${process.arch}.dmg`),
  );
  if (!asset) {
    if (manual) {
      await dialog.showMessageBox({
        type: "warning",
        message: `Hasht ${latest} is available.`,
        detail: "No matching download was found for this Mac — get it from the Releases page.",
      });
    }
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Hasht ${latest} is available.`,
    detail: "It'll download and open — drag Hasht into your Applications folder to finish updating.",
  });
  if (response !== 0) return;

  try {
    const dmgPath = await downloadAsset(asset);
    const err = await shell.openPath(dmgPath);
    if (err) throw new Error(err);
  } catch (err) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Update download failed.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  // The stable "latest" endpoint skips prereleases; a beta build stays on the
  // beta track by taking the most recent release of any kind instead.
  const onBeta = app.getVersion().includes("-");
  const url = onBeta
    ? `https://api.github.com/repos/${REPO}/releases?per_page=1`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  const res = await net.fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hasht-desktop-updater",
    },
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const body = await res.json();
  const release = onBeta ? body[0] : body;
  if (!release?.tag_name) throw new Error("No release found.");
  return release as GithubRelease;
}

async function downloadAsset(asset: GithubAsset): Promise<string> {
  const res = await net.fetch(asset.browser_download_url, {
    headers: { "User-Agent": "hasht-desktop-updater" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download responded ${res.status}`);
  }
  const dest = path.join(app.getPath("downloads"), asset.name);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return dest;
}

// Enough of a semver compare for our `X.Y.Z` / `X.Y.Z-beta.N` tags: a stable
// release always beats the prerelease of the same version.
function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split("-");
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
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
