# GitHub security alerts — completed 14 November 2026

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
- Direct commands resolve executable names through a fixed allowlist and explicitly use literal argv on Windows. Version probes use program-specific flags: `node version` and similar script/modifying invocations now require approval. Direct argv and owner-approved shell execution have separate entry points and tool dispatch paths; the existing approval ticket flow is preserved.
- Project folder selection uses the same `checkFolder` validation as project persistence: absolute paths only, existing directories, no whole disk/home. Native canonical paths also fix duplicate project creation for Windows short/long path spellings. Owner authentication and explicit confirmation remain required.
- Google installed-client import opens once, checks the descriptor and current pathname before reading, and rejects links, replaced files and oversized data. Nonblocking open prevents FIFOs hanging the importer on POSIX.

## Local validation

Windows, Node 24.2.0:

- Backend `run-command`, `agent-command-route`, and `device-project-folder`: 12 passed, 1 POSIX-only timeout test skipped.
- Desktop `google-client-config`: 9 passed.
- Dependency graph projection: 3 passed.
- Backend `tsc --noEmit -p .`: passed.
- Locked dependency audits for backend, core-ui and desktop: zero reported vulnerabilities.
- `git diff --check`: passed.

The command-route regression test now uses portable ESM imports and Node commands, with an explicit isolated data root instead of changing the process working directory. No production database or account was used.

## Delivery status

Pull request: [#215 — Fix GitHub security alerts in dependencies and local execution](https://github.com/Dpro-at/Girru/pull/215).

During this work, PR #213 reached main (`643bec79`) with the same `@hono/node-server` 2.1.8 update from commit `9010d05b`, closing Dependabot #192–193 independently. Main was merged into this branch without conflicts. The remaining dependency change in this PR is `hono` 4.13.18; preserve the memory work already on main.

All checks on PR head `8c55e84f` passed, including the full [Type-check and test suites workflow](https://github.com/Dpro-at/Girru/actions/runs/43515429554), Windows/macOS portability, and [Security Scanning](https://github.com/Dpro-at/Girru/actions/runs/43515431758). CodeQL reported zero findings.

Mohamed authorized merging after successful checks. PR #215 was merged on 14 November 2026 (Europe/Vienna), at commit `6d22682da71989513282d8653dc12cf8f2d7e28e`. Its tree is identical to the tested PR head.

Post-merge [Security Scanning on main](https://github.com/Dpro-at/Girru/actions/runs/43524075508) succeeded, including dependency audits, resolved dependency graph submission, secret detection and CodeQL. CodeQL analysis `2165176982` scanned merge commit `6d22682d` without errors or warnings.

Verified through GitHub on 14 November 2026, 00:08 CET:

| Security category | Open alerts |
| --- | ---: |
| Dependabot | 0 |
| Code scanning (all branches) | 0 |
| Secret scanning | 0 |

Dependabot #192–198 and CodeQL #632–635 are all `fixed`. The four CodeQL alerts were fixed at 23:08:01 UTC on 13 November (00:08:01 CET on 14 November). None was dismissed; no security workflow or rule was disabled. Historical dismissed findings are not new open alerts.

The automatic [post-merge general test rerun](https://github.com/Dpro-at/Girru/actions/runs/43524075485) was still running at this checkpoint. The full pre-merge test suite already passed on the identical source tree. This final handoff changes documentation only.

Security task complete. The phone/build agent can continue its existing tasks without repeating this investigation.
