# Development setup

## Pick the surface first

Read [architecture](../architecture/overview.md). The root `pnpm dev` command runs the legacy Next.js application; it does not launch the current Electron workspace.

Use the Node version required by the package and CI. Core UI currently requires `^20.19.0 || >=22.12.0`; do not use the old Node 18 instructions. Use each package's committed lockfile and documented package-manager workflow; do not mix lockfiles. If dependencies are already installed, do not reinstall them as a routine check.

## Checks without starting services

From the repository root, with dependencies already available:

```sh
npm --prefix packages/core-ui run typecheck
npm --prefix packages/core-ui test
npm --prefix packages/backend run build
npm --prefix packages/desktop test
```

Backend build emits output. Select the narrower backend tests appropriate to your change; see [testing](../contributing/testing.md). Runtime tests need compatible native dependencies and the correct Node version.

## Local execution

Core UI development: `npm --prefix packages/core-ui run dev` (loopback port 42522). Backend development: `npm --prefix packages/backend run dev`; inspect its configuration before starting. Its predev command invokes a port-management script, so do not run it against another contributor's live runtime. Desktop development and staging are described in [its README](../../packages/desktop/README.md).

Use an isolated data root and a separate profile. Do not copy credentials into fixtures or let migrations run against the owner's database. Starting a service, installing dependencies or replacing an application may require explicit local approval.

A provider API key is not universally mandatory: supported subscription connections and local models are separate options. Provider setup depends on the workflow being tested. Distinguish fixture output from real provider acceptance.
