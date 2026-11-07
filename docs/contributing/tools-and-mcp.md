# Tools and MCP

A tool provides executable capability. A skill may explain when to use it, but cannot authorise it.

Start with an extension for a domain-specific tool. Change core tool infrastructure only for shared behaviour. Inspect `packages/backend/src/tools/`, `packages/backend/src/mcp-client/` and the existing [MCP server](../../packages/mcp-server/README.md).

Document input/output schema, identity derivation, grants, approval behaviour, external effects, cancellation and retry semantics. Never accept a caller-supplied owner or agent ID as sufficient authority. Do not expose arbitrary execution, credentials or files through a convenience wrapper.

Test unauthorised and cross-owner refusal, revoked grants, stale approvals, bounded output and uncertain side effects where applicable. A catalogue listing or skill assignment must not auto-enable a remote server or all its tools.
