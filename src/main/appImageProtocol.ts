import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DESKTOP_FILE = "net.hasht.app.AppImage.desktop";
const SCHEME_MIME = "x-scheme-handler/hasht";

// xdg-mime keeps the quotes when resolving Exec, finds no binary, and skips
// the entry, so quote only paths that need it.
function execNeedsQuotes(executable: string): boolean {
  return /[\s"'\\><~|&;$*?#()`]/.test(executable);
}

// Desktop Exec syntax is not shell syntax. Escape both its quoted argument
// layer and desktop-entry string layer; literal percent signs are field codes.
export function appImageDesktopEntry(executable: string): string {
  if (!path.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error("The AppImage must have an absolute path without control characters.");
  }
  const escaped = execNeedsQuotes(executable)
    ? `"${executable.replace(/[\\"`$]/g, "\\$&")}"` : executable;
  const exec = `${escaped.replace(/%/g, "%%")} %u`.replace(/\\/g, "\\\\");
  return [
    "[Desktop Entry]", "Type=Application", "Name=Hasht",
    `Exec=${exec}`, "Terminal=false", "NoDisplay=true",
    `MimeType=${SCHEME_MIME};`, "Categories=Network;", "",
  ].join("\n");
}

/** Sets Hasht as the hasht:// default in a mimeapps.list, keeping every other line. */
export function withHashtDefault(list: string): string {
  const lines = list.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entry = `${SCHEME_MIME}=${DESKTOP_FILE}`;
  const out: string[] = [];
  let inDefaults = false;
  let written = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inDefaults = line.trim() === "[Default Applications]";
      out.push(line);
      if (inDefaults && !written) { out.push(entry); written = true; }
    } else if (!(inDefaults && line.trim().startsWith(`${SCHEME_MIME}=`))) {
      out.push(line);
    }
  }
  if (!written) {
    if (out.length && out.at(-1)!.trim() !== "") out.push("");
    out.push("[Default Applications]", entry);
  }
  return `${out.join("\n")}\n`;
}

function xdgDir(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(os.homedir(), fallback);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** AppImages do not install their bundled launcher into the user's desktop. */
export function registerAppImageProtocol(): void {
  if (process.platform !== "linux" || !process.env.APPIMAGE) return;
  const applications = path.join(xdgDir("XDG_DATA_HOME", ".local/share"), "applications");
  const config = xdgDir("XDG_CONFIG_HOME", ".config");
  // Desktop-specific lists (kde-, gnome-mimeapps.list) take precedence when present.
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").filter(Boolean)
    .map(name => `${name.toLowerCase()}-mimeapps.list`);
  const entry = appImageDesktopEntry(process.env.APPIMAGE);
  try {
    mkdirSync(applications, { recursive: true });
    // Refresh on each launch: APPIMAGE is the persistent file, whereas execPath
    // points inside a temporary mount. Moving/updating the image repairs this.
    writeFileSync(path.join(applications, DESKTOP_FILE), entry, { mode: 0o644 });
    // Written directly, not via xdg-mime: xdg-utils is optional on some
    // distros and an AppImage cannot install it.
    mkdirSync(config, { recursive: true });
    for (const name of [...desktops, "mimeapps.list"]) {
      const file = path.join(config, name);
      let list: string;
      try { list = readFileSync(file, "utf8"); }
      catch (error) {
        if (!missing(error)) throw error;
        if (name !== "mimeapps.list") continue;
        list = "";
      }
      writeFileSync(`${file}.hasht-tmp`, withHashtDefault(list), { mode: 0o644 });
      renameSync(`${file}.hasht-tmp`, file);
    }
  } catch (error) {
    throw new Error(`Your desktop settings could not be updated (${(error as Error).message}).`);
  }
  const run = (file: string, args: string[]) => execFileSync(file, args, {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try { run("update-desktop-database", [applications]); } catch { /* optional cache */ }
  // xdg-mime cannot resolve a quoted Exec, so its answer would be wrong.
  if (execNeedsQuotes(process.env.APPIMAGE)) return;
  let current: string;
  try { current = run("xdg-mime", ["query", "default", SCHEME_MIME]); }
  catch (error) {
    if (missing(error)) return;
    throw new Error("Your desktop could not confirm Hasht as the hasht:// link handler.");
  }
  if (current !== DESKTOP_FILE) {
    throw new Error(current
      ? `Your desktop opens hasht:// links with ${current} instead of Hasht. Change it in your default apps settings.`
      : "Your desktop did not accept Hasht as the hasht:// link handler.");
  }
}
