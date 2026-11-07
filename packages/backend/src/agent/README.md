# Backend agent core

The backend owns agent identity, context assembly, model/provider routing,
inference, tool execution, permissions, approvals and run lifecycle. UI and
terminal clients submit intent and render results. Client state grants no rights.

## Public boundary and lifecycle

`public.ts` exports the supported execution API and its types. Importing it does
not start a runtime, connect a store or open a profile. Entry adapters authenticate,
validate and admit commands; execution strategies retain sensitive-boundary checks.

`AgentExecutionCommand` distinguishes two strategies:

- `chat`: an admitted `ChatTurnInput` and structural `AgentReply` response port.
  `execution/chat-turn.ts` resolves identity, policy, authorized context and
  provider and performs the turn. The HTTP adapter retains authentication,
  idempotency, rate limits and checked response projection.
- `durable`: an existing task-run ID and optional worker identity.
  `execution/task-turn.ts` retains persisted leases, step receipts, replay,
  unknown non-idempotent outcomes, approvals, verification and cost gates.

`execution/local-turn.ts` dispatches typed local options to the Ollama or
LM Studio/OpenAI-compatible adapter. `execution/tool-step.ts` shares result
normalization, bounded scheduling and duplicate suppression. Cloud and coding-app
subscription protocols remain separate strategies in `cloud-turn.ts` and
`subscription-turn.ts`, including their cancellation, correlation and approval/
choice exits. The legacy one-piece provider path is an explicit compatibility
strategy within backend orchestration. Unifying authority does not make distinct
provider protocols or durable/transient lifecycles interchangeable.

`contracts/execution.ts` describes provider progress and results.
`contracts/events.ts` owns persisted checked run-event types. The server journal
sequence wins over frame fields on transport projection. Existing client
allowlists, byte limits, reconnect/deduplication and privacy checking remain;
a progress event is neither a permission grant nor a durable execution receipt.
Old service/route imports remain compatibility exports of the same implementation.

## Context and domain services

`context/resolve.ts` resolves personality, hired instructions, owner rules,
assigned guides and authorized memory; policy narrows data by entry point and
renderers format it. Existing feature switches, task scope, outsider restrictions,
cloud/local filtering and legacy fallbacks are preserved. Prompt modules,
project-memory loading and installed-tool context also live in `context/`.

Memory storage, embeddings, hybrid retrieval, cache invalidation and drawer
policies stay in `memory/`. Skills stay in `skills/`; grants and execution-time
checks stay in `tools/`. These domains are reused, not reimplemented in the core.
The old `AgentRuntime` has a mock `callLLM`: its analysis/prompt scaffold is not
the live inference or permission engine.

## User-intent contracts

**Agent target.** `context/target.ts` reuses the saved-group mention matcher:
textual group order, longest overlapping name and duplicate-name ambiguity.
Optional conversation-create `targetMessage` is owner-resolved before creation;
its longest known mention takes precedence over the explicit picker. Non-owner
or channel text cannot use this to select another agent. Direct owner chat uses
the same matcher for its single-writer strategy; saved group chat retains its
multi-participant lifecycle and meeting gates. Trusted internal `targetResolved`
preserves a dispatcher-selected participant and is never forwarded from public
request bodies. A missing explicitly selected agent refuses before inference.
The UI's remaining name matching is picker preview, not authority.

**Model selection.** `services/model-catalogue.ts` supplies existing enumeration
to both display and selection. New profile/primary-source saves send
`modelSelection: "catalogue-id"` plus `expectedVersion`, without `model/provider`.
After actor and version checks, the backend resolves one available, supported,
compatible descriptor or returns400 `invalid_model`. Conflicting legacy fields
are refused. Legacy authorized `model/provider` updates retain their prior
compatibility behavior and runtime policy; this is not a new universal ban on
saving offline legacy configurations. Card/primary-source clients do not infer a
provider from a model name. Thinking controls use catalogue capability metadata,
including advertised binding prefixes for resumed coding-app sessions; an absent
descriptor never implies support. Auto and agent-default choices remain server-resolved.

**Memory access display.** The optimistic rule grid is presentation only. Backend
`projectRuleCell` reuses runtime ordering/expiry/mask primitives; parity tests
compare the actual UI controller, parsed draft simulation and `effectiveMask`
over100 synthetic policies. Own grants, templates and delegation still cap
execution. Effective-access lookup and preview hash/version checks stay backend
owned; a displayed allow cannot authorize a read or write.

**Queued turns.** Queues remain window-triggered intents, not an unattended server
scheduler. Stop pauses continuation; reopening keeps waiting items for Send now.
Optional `queuedKey` on a saved-chat run must equal `runId`. Every window/retry
reuses the item key. Clients await save and submit backend-canonical queued text,
including scoped secret references, rather than vaulting stale raw text again.

Exact key/text consumption shares the journal/user-message transaction. Changed
or cancelled items return409 `queued_turn_changed` before inference. Serialized
queue saves filter committed receipts so stale lists cannot resurrect work;
concurrent draft edits otherwise retain last-writer semantics. Deterministic
meeting attendance consumes in its existing receipt transaction too. A refused
new group admission, including a temporary capacity refusal, discards only an
active, unadmitted routing reservation so its stable key can be retried;
stopped reservations remain paused. Uncertain/failed sends keep queue identity
and pause instead of promoting work to a new draft/run identity.

## Terminal and native app adapters

Installed `agent-player chat` and legacy backend `agent chat` use authenticated
`/api/chat`. The legacy command requires an existing backend and a valid session
in `AGENT_PLAYER_TOKEN`; `--url`/`AGENT_PLAYER_URL` accepts loopback HTTP only and
redirects are refused. Prefer the installed CLI's login for saved-session handling.
No chat command starts a server automatically. Model flags are backend-validated
intent. The legacy command retains interactive history and unique session IDs.

Both independently packaged terminal adapters project JSON or completed backend
SSE into answer text, ignore tool/reasoning frames and reject partial/error
streams. Shared wire fixtures test both small decoders; they contain no inference
or authorization engine. Presentation differs from the UI; authority does not.

The optional Code editor uses a separate native Node server/extension-host
backend, not the React agent engine. Its runtime wrapper binds loopback/token/data
paths; Electron owns native view/OS custody and a narrow origin/sender-checked
bridge. Native review forwards a one-shot decision into the existing approval/
verification flow, never a tool grant. Source wrapper/bridge and mocked lifecycle
acceptance do not prove every third-party extension or a packaged application was
audited, nor move that optional app's backend into the primary agent runtime.

## Validation scope

Relevant suites cover architecture imports, context/policy parity, target and
model intent, queue races/rollback/recovery, provider protocols, permissions,
channel isolation, approval proofs, paid-call gates and UI projection/session
cleanup. Run only with synthetic HOME/cwd/data and stubbed providers.

`core-queue-transaction.test.mjs` uses SQLite by default. PostgreSQL mode requires
`AGENT_PLAYER_PG_TEST_URL` and explicit `CORE_QUEUE_PG_DISPOSABLE=1`; use only a new
socket-only fixture cluster and stop/remove it afterward. Never use an application
profile/database. Local source/synthetic verification is distinct from real
provider, OS/Electron, compiled payload, merged and released acceptance.
