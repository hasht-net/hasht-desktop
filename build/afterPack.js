const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Ad-hoc sign macOS builds when no real signing identity is configured.
 *
 * Without any signature at all, macOS refuses a downloaded .app outright with
 * "the application is damaged and can't be opened" — a dead end that only
 * offers to move it to the Trash. Apple Silicon additionally requires every
 * binary to carry *some* valid signature just to execute.
 *
 * An ad-hoc signature (`--sign -`) fixes both: the app becomes runnable, and
 * Gatekeeper downgrades to the ordinary "Apple could not verify this app is
 * free of malware" prompt, which the user can get past via Open Anyway in
 * System Settings. It is not a substitute for notarization — that needs a
 * Developer ID — it just turns an unopenable download into an openable one.
 *
 * `--options runtime` turns on hardened runtime, which camera/mic access
 * needs even outside App Sandbox — but hardened runtime's own entitlements
 * split into two classes. Plain ones (JIT, outbound network) an ad-hoc
 * signature can declare freely. Camera, mic, Bluetooth and keychain-access-
 * groups are AMFI "restricted" entitlements: the kernel refuses to even
 * launch a binary that declares them without a real Apple-issued identity
 * behind it ("The file is adhoc signed but contains restricted entitlements",
 * confirmed via `log show` against amfid). So this ad-hoc path gets hardened
 * runtime plus only the non-restricted entitlements — camera/mic/Bluetooth
 * stay unentitled here, same as before this file started passing
 * `--options runtime` at all. A real Developer ID build (electron-builder's
 * own signing path, once CI secrets exist) gets the full entitlements.mac
 * .plist instead, where those keys work as intended.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (context.targets.some((target) => target.name.startsWith("mas"))) return;

  // A real identity is configured, so electron-builder is doing the signing
  // properly and must not be overwritten with a weaker ad-hoc signature.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  // For a --universal build, electron-builder runs afterPack once per source
  // arch (into a "*-temp" appOutDir) before merging them, then once more on
  // the merged result. Signing the per-arch intermediates makes their sealed
  // resources diverge just enough that the merge step refuses to combine them
  // ("Expected all non-binary files to have identical SHAs"). Only the final
  // output needs a signature.
  if (context.appOutDir.endsWith("-temp")) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const entitlements = path.join(__dirname, "entitlements.mac.adhoc.plist");

  // --deep is deprecated for real distribution signing but is still the way
  // to ad-hoc sign the nested Electron frameworks and helper apps in one go.
  // It applies this same entitlements file to them too — broader than the
  // main/inherit split electron-builder does with a real identity, but
  // harmless (the extra keys are inert for a helper process that never uses
  // them) and far simpler than re-signing each nested bundle individually.
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      "--sign",
      "-",
      appPath,
    ],
    { stdio: "inherit" },
  );
};
