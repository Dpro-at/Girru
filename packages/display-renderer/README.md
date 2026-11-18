# Shared display renderer

One versioned display contract and React registry for chat, saved report views and avatar cards. The frontend takes supplied data; it does not fetch models/providers, mutate backend data, create a schedule, verify OTPs or grant approvals. Display actions are disabled unless a trusted host explicitly supplies its permission-checked callback. Reports are read-only snapshots; their storage/scheduling/authoring product is separate.

`src/contract.ts` has no React, database or runtime dependency. Backend consumers use a generated JavaScript contract snapshot. The React registry includes all 61 catalog names, typed bounded JSON props, visible unknown/error states, local presentation state and host-bound action slots. Provider/avatar/support/media data requires an explicit host adapter; rendered fixtures are not live integrations. Motion/autoplay and external media loads are off by default.

The canonical source is this directory. `scripts/sync-display-renderer.cjs --sdk-root <explicit SDK repository>` produces a byte-identical SDK source snapshot and SHA256 provenance; `--check` refuses drift. Do not edit the generated snapshot. It is source preparation, not an SDK/application build or release. The SDK card adapter uses that same renderer and supplies no action authority.

Legacy full specs and bounded JSON Patch streams normalize to schemaVersion 1. No executable imports, scripts, arbitrary HTML or backend operation names can be obtained from a spec. Host callbacks must recheck their own identity, scope, permissions and approvals. Keep source-read authorization and report ownership outside the renderer.
