# Extension manifest

Use `agentplayer.plugin.json`; the current runner also recognises the legacy `agent-player.plugin.json` filename. Use the `PluginManifest` interface in `packages/backend/src/plugins/types.ts` for the runner manifest. The `main` path names the actual JavaScript entry, which can be `index.js` or a supported nested path.

Stable ID, name, version, type, entry point and declared permissions must match the implementation and distribution metadata. The same file also contains older class-based plugin interfaces; use the runner's object lifecycle rather than combining the two. Inspect SDK enforcement and the Store installer for accepted fields; a declared permission is not sufficient by itself to authorise an operation.

Store item `manifest.json` and package `agentplayer.plugin.json` are separate contracts. Preserve matching IDs/versions and generated integrity metadata. Use the [Store guide](../contributing/store-apps.md) for downloadable package limits.
