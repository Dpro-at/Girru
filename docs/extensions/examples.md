# Extension examples and source of truth

- [Quickstart](quickstart.md): minimal object-based `register(api)` lifecycle.
- `packages/backend/src/plugins/extension-runner.ts`: enabled-state checks,
  module import and actual lifecycle behaviour.
- `packages/backend/src/plugins/sdk.ts`: exposed SDK and enforcement.
- `packages/backend/src/plugins/extension-route-access.ts`: route access boundary.
- `packages/backend/test/fixtures/legacy-apps/extensions/`: historical app fixtures
  for regression tests, not bundled or automatically enabled applications.

Some older templates use `entrypoint` or a default initializer function. The
current runner reads `main` and calls an object's `register(api)` method; those
contracts are not interchangeable. Check the loader and SDK before reusing a
historical example.

For distribution, read current package validation in the separate
[Store](../contributing/store-apps.md). Check dependencies, migration scope,
database mode, package integrity and granted capabilities. An example's presence
does not prove it is enabled, released or live-provider verified.
