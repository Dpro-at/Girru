# Add or improve a personality

A personality describes how an agent works. It is separate from the agent's specialty, model, avatar, voice and tool permissions.

Owners can manage profiles through the personality library. A new personal profile does not require a source patch. A bundled profile or behaviour change belongs in Girru.

## Source map

- `packages/backend/src/services/personality-library.ts`: library revisions, linked-agent impact and preserving local overrides/locks.
- `packages/backend/src/services/personality.ts`: trait rules and validation.
- `packages/backend/src/services/personality-store.ts`: stored versions.
- `packages/backend/src/api/routes/personality-library.ts`: API boundary.
- `packages/core-ui/src/AgentPersonalityLibrary.tsx`: workspace UI.

Document supported trait ranges and defaults from the actual validator. Use revision-bound previews for changes to linked agents; preserve locks and local overrides. A trait such as independence cannot expand grants or bypass approvals.

Check personality, personality-library and proposal tests. Test owner access, stale revision, preview/save impact, locked traits and rollback/history as applicable. See [personality reference](../AGENT_PERSONALITY.md).
