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
npm run stage      # copies Node, backend + modules, UI build into payload/
npm run stage:code # copies the Code editor (Nabu, ../../../nabu-code) into nabu-runtime/; optional
npm run dist:mac   # DMG + ZIP in release/  (dist:win = NSIS, dist:linux = AppImage)
```

Without `nabu-runtime/` the app builds without the Code editor. `stage:code` copies only what the editor needs at run time (~1.6 GB of a several-GB checkout): its production packages, and the built-in extensions minus the ones Girru does not use (assistant, account sign-ins, the editor's own tests).

The local payload copies every installed module (large). Release bundles with
a pinned, checksummed Node and production-only modules come later. macOS builds
use ad-hoc signing only; they are not notarized. Windows builds are unsigned.

### First open after downloading

- **macOS:** Control-click Girru.app and choose **Open**, then confirm **Open** once.
  If macOS still blocks it, open **System Settings → Privacy & Security** and choose
  **Open Anyway** for Girru. This is the expected first-open warning for an app
  that has not been notarized; do not remove system protections globally.
- **Windows:** On SmartScreen, choose **More info → Run anyway** for the Girru
  installer only if it came from the official Girru release page.

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

Browser opens inside the normal Girru workspace with Girru tabs, address/navigation controls and device sizes. A hidden CEF Chrome sidecar supplies the active page over a loopback-only frame/input bridge. This local surface is not native NSView reparenting; embedded extension permission dialogs, file dialogs, clipboard edge cases, web-page accessibility and media performance need their own acceptance before production distribution. The current native bootstrap has been tested only on macOS arm64.

`/api/browser/app` is handled by the local UI bridge after an authenticated-owner check. Its closed command schema does not accept executable paths, connection credentials, arbitrary scripts or agent identities. Credentials stay in the dedicated private browser profile. The backend receives only the fixed `DPRO_BROWSER_CONNECTION_FILE` location through trusted desktop startup configuration.

Installing the separate Browser extension registers `browser_workspace`. Existing agent tool grants and approval rules still apply; installation never enables it for all staff. Pairing uses the backend's actual agent/chat context, and each agent's MCP scope contains only its assigned tabs. Actual Chrome profile discovery does not automatically import credentials or delegate imported owner sessions to agents.
