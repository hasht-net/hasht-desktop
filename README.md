# hasht-desktop

Electron shell for the self-hosted chat app. Thin client: it loads whatever
frontend the configured server is already serving (no bundled copy of the
web app), the same architecture as Mattermost Desktop / Rocket.Chat Desktop.

## Why this exists instead of just using the installed PWA

The web app is already an installable PWA (manifest + service worker). This
shell adds what a PWA can't reliably give you across Windows/Mac/Linux:
a persistent tray icon with unread badges, background operation after the
window is closed, a multi-server switcher, and a real code-signed
auto-updating installer. It intentionally does **not** duplicate the
frontend — updating the server updates every desktop client instantly, with
no separate frontend release train to keep in sync.

## Architecture

- `src/main/` — Electron main process (Node). `main.ts` is the entrypoint;
  `windows.ts` opens one `BrowserWindow` per configured server, each on its
  own session partition (isolated storage — auth is a bearer token in that
  partition's localStorage, not a cookie — mirrors Mattermost's per-server
  renderer); `tray.ts` owns the tray icon/menu/badge; `serverStore.ts`
  persists the server list via `electron-store`; `nativeAuth.ts` handles the
  `hasht://` deep-link browser sign-in handoff; `updater.ts` wires up
  `electron-updater` against the GitHub releases feed.
- `src/preload/` — sandboxed preload scripts, the only bridge between a
  server's page and the main process. `serverPreload.ts` just watches
  `document.title` for the app's existing `(N) ...` unread-*channel*-count
  format and forwards it to main — no changes needed in the web app itself.
  `pickerPreload.ts` backs the "add a server" window.
- `src/renderer-picker/` — plain HTML/JS "add a server" screen, shown on
  first run and from the tray's "Add a server…" item.

## Not yet built (left for follow-up work)

- Code signing / notarization secrets in CI (macOS builds are ad-hoc signed
  only, Windows builds are unsigned — see the comments in
  `electron-builder.yml`).

Deep link handling (`hasht://` protocol) and `electron-updater` wiring are
already built — see `src/main/nativeAuth.ts` and `src/main/updater.ts`.

## Develop

```
npm install
npm run dev
```

## Build installers

Requires running on (or cross-compiling from) each target OS — mac builds
need to run on macOS for signing/notarization; Windows/Linux can cross-build
from macOS or Linux CI runners.

```
npm run dist:mac    # dmg + zip, x64 + arm64 (universal)
npm run dist:win    # nsis installer, x64 + arm64
npm run dist:linux  # AppImage + deb + rpm, x64 + arm64
```

## Desktop launcher icons

Windows and Linux use a transparent blue/purple Hasht mark in `build/icon.ico`
and `build/icon.png`. The mark occupies approximately 90% of the canvas width,
with a small transparent margin to preserve its silhouette. Windows includes
15 sizes from 16 to 256 pixels for common shell and display-scale requests.
Linux packaging uses the PNG for launcher icons and the AUR tarball resource.
The picker and server windows also use this icon on Linux. `desktopName` and
`linux.syncDesktopName` associate running windows with `hasht-desktop.desktop`
so desktop environments can find the installed launcher icon.

Regenerate these two assets from the committed transparent mark using Pillow
(a maintainer tool, not an application or release-build dependency):

```sh
python3 -m venv /tmp/hasht-icon-tools
/tmp/hasht-icon-tools/bin/python -m pip install Pillow==11.3.0
/tmp/hasht-icon-tools/bin/python scripts/generate-desktop-icons.py
```

Microsoft recommends [transparent backgrounds and multiple native icon sizes](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction).
This NSIS/Win32 build uses a single ICO with alpha transparency, rather than the
theme-qualified PNG assets used by MSIX applications. Linux uses the same
theme-neutral artwork; the [freedesktop icon specification](https://specifications.freedesktop.org/icon-theme/latest/)
recommends PNG bitmap assets and neutral icons for the `hicolor` fallback theme.
macOS uses its separate Icon Composer appearances and DMG ICNS asset.

### Account removal and passkey settings

Removing a picker entry cancels its pending sign-in, clears its dedicated browser
partition, and revokes its saved session when the instance is reachable. Other
saved accounts keep their own partitions and sessions. Remote logout is best
effort when the instance is unavailable; local storage is still cleared.

The server frontend can call `chatDesktop.openSecuritySettings(userId)` to open
this instance's HTTPS account-security page in the system browser. The browser
signs in independently and checks the requested account ID before showing
management. No session credential is included in the URL. Native sign-in sessions
use the approved device name as their label in the sessions list.
