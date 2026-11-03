import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { desktopExec, xdgDir } from "./appImageProtocol";

// Windows and Linux launch with this so the app starts in the tray; macOS
// reports a login launch itself.
const LOGIN_ARG = "--at-login";
const AUTOSTART_FILE = "net.hasht.app.desktop";

function autostartPath(): string {
  return path.join(xdgDir("XDG_CONFIG_HOME", ".config"), "autostart", AUTOSTART_FILE);
}

// An AppImage's execPath is a temporary mount; APPIMAGE is the file itself.
function linuxExecutable(): string {
  return process.env.APPIMAGE || process.execPath;
}

export function autostartEntry(executable: string): string {
  return [
    "[Desktop Entry]", "Type=Application", "Name=Hasht",
    `Exec=${desktopExec(executable, LOGIN_ARG)}`,
    // The entry outlives an uninstall; desktops skip it once this is gone.
    `TryExec=${executable.replace(/\\/g, "\\\\")}`,
    "Terminal=false", "X-GNOME-Autostart-enabled=true", "",
  ].join("\n");
}

function writeAutostart(): void {
  const file = autostartPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.hasht-tmp`, autostartEntry(linuxExecutable()), { mode: 0o644 });
  renameSync(`${file}.hasht-tmp`, file);
}

/** Unpackaged runs would register the bare Electron binary. */
export function canOpenAtLogin(): boolean {
  return app.isPackaged;
}

export function isOpenAtLogin(): boolean {
  if (process.platform === "linux") {
    let entry: string;
    try { entry = readFileSync(autostartPath(), "utf8"); }
    catch { return false; }
    // How desktop autostart settings switch an entry off without deleting it.
    return !/^(Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/m.test(entry);
  }
  if (process.platform === "win32") {
    const settings = app.getLoginItemSettings({ args: [LOGIN_ARG] });
    // openAtLogin stays true after the user disables it in Task Manager.
    return settings.openAtLogin && settings.executableWillLaunchAtLogin;
  }
  return app.getLoginItemSettings().openAtLogin;
}

export function setOpenAtLogin(enabled: boolean): void {
  if (process.platform === "linux") {
    if (enabled) writeAutostart();
    else rmSync(autostartPath(), { force: true });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [LOGIN_ARG] });
}

/** macOS registers the item but leaves it off until allowed in System Settings. */
export function loginItemNeedsApproval(): boolean {
  return process.platform === "darwin" && app.getLoginItemSettings().status === "requires-approval";
}

export function launchedAtLogin(): boolean {
  if (process.platform === "darwin") return app.getLoginItemSettings().wasOpenedAtLogin;
  return process.argv.includes(LOGIN_ARG);
}

/** Points the autostart entry at a moved or updated AppImage. */
export function refreshOpenAtLogin(): void {
  if (process.platform !== "linux" || !process.env.APPIMAGE || !isOpenAtLogin()) return;
  try { writeAutostart(); }
  catch (error) { console.error("Could not refresh the login item:", error); }
}
