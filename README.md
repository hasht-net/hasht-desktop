# Hasht Desktop

The desktop client for [Hasht Chat](https://github.com/hasht-net/hasht-chat), built
with Electron for macOS, Windows, and Linux. It loads the frontend from your chosen
server and adds a tray icon, unread badges, background operation, a server/account
picker, screen sharing, and native update support.

The chat frontend is served by the instance, so frontend updates do not require a new
desktop release. Native features and bridge changes need a desktop update. The [iOS
and Android client](https://github.com/hasht-net/hasht-app) uses the same approach.

## Development

```sh
npm ci
npm run dev
```

`npm run build` checks TypeScript and compiles the Electron code. `npm run dev`
watches and recompiles it; restart Electron to load main-process changes.

## Build installers

```sh
npm run dist:mac    # DMG and ZIP, separate x64 and arm64 builds
npm run dist:win    # NSIS, x64 and arm64
npm run dist:linux  # AppImage, deb, rpm, tar.gz; x64 and arm64
```

CI builds on a runner for each target OS. macOS release builds require Developer ID
signing and notarization credentials; Windows signing is not configured in the
release workflow. See [macOS signing and TestFlight](docs/macos-signing.md) for
direct-download and Mac App Store builds.

Publishing a GitHub release triggers `.github/workflows/release.yaml` to build and
attach installers. macOS direct-download builds use the GitHub updater; TestFlight
and App Store builds use store updates.

## Architecture

| Path | Purpose |
| --- | --- |
| `src/main/main.ts` | App lifecycle, IPC, deep links, and tray/quit behavior. |
| `src/main/windows.ts` | Server windows with a separate browser session partition for each saved entry. |
| `src/main/serverStore.ts` | Saved server list, account labels, and window bounds. Credentials stay in browser partitions. |
| `src/main/nativeAuth.ts` | Browser sign-in and `hasht://` callbacks. |
| `src/main/screenShare.ts` | Screen capture and OS permission integration. |
| `src/main/updater.ts` | Updates through `electron-updater`. |
| `src/preload/serverPreload.ts` | Sandboxed bridge for server pages, including unread counts and notification clicks. |
| `src/preload/pickerPreload.ts`, `src/renderer-picker/` | Bundled server/account picker. |

Server pages are user-supplied. Keep their windows sandboxed, with context isolation
enabled and Node integration disabled. Expose native operations through the preload
bridge with validation in the main process.

### Browser sign-in and passkeys

Browser sign-in is offered on all desktop platforms so users can access their
browser's passkeys. The app holds the PKCE verifier and exchanges the browser's
one-time code for its own session. Native sessions use the approved device name in
the sessions list.

A `hasht://signin?server=<https-origin>` link confirms the host before starting
sign-in and adds a new server only after success. Optional invitation, registration,
and destination forwarding are documented in [onboarding
continuation](docs/ONBOARDING_CONTINUATION.md). The server protocol is in
[hasht-chat's native sign-in
guide](https://github.com/hasht-net/hasht-chat/blob/main/docs/NATIVE_SIGN_IN.md).

Removing a picker entry cancels its pending sign-in, clears its browser partition,
and revokes its saved session when the instance is reachable. Other saved entries
keep their partitions and sessions. Remote logout is best effort when the instance is
unavailable.

For passkey creation, the frontend calls
`chatDesktop.openSecurityManagement(ticket)`. Main validates the 64-character hex
ticket and opens `/?security_management=1#ticket=<ticket>` at the requesting window's
configured HTTPS origin in the system browser.

The server ticket is single-use and valid for 60 seconds. The browser exchanges it
for a ten-minute, in-memory passkey-management credential; enrollment requires
password or passkey verification. This does not change the browser's login.
`openSecuritySettings(userId)` supports older server frontends.

### AppImage browser sign-in

On Linux, Hasht registers a per-user `hasht://` callback launcher on startup and
checks it before browser sign-in. This requires `xdg-utils` and a writable
`$XDG_DATA_HOME/applications` (default `~/.local/share/applications`).

`net.hasht.app.AppImage.desktop` points at the persistent AppImage file. Launch a
moved or updated image from its new location before signing in. Keep the app running
during browser approval; restarting discards the pending verifier.

## Launcher icons

Windows and Linux use the transparent Hasht mark in `build/icon.ico` and
`build/icon.png`. The ICO includes 15 sizes from 16 to 256 pixels. Linux packages and
windows use the PNG; `desktopName` and `linux.syncDesktopName` associate windows with
`hasht-desktop.desktop`. macOS uses separate Icon Composer and DMG ICNS assets.

Regenerate the Windows and Linux assets from the committed mark with Pillow:

```sh
python3 -m venv /tmp/hasht-icon-tools
/tmp/hasht-icon-tools/bin/python -m pip install Pillow==11.3.0
/tmp/hasht-icon-tools/bin/python scripts/generate-desktop-icons.py
```

Pillow is a maintainer tool, not an app or release-build dependency.
