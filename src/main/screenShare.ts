import {
  desktopCapturer,
  dialog,
  systemPreferences,
  shell,
  type Session,
} from "electron";

// Screen sharing in a voice call. Electron installs no display-media handler
// of its own, and without one `getDisplayMedia()` is refused outright — the
// web app sees a rejection it can't attribute and reports a generic failure.
//
// `useSystemPicker` hands the choice to the OS's own picker (ScreenCaptureKit
// on macOS 14.4+), which is both better than anything we'd draw and the only
// way the user's consent is recorded by the system rather than by us. Where
// that isn't available Electron falls back to calling our handler, so the
// second argument below still has to do something sensible.

export function enableScreenShare(serverSession: Session): void {
  serverSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // Reached only where the system picker isn't available (Windows, macOS
      // below 15, Linux). Handing over a screen we chose ourselves would be a page on an
      // untrusted server getting the whole display without anyone agreeing to
      // it, so ask — a native dialog, since a real picker window is a bigger
      // piece of UI than this fallback warrants.
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (!sources.length) {
        // Empty rather than an error is how macOS reports never having been
        // granted screen recording.
        callback({});
        return;
      }
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Share your screen",
        message: "Which screen do you want to share?",
        buttons: [...sources.map((s) => s.name), "Cancel"],
        cancelId: sources.length,
        defaultId: 0,
      });
      // An empty callback is how this API says "denied"; the page sees the
      // same refusal it would get from a dismissed picker.
      if (response >= sources.length) {
        callback({});
        return;
      }
      // The page's audio request is only a request: system audio arrives only
      // if granted here, and Electron can capture it on Windows alone.
      const video = sources[response];
      callback(
        request.audioRequested && process.platform === "win32"
          ? { video, audio: "loopback" }
          : { video },
      );
    },
    { useSystemPicker: true },
  );
}

/**
 * macOS records screen-recording consent per app, outside anything the page or
 * this process can grant. Everywhere else it's implicitly granted.
 */
export function screenCaptureStatus(): string {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
}

/**
 * macOS shows its screen-recording prompt once, on the first capture attempt,
 * and never again — after a denial the settings pane is the only way back, so
 * that is what "ask again" has to mean here.
 */
export function openScreenCaptureSettings(): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
}
