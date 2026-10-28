import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DESKTOP_FILE = "net.hasht.app.AppImage.desktop";

// Desktop Exec syntax is not shell syntax. Escape both its quoted argument
// layer and desktop-entry string layer; literal percent signs are field codes.
export function appImageDesktopEntry(executable: string): string {
  if (!path.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error("The AppImage must have an absolute path without control characters.");
  }
  const quoted = executable.replace(/[\\"`$]/g, "\\$&").replace(/%/g, "%%");
  const exec = `"${quoted}" %u`.replace(/\\/g, "\\\\");
  return [
    "[Desktop Entry]", "Type=Application", "Name=Hasht",
    `Exec=${exec}`, "Terminal=false", "NoDisplay=true",
    "MimeType=x-scheme-handler/hasht;", "Categories=Network;", "",
  ].join("\n");
}

/** AppImages do not install their bundled launcher into the user's desktop. */
export function registerAppImageProtocol(): void {
  if (process.platform !== "linux" || !process.env.APPIMAGE) return;
  const dataHome = process.env.XDG_DATA_HOME;
  const applications = path.join(dataHome && path.isAbsolute(dataHome)
    ? dataHome : path.join(os.homedir(), ".local", "share"), "applications");
  const entry = appImageDesktopEntry(process.env.APPIMAGE);
  mkdirSync(applications, { recursive: true });
  // Refresh on each launch: APPIMAGE is the persistent file, whereas execPath
  // points inside a temporary mount. Moving/updating the image repairs this.
  writeFileSync(path.join(applications, DESKTOP_FILE), entry, { mode: 0o644 });
  const run = (args: string[]) => execFileSync("xdg-mime", args, {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  run(["default", DESKTOP_FILE, "x-scheme-handler/hasht"]);
  if (run(["query", "default", "x-scheme-handler/hasht"]) !== DESKTOP_FILE) {
    throw new Error("The desktop did not register Hasht's browser callback handler.");
  }
}
