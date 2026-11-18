# Core contributions

Core owns shared identity, agent execution, memory boundaries, tasks, grants, approvals and common UI/native contracts. Prefer extensions for independent domain capabilities.

Read [architecture](../architecture/overview.md) and the [backend agent boundary](../../packages/backend/src/agent/README.md), then inspect the existing service/controller and its API, browser/native bridge and MCP consumers. Do not fix only one entry point when the contract is shared.

Agent orchestration lives under `packages/backend/src/agent/`: `public.ts` is the supported execution boundary, `context/` assembles authorized context, and `execution/` owns turn strategies. Reuse the existing `memory/`, `tools/` and repository services. Clients submit intent and render results; client-side previews cannot decide grants or route execution independently.

Keep migrations forward-compatible, preserve owner scoping and bound filesystem/network/native operations. Use separate fixture data and a separate desktop profile. Never silently activate a feature on the owner's real data.

For desktop changes verify trusted IPC origins/frames, packaging resources and platform-specific behaviour. For UI changes cover empty/loading/error/reconnect states and keyboard/RTL layouts. Describe what was actually tested, and what still needs provider, device or platform acceptance.

See [testing](testing.md) and the [shared workflow](agent-workflow.md).
