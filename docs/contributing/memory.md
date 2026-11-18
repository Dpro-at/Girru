# Memory and learned experience

Shared memory retains explicit ownership and read/write boundaries. It is not a global pool readable by every agent, and learned guidance does not retrain a model or grant tools.

Start with `packages/backend/src/memory/`, `packages/backend/src/tools/memory/recall.ts` and the affected route/service. Imports live under `packages/backend/src/memory/import/`; use the existing preview, redaction, provenance and import controls rather than writing directly into active recall.

Document source scope, ownership, import receipts, revocation, deduplication, local overrides and retention/forget behaviour as applicable. Preserve explicit exclusions and the difference between discovered metadata and approved imported content. Do not scan a real device or enable automatic imports as part of a fixture test.

Test cross-owner refusal, excluded/secret inputs, interruption/resumption, forgetting and permission revocation. Relevant tests include `memory-learning.test.mjs`, `memory-forget.test.mjs`, `memory-path-safety.test.mjs` and `outsider-memory.test.mjs`. Describe whether verification used synthetic data or a real model; fixture learning outcomes do not establish general agent performance.
