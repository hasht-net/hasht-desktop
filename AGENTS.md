# AGENTS.md

Electron thin-shell desktop client for the self-hosted chat app (sibling repo:
`hasht`, backend + Vue frontend). This repo embeds none of that frontend — it
just points a `BrowserWindow` at a server URL the user provides. Updating the
server's frontend updates every desktop client instantly; no separate release
train to keep in sync. Mirrors Mattermost Desktop / Rocket.Chat Desktop.

## Layout

- `src/main/main.ts` — entrypoint: app lifecycle, single-instance lock, IPC
  handlers, tray-quit-vs-close behavior (window close ≠ quit).
- `src/main/windows.ts` — one `BrowserWindow` + isolated session partition
  (`persist:server-<id>`) per configured server; sandboxed preload; external
  links open in the OS browser, not a new app window.
- `src/main/serverStore.ts` — persisted server list (`electron-store`),
  never credentials — each server keeps its own auth (a bearer token in that
  session partition's localStorage), isolated per partition.
- `src/main/tray.ts` — tray icon/menu, per-server unread badge counts.
- `src/main/nativeAuth.ts` — browser-handoff passkey sign-in (`/api/auth/native/*`)
  over the `hasht://` deep-link scheme, registered/handled from `main.ts`. Only
  offered on macOS, where in-shell WebAuthn is broken (`needsBrowserSignIn` in
  `serverPreload.ts`); Windows/Linux use the normal in-page passkey flow.
  `native-auth:start` returns the match code, which the server page shows the
  user to check against the browser's.
  `hasht://signin?server=<origin>` (the web app's "Sign in to the App") runs the
  same flow from a browser: a dialog shows the host and match code first, https
  origins only, and a new server is added only once sign-in succeeds.
- `src/main/updater.ts` — `electron-updater` wiring against the GitHub
  releases feed configured in `electron-builder.yml`'s `publish:` block.
- `src/main/screenShare.ts` — display-media handler (Electron refuses
  `getDisplayMedia` without one), preferring the OS picker; plus the macOS
  screen-recording status/settings the page can't reach itself.
- `src/preload/serverPreload.ts` — sandboxed bridge into the server's own
  page. Reads unread *channel* count (not message count) from
  `document.title`'s existing `(N) Title` format (see `hasht` repo's
  `frontend/src/App.vue`) — no frontend changes needed. Keep this bridge
  minimal; it's the only thing standing between an untrusted self-hosted
  server and the main process.
- `src/preload/pickerPreload.ts` + `src/renderer-picker/` — the welcome /
  onboarding screen (shown on first run and from the tray menu): pick Hasht
  Cloud (chat.hasht.net) or enter a self-hosted server, plus the list of
  already-added servers.
- `electron-builder.yml` — mac (dmg/zip), Windows (nsis), Linux
  (AppImage/deb/rpm), each x64+arm64. Signing/notarization via env vars, not
  checked in.

## Conventions

- Every server window: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. Don't weaken this — servers are user-supplied,
  potentially untrusted hosts.
- New IPC surface goes through `contextBridge.exposeInMainWorld`, never
  raw `ipcRenderer`/Node exposed to a renderer.
- Build: `npm run build` (tsc). Dev: `npm run dev`. Package:
  `npm run dist:mac|win|linux`.

## Not yet built

Code signing / notarization secrets in CI. Deep link handling and
`electron-updater` wiring are already built (`src/main/nativeAuth.ts`,
`src/main/updater.ts`) — don't re-scaffold them.
