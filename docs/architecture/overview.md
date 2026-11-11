# Architecture and contribution boundaries

| Area | Source | Responsibility |
|---|---|---|
| Current workspace UI | `packages/core-ui/` | React/TypeScript interface and browser/native contracts |
| Desktop host | `packages/desktop/` | Electron windows, trusted IPC, native capabilities and packaging |
| Backend | `packages/backend/` | Fastify, identity, execution, memory, tasks, grants and persistence |
| Command line | `packages/cli/` | CLI client |
| MCP server | `packages/mcp-server/` | External client access under its supported authentication boundary |
| Legacy web application | `src/` | Retained Next.js surface; not the default template for a new desktop screen |
| Extensions | `packages/backend/extensions/` | Executable capabilities via the existing SDK |
| Skills and professional content | `packages/backend/skills/` | Written workflows and versioned specialty mappings |

## Agent execution boundary

The [backend agent domain](../../packages/backend/src/agent/README.md) owns
identity, authorized context, provider routing and execution. Its supported
boundary is `packages/backend/src/agent/public.ts`; chat and durable task turns
retain distinct lifecycle strategies under `agent/execution/`. Memory storage,
embeddings and recall remain in `memory/`; tool grants remain enforced by the
backend tool and policy services.

HTTP, CLI, MCP and native adapters authenticate and submit supported commands.
Core UI renders events/results and submits user intent; picker previews and
optimistic state are not authority. Reuse backend contracts instead of adding
another provider loop or permission decision in a client. Existing compatibility
exports and legacy scaffolds are not alternative live execution engines.

See the [storage map](storage-map.md) for persistence ownership and the
[design reference](../../DESIGN.md) for the active workspace surface.

## Extension first

Implement new independent integrations, domain services and tools through supported extension points. A missing shared extension contract can justify a small reviewed core change. Do not copy an entire feature into core solely to avoid the extension lifecycle.

Core owns identity, grant enforcement, memory boundaries, task execution and native trust. An extension or model response cannot redefine those boundaries. Native capabilities require host implementation; a Store manifest cannot provide them by declaration alone.

A skill is guidance; a specialty is a job definition; a personality is a working style; an extension/tool supplies execution. Installation, assignment, tool grants and execution approval are distinct operations.

See [related repositories](../ecosystem/repositories.md), [extensions](../extensions/overview.md) and [contribution paths](../contributing/README.md).
