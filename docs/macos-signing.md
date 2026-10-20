# macOS signing and TestFlight

Two distinct builds are required: regular Electron signed with Developer ID
and notarized for direct downloads; sandboxed MAS Electron signed for App Store
Connect and distributed through TestFlight / the App Store.

## Apple setup

1. Decide whether macOS and iOS share an App Store Connect record. The current
   bundle ID is `net.hasht.app`. Keep it for a shared record; if using separate
   records, settle both IDs before creating profiles or changing the app ID.
2. In developer.apple.com/account, register an explicit App ID matching the
   build. In App Store Connect, Apps > + > New App: macOS, Hasht, primary
   language English (US), matching Bundle ID, SKU `hasht-desktop-macos`.
   A shared record can add the iOS platform later.
3. Create Developer ID Application, Apple Distribution, and Mac Installer
   Distribution certificates. Export each certificate **with its private key**
   from Keychain Access as a password-protected .p12. Do not commit them.
4. Create a Mac App Store distribution provisioning profile for that explicit
   App ID and Apple Distribution certificate; download the .provisionprofile.
5. Generate an app-specific password for the Apple account used to notarize.
   App Store Connect access alone does not guarantee permission to create
   certificates: ask the Account Holder/Admin for developer-resource access.

## GitHub configuration

In Hasht-net/hasht-desktop Settings > Secrets and variables > Actions, add:

| Name | Value |
| --- | --- |
| MAC_DEVELOPER_ID_P12 | Base64 Developer ID Application .p12 |
| MAC_DEVELOPER_ID_PASSWORD | Its export password |
| MAC_APP_STORE_P12 | Base64 Apple Distribution .p12 |
| MAC_APP_STORE_PASSWORD | Its export password |
| MAC_INSTALLER_P12 | Base64 Mac Installer Distribution .p12 |
| MAC_INSTALLER_PASSWORD | Its export password |
| MAC_APP_STORE_PROFILE | Base64 .provisionprofile |
| APPLE_ID | Apple account email for notarization |
| APPLE_APP_SPECIFIC_PASSWORD | Its app-specific password |

Add repository **variable** `APPLE_TEAM_ID` containing your Team ID.
On macOS, `base64 -i /path/to/file | pbcopy` copies the encoded file for pasting
into GitHub Secrets. Keep passwords and encoded private keys out of chat/logs.
An App Store Connect API key is unnecessary for this initial manual upload.

## Build and upload

Run Actions > Signed macOS > Run workflow with the intended branch, channel
`testflight` or `direct`, and numeric version such as `0.1.1`. The run number
provides a monotonically increasing CFBundleVersion for repeat uploads.
This workflow uploads artifacts only; it does not publish GitHub releases or
change the existing unsigned release workflow.

For TestFlight, download the artifact and upload the signed universal .pkg
using Apple's Transporter app. After processing in App Store Connect, complete
export compliance questions, create an internal TestFlight group, and add the
build and testers. External testers require beta review; supply beta contact
information and working review sign-in instructions.

Before expanding testing, verify sandboxed file upload/download, microphone,
camera, screen sharing, notifications and browser-handoff sign-in. MAS builds
use App Store/TestFlight updates rather than the GitHub DMG updater. A build
that signs successfully still needs Apple processing and runtime testing.

## Automatic prerelease uploads

Publishing a GitHub **prerelease** triggers Signed macOS to build, validate and
upload the universal MAS package to App Store Connect. This workflow must be
included in the released commit. Tags such as `v0.1.2-beta.1` use numeric Apple
version `0.1.2`; the workflow run number and attempt form the build number.
Stable releases do not trigger this TestFlight job. Manual dispatch supports
an `upload` checkbox, defaulting to false. Branch pushes only build artifacts.

In App Store Connect > Users and Access > Integrations > App Store Connect API,
create a **Team Key** with Developer access. Download the .p8 once and save its
raw text (not base64) as GitHub secret `ASC_API_KEY_P8`. Add repository variables:

- `ASC_KEY_ID`: the key ID.
- `ASC_ISSUER_ID`: the team key’s issuer UUID.
- `ASC_MACOS_APP_ID`: the numeric Apple ID under Hasht > App Information.

The workflow uses `xcrun altool --validate-app` and `--upload-package`; API key
material is written only into a private temporary directory and removed on exit.
A successful upload does not mean Apple processing or beta review has completed.
Configure an internal TestFlight group with automatic distribution of new builds
in App Store Connect. External testers still require beta review.
