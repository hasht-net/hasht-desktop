# Microsoft Store release

Store ID: **9MZXHPV3BCQL**

`electron-builder.store.yml` extends the regular desktop configuration, but
produces unsigned x64 and ARM64 AppX packages. AppX is the Store package target
supported by our electron-builder 26 version; Partner Center's MSIX/AppX route
accepts it. Microsoft signs the package during Store certification. No Azure
signing subscription or certificate secret is needed.

The package identity is `HashtLLC.Hasht`, the publisher is
`CN=CA077345-9160-40A9-A368-5AEFC4E1EC8F`, and its display name is `Hasht LLC`.
Keep these exactly matched to Partner Center. Store builds use Store-managed
updates, and the Check for Updates menu opens the Store updates page.
The `hasht://` protocol is registered by the package manifest.

## Build

After the workflow is on the default branch, run **Microsoft Store package** in
GitHub Actions. Enter a three-part numeric version, e.g. `0.1.1`. Download and
extract `microsoft-store-packages` from the completed run. Upload both `.appx`
files to the submission's **Packages** page; do not upload the artifact ZIP.
The workflow also builds pull requests as a packaging check, without publishing
or submitting anything.

On Windows, the equivalent local command is:

```sh
npm ci
npm pkg set version=0.1.1
npm run dist:store
```

Outputs are in `release-store/`. These unsigned uploads are intended for Partner
Center, not public sideloading. A real Windows packaging run and Store validation
are required; macOS TypeScript/configuration checks cannot verify those steps.

## Optional automatic uploads (after first publication)

Microsoft's supported CLI requires the app's first publication through Partner
Center before automated updates. Complete the initial private beta submission
manually; then the same build job can upload subsequent updates.

Associate an Entra tenant with Partner Center. Add an Entra app registration
under Account settings → User management → Microsoft Entra applications and give
it the Manager role. Create a client secret and add these GitHub repository
secrets (Settings → Secrets and variables → Actions):

- `STORE_TENANT_ID`: directory/tenant ID.
- `STORE_SELLER_ID`: Partner Center seller/publisher ID, not the Store product ID.
- `STORE_CLIENT_ID`: app registration application/client ID.
- `STORE_CLIENT_SECRET`: client secret **value**, not its ID. Rotate before expiry.

Run **Microsoft Store package** on `main`, enter a higher version, and check
**upload**. It uploads both architectures in one submission. Optionally supply
an existing package flight ID to target a beta flight. The main submission is
used when flight ID is empty. The CLI is pinned to v0.4.3, using its
`--inputDirectory` option to collect both AppX files.

The job uses `--noCommit`: the upload stays in draft rather than entering
certification. Review it in Partner Center before submitting. The CLI recreates
an existing pending draft from the last published submission, so staged draft
metadata edits can be lost: upload before editing the draft. Uploads are
serialized and run only for a manual invocation on `main`; PRs and other branches
only build downloadable artifacts. Credentials are not used for PR builds.

See [Microsoft's CI setup](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions)
and [CLI update prerequisites](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/overview).

## Private beta submission

In Partner Center, create the first submission for Hasht:

1. Under **Pricing and availability → Visibility**, select **Private audience**.
   Add a tester group using testers' personal Microsoft account email addresses.
   Work/school Entra accounts cannot acquire a private-audience app.
2. Upload both architecture packages. Complete age ratings, properties,
   descriptions, screenshots, privacy-policy URL, and support information.
3. In certification notes, explain that Hasht is an Electron desktop client
   connecting to a user-selected Hasht server. It uses `runFullTrust` to run the
   desktop application. Give reviewers a working test server and test account
   if login is needed; do not put reviewer credentials in this repository.
4. Submit for certification after reviewing the listing. Certification and
   tester installation remain necessary before calling the release ready.

Keep the app private until you want a public launch: a public listing cannot
later switch back to Private audience. After initial publication, package
flights can send beta packages to selected groups, including subsets of a
private audience. All packages still undergo certification.

## Versions and testing

The Store version uses `major.minor.patch.0`. The final component is reserved
for Store use; `setBuildNumber: false` prevents CI run numbers from occupying it.
Use a higher numeric version for every new beta package, e.g. `0.1.1` → `0.1.2`.
A prerelease suffix such as `-beta.2` is not a separate Store version: use
private audiences/flights to distinguish release tracks. A stable release that
replaces a flight must have a higher version than the flight.

Test installation from the private Store listing on x64 and ARM64, connecting
to hosted and self-hosted servers, tray/background behavior, `hasht://` links,
microphone/camera and screen sharing. Verify the update menu opens the Store
and the next Store update installs successfully. Existing NSIS installations
have separate installation/data behavior; do not assume automatic migration.

## References

- [Store package uploads](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)
- [Private audiences](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options)
- [Package flights](https://learn.microsoft.com/en-us/windows/apps/publish/package-flights)
- [electron-builder 26 AppX](https://www.electron.build/v26/docs/appx/)
