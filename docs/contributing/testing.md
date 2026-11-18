# Validate a contribution

Use the package's lockfile, compatible Node version and existing test harness. Start with affected contract/security tests; broaden to the required package/CI checks. Do not start services or run tests against personal accounts/data without local authorisation.

| Area | Checks |
|---|---|
| Core UI | `npm --prefix packages/core-ui run typecheck`; affected tests, then package suite/build when required |
| Backend | Type/build check and affected tests under `packages/backend/test/` |
| Desktop | `npm --prefix packages/desktop test`; native/platform acceptance for affected capabilities |
| MCP | Package scripts and contract/auth tests in `packages/mcp-server/` |
| Skills/specialties | Parser, portable pack, source history and update/import fixtures |
| Store | Its build-index check and package/integrity tests |
| Documentation | Relative links, referenced paths, command accuracy, generated examples and diff whitespace |

Backend ESM tests commonly use the repository harness, for example from `packages/backend`:

```sh
node --import tsx --import ../../scripts/test-temp-root.mjs --test test/professional-pack.test.mjs
```

Check the selected test's imports first: some `.cjs` tests need only Node, while integration tests require compiled/native dependencies. A missing prerequisite is not a passing check.

Record exact scope, failures/skips and remaining limits. Fixtures do not prove real-provider, native permission, hardware or production-load acceptance. Documentation-only changes do not require an unrelated application suite, but their links and executable examples must be checked.
