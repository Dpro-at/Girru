# GitHub security alerts — 13 November 2026

Owner: Codex, assigned by Mohamed in the security chat. Codex handles the fixes and checks; the phone/build agent continues the phone handoff and does not need to duplicate this work.

Repository: `Dpro-at/Girru`. Base: `6b6dbf57b158c9db7419c73f7ca4c09638ad9316`. Branch: `codex/fix-github-security-alerts`.

## Verified starting point

- Dependabot #194–198: `hono`, patched in 4.13.16.
- Dependabot #192–193: `@hono/node-server`, patched in 2.1.6.
- CodeQL #633–634: command execution in `packages/backend/src/tools/core/run-command.ts`.
- CodeQL #632: project folder selection in `packages/backend/src/api/routes/device-coop.ts`.
- CodeQL #635: installed Google client file import in `packages/desktop/src/google-client-config.cjs`.
- No open secret-scanning alerts returned by GitHub.

## Implemented fixes

- Updated the backend lockfile to `hono` 4.13.18 and `@hono/node-server` 2.1.8. Both exceed the advisory patch floors without changing the MCP SDK contract.
- Direct commands resolve executable names through a fixed allowlist and explicitly use literal argv on Windows. Owner-approved shell execution remains a separate branch; the existing approval ticket flow is preserved.
- Project folder selection uses the same `checkFolder` validation as project persistence: absolute paths only, existing directories, no whole disk/home. Native canonical paths also fix duplicate project creation for Windows short/long path spellings. Owner authentication and explicit confirmation remain required.
- Google installed-client import opens once, checks the descriptor and current pathname before reading, and rejects links, replaced files and oversized data. Nonblocking open prevents FIFOs hanging the importer on POSIX.

## Local validation

Windows, Node 24.2.0:

- Backend `run-command`, `agent-command-route`, and `device-project-folder`: 11 passed, 1 POSIX-only timeout test skipped.
- Desktop `google-client-config`: 9 passed.
- Dependency graph projection: 3 passed.
- Backend `tsc --noEmit -p .`: passed.
- Locked dependency audits for backend, core-ui and desktop: zero reported vulnerabilities.
- `git diff --check`: passed.

The command-route regression test now uses portable ESM imports and Node commands, with an explicit isolated data root instead of changing the process working directory. No production database or account was used.

## Delivery status

Prepared for a pull request and GitHub CodeQL verification. Alerts remain open on the default branch until corrected source is merged and GitHub confirms the new analysis. No alert has been dismissed or scan disabled.
