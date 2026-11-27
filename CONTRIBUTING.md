# Contributing to Girru

Girru's current application is the Electron desktop shell in `packages/desktop`, the React + TypeScript + Vite interface in `packages/core-ui`, and the Fastify backend in `packages/backend`.

**Building an app, extension, MCP listing, skill, or specialty? Start with [Girru Store](https://github.com/Dpro-at/girru-store).** This repository owns the shared workspace and runtime; the Store repository owns the catalogue and distributable items.

## Choose the right repository

| What you want to contribute | Where to work |
|---|---|
| An installable app or extension package | [Girru Store](https://github.com/Dpro-at/girru-store), under `apps/<id>/` |
| An MCP server listing | Girru Store, under `mcp/<id>/` |
| A reusable written workflow (skill) | Girru Store, under `skills/<id>/` |
| An agent job or role (specialty) | Girru Store, under `specialties/<id>/` |
| Shared UI, memory, agent execution, permissions, or desktop integration | This Girru repository |
| A reusable messaging transport or GenVR SDK feature | The owning repository in the [ecosystem map](docs/ecosystem/repositories.md) |

Skills provide written guidance; extensions and tools provide executable capabilities. Installing an item or assigning a skill does not grant an agent permission to use tools. A Store listing that needs new host support also requires a compatible implementation in Girru.

Read the [contribution map](docs/contributing/README.md), [architecture](docs/architecture/overview.md), and [shared contributor workflow](docs/contributing/agent-workflow.md) before changing an unfamiliar area.

## Add an item to Girru Store

Follow the Store's [README](https://github.com/Dpro-at/girru-store/blob/main/README.md) and [CONTRIBUTING.md](https://github.com/Dpro-at/girru-store/blob/main/CONTRIBUTING.md).

1. Fork `Dpro-at/girru-store`, clone your fork, and create a branch.
2. Add one item directory under `apps/`, `mcp/`, `skills/`, or `specialties/`, with a `manifest.json`. The manifest kind must match its directory.
3. For a packaged app, add `apps/<id>/package/agentplayer.plugin.json` and its executable JavaScript entry. Follow the current package, migration, permission, and version rules. Native runtimes use separate host-supported contracts.
4. From the Store checkout on macOS/Linux (or a checkout inside WSL on Windows), regenerate and check the catalogue:

   ```sh
   node scripts/build-index.mjs
   node scripts/build-index.mjs --check
   ```

5. Commit the item and generated `index.json`, then open a pull request in **girru-store** explaining its behaviour, permissions, data use, compatibility, and validation.

Never edit `index.json` by hand. Use English in public item files, include no secrets or personal data, and keep one item per pull request. The Store currently accepts free pricing only. Its contribution process requires automated security review and maintainer review before merging.

Girru reads the Store catalogue without requiring a new core release for every listing. Actual installation and use still depend on a compatible host, the item's package or runtime, and the owner's choices. See the [Store integration guide](docs/contributing/store-apps.md).

## Set up Girru core development

### Requirements

- Git.
- **Node.js 24.21.0**, matching the current [test workflow](.github/workflows/tests.yml), and npm. The core UI's minimum engine range is `^20.19.0 || >=22.12.0`; Node 18 is not supported by that package.
- Platform build tools and Python if a native dependency needs to compile. The desktop release workflow uses Python 3.12. Speech engines have their own optional setup.
- Docker or PostgreSQL only for checks and workflows that require them.

Use each package's committed `package-lock.json` and `npm ci`. A root dependency install does not set up the three application packages.

### Clone and install

Fork [Dpro-at/Girru](https://github.com/Dpro-at/Girru), then run:

```sh
git clone https://github.com/YOUR_USERNAME/Girru.git
cd Girru
git remote add upstream https://github.com/Dpro-at/Girru.git
git switch -c my-change

npm ci --prefix packages/backend
npm ci --prefix packages/core-ui
npm ci --prefix packages/desktop
```

`YOUR_USERNAME` refers to your fork owner. Run the following commands from this checkout's root unless a different directory is stated.

### Build and run the desktop app

Build both the default UI and the live candidate used by the desktop shell:

```sh
node packages/core-ui/scripts/build.cjs
node packages/core-ui/scripts/build.cjs --candidate --live-entry
```

Close any running Girru desktop instance. Launch the development copy with a dedicated, absolute profile path outside the checkout. Use a fresh terminal without production data-path or credential overrides, and keep the same development profile on subsequent runs.

**Windows PowerShell:**

```powershell
$env:GIRRU_PROFILE_DIR = Join-Path $env:LOCALAPPDATA 'Girru-contributor'
npm --prefix packages/desktop start
```

**macOS / Linux:**

```sh
GIRRU_PROFILE_DIR="$PWD/../girru-contributor-profile" npm --prefix packages/desktop start
```

`GIRRU_PROFILE_DIR` separates desktop settings and workspace discovery from the normal installation. Choose a development workspace in the first-run flow; do not select your personal workspace or import personal files for testing.

The desktop shell starts the backend and UI bridge together on random loopback ports and stops them when it quits. You do not need to start a second backend terminal or open a fixed frontend port for this path. Rebuild the live candidate after UI changes and restart the app to use the updated build.

Follow the current first-run flow, including Google verification for a new account. Configure a supported local model or provider through the app's AI tools. A Claude API key is not a universal development prerequisite; local models, supported subscription connections, and API providers have different setup requirements.

See the [desktop README](packages/desktop/README.md) for startup, workspace selection, optional runtimes, and packaging.

### Work on UI fixtures only

For interface work without a live backend or provider, use:

```sh
npm --prefix packages/core-ui run dev
```

This serves the fixture interface at `http://127.0.0.1:42522`. The default Vite entry uses simulated data; it is not a live Girru session. See the [core UI README](packages/core-ui/README.md) for the distinction between fixture, candidate, and authenticated bridge builds.

The root Next.js interface and Tauri bootstrap installer are retired. Root `npm run dev`, `npm run build`, and `npm start` deliberately refuse to run; use the package commands above.

## Project structure

```text
Girru/
├── packages/
│   ├── core-ui/           # Current React + TypeScript + Vite interface
│   ├── backend/           # Fastify API, agent runtime, memory and persistence
│   ├── desktop/           # Electron shell, lifecycle and installer tooling
│   ├── display-renderer/  # Shared structured display rendering
│   ├── mcp-server/        # Girru MCP integration
│   ├── cli/               # Command-line tooling
│   ├── account-service/   # Account service
│   └── relay/             # Relay service
├── docs/                  # Architecture and contribution guides
├── scripts/               # Shared tooling and test harnesses
└── .github/workflows/     # Tests, security checks and desktop releases
```

Store item folders and the generated Store index belong to the separate [girru-store repository](https://github.com/Dpro-at/girru-store). Optional apps can also depend on independently maintained runtimes; consult the [ecosystem map](docs/ecosystem/repositories.md).

## Development guidelines

- Keep changes focused and reuse the owning package's existing services, components, and contracts.
- Use English for public documentation, code comments, and commit messages. Put translated interface strings in the active screen's catalogues and preserve RTL behaviour.
- Use TypeScript for current UI and backend code, and executable JavaScript for extension runtime entries. Do not put uncompiled TypeScript syntax in `.js` files.
- Reuse the core UI's existing icons, notifications, dialogs, styling, and accessibility patterns. Bundled Tabler assets are available in `packages/core-ui/assets/tabler`; legacy Lucide/Sonner guidance is not a requirement for the current UI.
- Preserve authenticated owner and agent context, tool grants, approval checks, and data ownership. Never hardcode a user ID or trust a client-supplied identity as authority.
- Use the appropriate database/repository API and parameterized SQL. Keep migrations compatible with the supported database drivers and existing workspaces.
- Use synthetic development data. Never commit `.env`, `.data`, account files, keys, private logs, or copied production databases.

SQLite is the default backend store; PostgreSQL is also supported in configured deployments. Desktop data follows the selected workspace. Do not assume every installation uses `packages/backend/.data/database.db`. SQLite startup migration and PostgreSQL migration handling differ; check the current [database module](packages/backend/src/db/index.ts) and [storage map](docs/architecture/storage-map.md).

### Extensions and apps

Start with the [extension guide](docs/contributing/extensions.md), [current quickstart](docs/extensions/quickstart.md), and [permission model](docs/extensions/permissions.md). Keep independent application logic in its package and submit distributable items through Girru Store.

Document lifecycle, permissions, migrations, external services, data retention, and removal behaviour. Native capabilities need explicit host support. Older examples that add `src/app/...` pages target the retired Next.js interface; use the current integration contracts.

### Data and privacy documentation

If a change adds a store, a copy of data, a new data type, or an outbound transfer, update the [storage map](docs/architecture/storage-map.md) in the same pull request.

- Distinguish implemented, switch-controlled, and planned behaviour.
- For a new memory switch, update the switch tables in the storage map and [upgrade guide](docs/UPGRADING.md), including behaviour for existing data.
- Publish performance numbers only with the measurement conditions.

## Validate your change

Start with the affected tests, then run the package and CI checks required for the change. The [testing guide](docs/contributing/testing.md) and [test workflow](.github/workflows/tests.yml) define the current harness and integration prerequisites.

**Core UI, from the repository root:**

```sh
npm --prefix packages/core-ui run typecheck
npm --prefix packages/core-ui test
node packages/core-ui/scripts/build.cjs
node packages/core-ui/scripts/build.cjs --candidate --live-entry
```

**Desktop, from the repository root:**

```sh
npm --prefix packages/desktop test
```

Build the UI first for tests that serve it. Native window, permission, hardware, and installer behaviour also need acceptance on the affected platforms.

**Backend, starting from the repository root:**

```sh
cd packages/backend
npx --no-install tsc --noEmit -p .
node --import tsx --import ../../scripts/test-temp-root.mjs --test test/cli-invocation.test.mjs
```

The test above is an example of a focused backend check; select the tests for your change. The full CI suite handles memory-encryption tests with a separate fixture harness and disposable PostgreSQL, and runs account tests with reduced concurrency. Some provider tests need a running local service. Use the workflow's prerequisites and grouping instead of treating one wildcard command as the full suite.

There is no root `test` or `type-check` script. The root `lint` script currently delegates to core UI type checking; it is not a separate repository-wide lint suite.

For documentation-only changes, check links, paths, command names, examples, and diff whitespace. An unrelated application test suite is not required. Record exactly what you checked and any skipped or unverified behaviour.

## Pull requests

1. Make one focused change on a branch in the appropriate repository.
2. Add relevant tests and update affected documentation in the same change.
3. Use descriptive Conventional Commit messages such as `feat:`, `fix:`, `docs:`, or `test:`.
4. Explain the problem, resulting behaviour, how it was checked, and any remaining limitations. Link related issues and include screenshots for visible UI changes, using synthetic data.
5. For changes spanning Girru and the Store or an SDK, link the related pull requests and specify minimum compatible versions and release order.
6. Let the required checks finish and address maintainer review before merging. Avoid force-pushing after review starts.

A normal contribution does not publish a desktop release. Packaging and draft-release creation use the manually dispatched [Current Desktop Release workflow](.github/workflows/desktop-release.yml); public release is a separate review step. Do not use the retired release workflows.

## Bugs, ideas, and support

Search [existing issues](https://github.com/Dpro-at/Girru/issues) before opening a new one. Include the Girru version or commit, operating system, reproduction steps, expected and actual behaviour, and redacted logs or screenshots. Report Store-specific issues in [girru-store](https://github.com/Dpro-at/girru-store/issues).

For feature requests, describe the use case, proposed behaviour, and the package or repository that should own it. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue containing sensitive details.

Be respectful and inclusive, welcome questions, and keep feedback constructive. Contributions to code, testing, documentation, translations, accessibility, and design are welcome.
