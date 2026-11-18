# Girru desktop app

Electron shell for Girru. One window, one instance.

- **This computer:** the app starts the Girru backend on the bundled
  Node runtime, on `127.0.0.1` with a random port and a fresh per-launch token
  that every request must carry. The UI bridge (`packages/core-ui/scripts/application-server.cjs`)
  runs inside the app on a second random loopback port and adds the token; the
  page never sees it. Before starting, a read-only check looks for an existing
  owner in known data folders or your saved workspace. A verified existing
  workspace opens sign-in; ambiguous or unreadable data opens a folder chooser
  instead of creating an account. A new workspace requires an explicit choice
  and confirmation, then opens owner setup with a one-time local code. The
  password form offers local generation, visibility and strength guidance.
- **An existing Girru:** menu → *Connect to an Existing Girru…* opens another
  Girru after checking its setup endpoint, by its `https://` address (or `http://` on this computer, for example
  through an SSH tunnel). Nothing runs locally then.
- **Quit** (menu, Cmd/Ctrl+Q or closing the window) stops the backend first:
  an IPC shutdown request, then a forced stop after 15 s. The backend also
  stops by itself when the app's IPC channel closes (crash, force quit).

The selected workspace path is saved in `desktop.json`'s sibling `workspace.json`.
Existing legacy `.data` workspaces retain their original working directory and
legacy store paths. No database or key is moved or merged. A fresh workspace
lives under `<userData>/workspaces/<id>`; older desktop data lives in the OS app-data folder (`~/Library/Application Support/Dpro/data`
on macOS); the redacted backend log in `…/Dpro/logs/backend.log`.

## Run from source

```sh
# once: a live core-ui candidate build (no dev quick-login)
(cd ../core-ui && node scripts/build.cjs --candidate --live-entry)
npm start
```

## Local app build

```sh
npm run stage      # compiles the backend and copies Node, runtime modules and UI into payload/
npm run stage:code # optional: bundles the Code editor (Nabu, ../../../nabu-code) into nabu-runtime/
npm run dist:mac   # DMG + ZIP in release/  (dist:win = NSIS, dist:linux = AppImage)
```

Every `dist:*` build first runs `scripts/check-bundle-inputs.cjs`. Code and GenVR are Store apps: core releases build without either runtime. Girru downloads a reviewed archive, checks its exact size and SHA-256, and unpacks it into its own app runtime folder. Removing GenVR removes its program files while keeping projects, worlds and account settings. A manual restart is required when the running host cannot restart automatically. Developer checkouts may still use `core-ui/scripts/prepare-genvr.cjs` for the pinned local SDK; it is not copied by `stage`. The input check refuses a partially staged optional runtime. `npm run stage:code` remains available for developer editor builds.

The payload compiles backend TypeScript to JavaScript at build time and preserves
its adjacent runtime assets. Packaged startup needs no TypeScript loader. Only
production packages listed in the backend lockfile are copied; TypeScript, tsx
and esbuild stay out of the payload, as do stale installed packages and native
prebuilds for other platforms. Staging requires an already installed TypeScript
compiler in the backend or core-ui development dependencies; it downloads nothing.
Installed runtime package paths and versions must match the lockfile; staging
refuses drift before replacing the previous payload. The bridge uses Node built-ins
only. Extension Node entries must be JavaScript; their frontend source files are
build inputs and are not executed by the backend. macOS builds
use ad-hoc signing only; they are not notarized. Windows builds are unsigned.

### First open after downloading

- **macOS:** Control-click Girru.app and choose **Open**, then confirm **Open** once.
  If macOS still blocks it, open **System Settings → Privacy & Security** and choose
  **Open Anyway** for Girru. This is the expected first-open warning for an app
  that has not been notarized; do not remove system protections globally.
- **Windows:** On SmartScreen, choose **More info → Run anyway** for the Girru
  installer only if it came from the official Girru release page.

### Updates

The installed app looks for a new published Girru release once a day and never
updates by itself. When one is ready, an **Update** button appears in the top bar.
Pressing it asks once, then Girru downloads the release file for this computer from
the official Girru releases on GitHub, checks it against the release's
`SHA256SUMS-<platform>.txt`, and makes a backup of your data first.

- **macOS:** the new Girru.app replaces the running one and Girru starts again.
- **Windows:** Girru closes, the installer runs silently into the same folder and
  opens Girru again.
- **Linux, or a run from source:** the update page links to the release instead.

Release files are checked by checksum only; the builds are not code-signed (see above).

The installer does not report a fabricated percentage. When Girru launches, its
Starting window names the current checks (“Checking the installation files…”,
“Starting the local service…”, and “Looking for an existing workspace…”); the
window stays open while each real stage completes.

## Tests

```sh
npm test   # process lifecycle with a stand-in backend, settings, setup code
```


## Current release pipeline

Use the **Current Desktop Release** workflow in `.github/workflows/desktop-release.yml`. It builds the shared `core-ui`, backend and Electron shell for macOS Apple Silicon, macOS Intel, Windows x64 and Linux x64. Root Next.js sources and the Tauri bootstrap installer are retired. The legacy release workflows intentionally refuse to build.

The workflow uses Node 24.21.0 and package lockfiles, runs UI/import/desktop retention tests, prunes backend development dependencies, stages the bundled runtime and verifies its dependencies from outside the checkout. Test quick-login builds are refused independently of any private local account configuration. Installers have platform-specific SHA256 manifests. A normal manual run only uploads build artifacts; `publish_draft` creates a draft only after every platform passes. Public publication is a separate release review. macOS builds are ad-hoc signed but not notarized; Windows builds are unsigned.

Updates replace application binaries while retaining the selected workspace and operating-system profile. Never package a developer database, `.data`, `.env`, local account configuration or live keys. Do not migrate or merge existing workspaces as part of installation. Existing installations must retain their saved workspace selection; ambiguous discovery requires an explicit choice rather than creating another owner.

For packaging diagnostics, the workflow platform selector can verify one platform independently. Draft publication is allowed only with the default all-platform selection.

### Browser workspace (local development)

The optional full-Chromium Browser runtime is developed in the [applications repository](https://github.com/Dpro-at/girru-store/tree/main/apps/browser). A local trial can select its source root with `DPRO_BROWSER_ROOT` and a dedicated browser profile with `DPRO_BROWSER_PROFILE`. Never select an existing Chrome or Girru application data directory as the browser runtime profile.

Browser opens inside the normal Girru workspace with Girru tabs, address/navigation controls and device sizes. An offscreen transparent CEF Chrome sidecar supplies the active page over a loopback-only frame/input bridge. This local surface is not native NSView reparenting; a macOS owner-only sheet forwards native Chrome permission text and live enabled actions. The tested Chrome Web Store extension installed successfully through this sheet. Optional extension permissions, file dialogs, clipboard edge cases, web-page accessibility and media performance need separate acceptance before production distribution. The current native bootstrap has been tested only on macOS arm64.

`/api/browser/app` is handled by the local UI bridge after an authenticated-owner check. Its closed command schema does not accept executable paths, connection credentials, arbitrary scripts or agent identities. Credentials stay in the dedicated private browser profile. The backend receives only the fixed `DPRO_BROWSER_CONNECTION_FILE` location through trusted desktop startup configuration.

Installing the separate Browser extension registers `browser_workspace`. Existing agent tool grants and approval rules still apply; installation never enables it for all staff. Pairing uses the backend's actual agent/chat context, and each agent's MCP scope contains only its assigned tabs. Actual Chrome profile discovery does not automatically import credentials or delegate imported owner sessions to agents.

### Optional GenVR runtime

GenVR opens its existing Store page when its runtime is absent. The desktop host supplies `GIRRU_APP_RUNTIMES_DIR`; a source/web deployment must explicitly configure the same absolute runtime folder for its backend and local UI bridge. Such deployments need a manual restart after adding or removing the runtime. Remote backends do not install a runtime on the viewing computer.

Only the SDK version pinned by the running Girru build is accepted. A newer incompatible Store archive requires updating Girru. Archive integrity is checked before installation; program files are protected from agent filesystem edits. Account settings and worlds survive removal. Re-adding or relocating the managed MCP launch resets agent tool grants, which must be reviewed again.

On AppImage or translocated macOS installations whose Node executable path changes at each launch, the managed MCP launch is re-approved and its agent grants are reset on each restart. Review GenVR agent permissions again in those environments.

### Agent Connect channels

Channels use the existing Agent Connect package as a separate Store app. The core includes the web channel and a small configuration/security host, with no Agent Connect, Telegram, WhatsApp or Graph provider dependencies in its production payload. Settings › Channels opens the Store when the app is missing. The Store uses pinned npm archives and no install scripts; optional Python providers still need their own explicit setup. Removal stops channels while retaining settings, credentials, delivery history and provider state. Re-adding keeps channel choices and does not switch disabled channels on.

### Optional Call Center, Trading and Browser

The core payload omits Twilio and Puppeteer. Call Center installs its reviewed provider program from the Store; it preserves old phone data through the existing backup-first namespace migration. Trading installs its existing practice renderer while the trusted paper proof and ledger host remain in Girru. Browser installs the existing Puppeteer engine; API/tool grants and public-network restrictions stay in the core. All three use owner-controlled activation in My apps and require a restart when indicated. Removal retains data and permissions and retires active hosts.

Trading renderer code is trusted same-origin application code, not an isolated third-party sandbox. Adding the app does not by itself grant paper execution authority. Browser Get installs only the program and pinned SDK archives, without downloading Chrome or importing browser profiles. A compatible cached browser or absolute operator `GIRRU_BROWSER_EXECUTABLE` is required. The native browser workspace evaluation remains separate.
