# Core UI shell

Independent React + TypeScript + Vite source for six destinations: Chat, Agents,
Memory, Tasks, Settings and Agent Connect channels. Chat is the initial destination.
This package does not import the legacy application or any backend module.

Default startup is fictional and makes no network requests. An explicit offline
login exercise and injectable authenticated client are available, but main.tsx
configures no live transport unless the candidate-only build flag below is supplied. No browser storage, actual chat send, server memory
decision or permission mutation is enabled by default.
The persistent footer identifies the fixture and unknown capacity. The state
selector deliberately displays empty, simulated-error and stale examples.

Generate changes the name draft only. **Save local fixture** changes page memory;
Cancel restores the last saved fixture name. Reload resets everything. Local
validation shares the API display validator and Arabic-aware naming key. The agent
can reclaim its own retired names with Save. These fixtures do not enforce global uniqueness,
confusable detection, authorization or persistence. A three-name pool per locale
makes exhaustion testable. Generate randomly selects an eligible localized name,
excluding normalized saved, draft and retired names. The click handler samples
crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; the pure reducer accepts deterministic entropy in [0, 1) for tests.
Invalid entropy is a no-op; exhaustion changes only the notice. Suggestions are
not reservations and do not establish global or server uniqueness.

The shell uses system fonts, light/dark semantic tokens, logical CSS, visible focus,
a skip link, bidi-isolated identity, native modal command dialog and labelled
combobox/listbox. Command-K or Ctrl-K opens the palette; arrows select, Enter
navigates, Escape dismisses. Native dialog supplies modal focus containment;
closing returns focus and navigation focuses the destination heading. No actual
browser, screen-reader, focus-containment or responsive-rendering pass is claimed.
English, Arabic RTL and German catalogs are included; translations are drafts.
The other nine planned locales await a later localization slice.

## Commands

From this package with dependencies already available locally:

```sh
npm run typecheck
npm test
npm run build
```

Only when separately authorized, install from this package using the exact lockfile.
Package .npmrc enforces ignore-scripts=true and save-exact=true; use npm ci only:

```sh
npm ci --workspaces=false --ignore-scripts --no-audit --no-fund --engine-strict
```

Node must satisfy `^20.19.0 || >=22.12.0`. Standard commands use package-local
modules; the historical CORE_UI_MODULES override is no longer used. Tests transpile
in process and use React server rendering and pure state/keyboard logic, without a
browser DOM. Build runs strict TypeScript, Vite and copies third-party notices into a new
versioned output. No output directory is cleared.
Environment-file loading and public-directory copying are disabled; PostCSS is
explicitly package-local with no plugins or ancestor configuration inheritance.

Exact selected metadata, tarball integrity, installed versions and upstream sources
are in [dependency-provenance.json](dependency-provenance.json). Full installed
license texts are preserved in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt),
also copied into each current output; Vite emits bundled-code licenses in that
output's .vite/license.md (not exposed by preview).
The lockfile includes optional binaries for other platforms; only this host's
applicable packages were installed. A zero-finding dependency audit is a snapshot,
not a security or browser acceptance claim.

Development server configuration reserves loopback `127.0.0.1:42522` with a strict
port. Starting a server requires separate authorization. No proxy or backend port
is configured. The direct assignment reserves 42522 as frontend; historical reversed port notes
do not override it. No live bridge is configured. Do not use Vite dev/preview as
the production static preview. Use only the commands below after review.

## Icons and integration gate

Eight genuine Tabler Icons v3.34.1 outline SVGs are bundled in `assets/tabler/`.
`src/icons.tsx` retains their child geometry, 24-unit viewBox and 2-unit strokes,
with decorative accessibility attributes. Exact MIT terms and copyright notice:
[LICENSE](assets/tabler/LICENSE). Pinned upstream revision, source URLs and SHA-256
hashes: [provenance.json](assets/tabler/provenance.json). No runtime icon downloads.
Fonts are local fallback preferences; no font files or remote stylesheets.

Before live integration: review the current security baseline, auth/revocation,
provider masking, stream IDs/errors/idempotency/resume, CORE naming/memory/task
contracts, revision-bound approvals and Agent Connect scopes. Confirm same-origin
hosting, deep-link handling and secure rollback. No UI control can supply server
authority. No product apps are included. Visual acceptance is a separate gate.

## Offline naming contract module

`src/naming.ts` exports an injectable suggestion adapter and draft controller,
verified against backend CORE-02 revision `970b4a7f36181cc2ab8430987970bbd173feb556`.
It sends `POST /api/agents/name-suggestion` with `{language, exclude: [draft]}`
through a caller-supplied transport. The optional authenticated workspace now
wires it through SessionClient; the default fixture remains independent. The
client supplies auth, origin policy and decoded responses without automatic retries.
The controller conservatively requires owner access; this is a UI restriction,
not server authorization. Context changes, manual edits, Cancel and disposal
invalidate pending results. Await `generate()` then read `snapshot()`; call
`setContext()` on agent, language or authorization changes and `dispose()` on teardown.

The API supports 12 language codes (Chinese is `zh`), display names of 1–60
Unicode code points after NFKC/whitespace normalization, Arabic-aware uniqueness
keys and numbered suggestions when `exhausted` is true. A suggestion never
reserves a name. Only the backend can decide availability at Save time.
The App shares validatedDisplayName/namingKey, including 60-code-point Unicode
validation and Arabic folding. Its three-name Generate pool avoids previous
names for variety, but explicit Save allows reclaiming this agent's own retired
name. The backend alone rejects another agent's current or retired name.
The owner-only controller is an explicit UI choice; API owner/admin access and
valid admin 200 responses are not errors. ZWNJ/ZWJ are rejected by both validators;
Persian/Hindi language review remains outstanding.

Rename Save is intentionally absent from this module and remains fixture-only.
BE-UI-01 now supplies version/ETag and expectedVersion/If-Match CAS. The future
bridge must send only name plus precondition, reconcile version_conflict and
unknown outcomes, and never automatically retry. Q-20(b) remains a UI policy
choice; no API owner-only enforcement is claimed.
The naming tests use endpoint-shaped wire fixtures; they do not execute backend
routes or certify authorization, persistence, runtime or security integration.

## Memory review

Memory is an explicitly fictional, page-local review destination. Select an agent
and owner/project/experience/task/person drawer, open a full proposal, review all
before/after text and metadata, then explicitly confirm that version before a
local accept/reject. Closing the destination discards its fixture decisions.
The agent selector filters proposals; drawers belong to the owner, not the agent.

`src/memory.ts` provides an injectable typed memory adapter and controller. It uses
GET drawer text with `agentId`, GET owner-wide proposals with `?status=pending` (maximum 200, filtered
locally), and GET full proposal details. Responses are validated and all content
is rendered as escaped text. Context/session replacement invalidates pending
reads and decisions. Authentication/permission errors clear loaded data. The optional session client supplies authentication and synchronous epoch
invalidation through bindMemorySession; the adapter itself has no token storage
or automatic write retry.

The adapter defaults to read-only. Injecting an authenticated owner authorization
check enables reviewed decisions against backend revision
`8f26a292802800afb4d76be6403fe43d89f08139`. Both POST approve/reject send only
`{expectedReviewHash}` from the full detail rendered before confirmation. Approve
returns `{proposal, revision, applied}`; reject returns the proposal. No version
or hash is invented by the client. File/upload approvals compare the drawer hash;
learning/agent/import rely on the backend's per-changed-entry checks. Reject does
not require unchanged drawer contents. A revision change alone is not stale.

409 `already_decided`, `stale`, `review_changed` and 400 `review_hash_required`
clear consent and reconcile through GET; reopen the full detail to review again.
Network/500/malformed replies remain **unknown**, even if GET says approved.
GET cannot attribute execution to this request. No automatic retries; an uncertain
proposal is blocked from duplicate writes for the lifetime of the same injected
transport (including controller remounts and session changes). This in-memory
safety record is not durable across a full page reload or a new client instance.
Session/context changes abort pending work and ignore stale completions; they
cannot undo a write already received by a server. No real backend was exercised.
Memory proposals have no expiry field; the expired example is fixture-only.
Import/export/edit/forget/retention are not connected. EN/AR/DE remain draft
catalogs. `npm test` includes offline controller/contract/React SSR coverage;
these checks do not establish browser accessibility or backend enforcement.

## Current-only production preview

After parent review, from this package:

```sh
npm run build
npm run preview
```

Open http://127.0.0.1:42522 only after successful startup. The script accepts no
CLI host, port or root overrides, binds IPv4 loopback, and fails on an occupied
port without killing anything or selecting another port. Stop the owned process
with Ctrl-C. No persistent server is started by build or test.

Each build uses dist/build-<UUID>. dist/current.json is the exact current manifest
with status, build ID, file lengths and SHA-256 hashes. Starting a new build
immediately marks it building; failed builds disable preview (503), with previous
outputs retained. Only success publishes ready. Old dist contents are never
deleted, served or packaged. Preview revalidates the current manifest/bytes on
every response and never serves stale hashed assets after a rebuild.

Only index.html, current assets/*.js and *.css, and THIRD_PARTY_NOTICES.txt are
allowlisted. Symlinked artifact paths, integrity mismatches and invalid manifests
fail closed. No repo files, modules, cache, evidence, dotfiles, source maps,
directory listing, API proxy, or arbitrary HTML fallback. GET and HEAD only;
Host and Origin checks, production CSP and no-store headers apply. HTML fallback
is limited to /chat, /agents, /memory, /tasks, /settings and /channels with an
Accept: text/html request; missing assets/API paths return 404. No TLS or backend
is provided; this is a local fictional preview, not authenticated integration.

`npm run package:preview` exports only verified current assets and BUILD_MANIFEST.json
into a new .build-evidence/preview-package-* directory. Never archive the package
root or dist wholesale. npm source-pack allowlisting excludes all generated
outputs/cache/evidence/modules. No package export uploads or deletes anything.

HTTP tests use only new fictional fixtures under ignored .build-evidence and
ephemeral loopback ports; every owned server is closed. Test directories are
retained under the no-deletion constraint. No real app/backend/data requests.

## Authenticated client: offline verified, runtime integration pending

The default shell offers **Open offline login mock**. It unmounts the fixture
workspace and opens a clearly fictional login form. Use only the displayed
`demo@example.invalid` / `mock-only` credentials; other values are refused. Never
enter a real password in the mock. Login AND `/api/auth/me` must succeed. The mock
supports agent selection, draft generation, explicit CAS naming, all-device logout and exact memory decision response shapes.
Use agent `sample-main`, drawer `owner`, then explicitly load and review. The mock
uses fictional in-memory changes and SHA-256 review hashes; it is not a database,
embedding, audit or export-file implementation. Unknown scopes return 404.
Returning to fixture clears the local session and resets fixture data; it does
not claim remote revocation. Logout requires an explicit all-devices checkbox.
A lost/malformed reply reports local clearance and unknown server outcome, never
success or an automatic retry.

SessionClient starts in fixture mode even with supplied transports. Its request
method allows only auth/me, naming suggestion, agent list/detail GET and exact
`PUT {name, expectedVersion}`, memory GET shapes and the two review-hash-only
memory decisions. No arbitrary URL, headers or API key. Naming PUT and memory
POSTs require an authenticated owner (a conservative UI policy, not API enforcement). Tokens live in a
private field and transient request closures, never storage/logs/URLs. Epoch
changes abort requests and reject late results from transports ignoring abort.
401 clears the account and protected panes; 403 clears the failed scope without
logging out other scopes. bindMemorySession subscribes synchronously so memory
invalidates before React unmounts. An idle session discovers remote revocation on
its next authenticated request; no polling or server-push detection is claimed.

A future reviewed entry point may explicitly inject this client (NOT active in
main.tsx):

```tsx
import { SessionClient, createSameOriginTransport } from './session';
const client = new SessionClient({
  live: createSameOriginTransport(window.location.origin, window.fetch.bind(window)),
});
// Render <App client={client}/>; then explicitly choose Use live sign-in.
```

Only `http://127.0.0.1:42522` is accepted. Fetch is same-origin, rejects redirects,
omits cookies, disables cache and suppresses referrer. Injection is trusted
application/test code, never user code. No URL/query/storage/environment switch
activates live mode, and failed live auth never falls back to mock.

Static preview refuses API requests. The explicit isolated bridge below maps only allowlisted routes to the exact isolated
backend `http://127.0.0.1:42521`, enforce exact frontend Host/Origin, preserve
Bearer and validated Origin, reject upstream redirects, redact secrets and keep
CSP. Backend ALLOWED_ORIGINS must explicitly include the frontend origin; never
drop Origin to bypass CSRF or use wildcard CORS. Real runtime and owner credential
preparation remain separate gates.

The pending-only queue remains capped at 200 owner proposals; scoped filtering
may still yield an incomplete list. Full detail is required for decisions.
The pinned backend fix is inspected read-only, not merged or run. Actual live
routing, security review and deployment remain separate from offline validation.
Auth and contract-decision copy is English draft; fixture EN/AR/DE catalogs remain.

### Preserve an occupied preview

```sh
npm run typecheck
npm test
npm run build:candidate
```

Candidate builds create a new dist/build-UUID and dist/candidate.json, preserving
**dist/current.json and the running preview**. No output files are deleted.
Tests cover pending/ready/failed candidate isolation. Verify candidate bytes with
readCurrent(packageRoot, 'candidate'). Parent must intentionally select a reviewed
build before opening it; ordinary npm run build switches the current pointer and
must not run during an unchanged preview reservation. Do not kill or reuse an
occupied port. Build starts no server. Tests use injected mocks and fictional
loopback port-0 servers; these prove frontend wiring, not backend enforcement,
browser accessibility, runtime integration or production readiness.

### Isolated application bridge (explicit deployment only)

`node scripts/application-server.cjs --enable-isolated-api --candidate` serves a validated,
pinned candidate on `127.0.0.1:42522`; use `--current` only for an explicitly selected
current build. The destination is fixed at `127.0.0.1:42521`. No environment, URL,
query, host or port overrides are accepted by the executable. Occupied ports fail;
no process is killed and no fallback port is used. The fixture preview command
and current pointer remain independent. This command must not replace a running
preview without an intentional deployment decision.

Only login/me/logout, existing memory reads/review-hash decisions, name draft
suggestions, agent list/detail GET plus exact CAS name PUT, and POST /api/chat streaming are proxied. Non-stream JSON is bounded (128 KiB request, 4 MiB response), with a
10-second total deadline. Chat uses the narrower streaming/error bounds below. No retries, redirect following, cookies, forwarding
headers, error-text relay or credential/body logging. Static assets retain the
preview CSP and are pinned after manifest/hash validation. All state-changing
requests require the exact frontend Origin, preserved upstream; backend Host is
replaced with the fixed loopback destination. The isolated backend must explicitly
allow `ALLOWED_ORIGINS=http://127.0.0.1:42522` and include memory concurrency/review
binding fix `8f26a292802800afb4d76be6403fe43d89f08139`. Runtime readiness and owner
credentials are separate prerequisites, not established by mocked tests.

The entry remains fixture-only. This server does **not** silently enable live UI.
After parent review, an explicit entry may inject
`new SessionClient({live: createSameOriginTransport(window.location.origin,
window.fetch.bind(window))})` into `<App client={client}/>`; the existing explicit
live sign-in action remains required. Do not use global tokens, query/storage mode
toggles or real credentials in the offline mock. The HTTP integration tests prove
this wiring with ephemeral mock ports only; no real backend is exercised. Setup, admin operations, imports and generic API forwarding are not exposed.

### Agents selection and CAS Save

The authenticated workspace renders `AgentsDestination` through the same injected
SessionClient used by Memory. The default fixture entry and current preview remain
unchanged. After explicit mock/live sign-in: Read agents → select → type or Generate
draft → Save name. GET responses are projected to `{id,name,version}` at both client
and bridge, including conflict bodies. No complete agent object, system prompt,
API key placeholder, credential reference or arbitrary property is retained.

Contract pin: backend `8f26a292802800afb4d76be6403fe43d89f08139`. Writes contain
exactly the normalized `name` and positive safe-integer `expectedVersion`; no
If-Match/header escape hatch. IDs are stable canonical ASCII IDs (1–128 characters;
no traversal, encoding, separators or reserved suggestion-route name). Broader
legacy IDs/names fail closed, not silently normalized or redirected. Names use
the shared 1–60-code-point validator and Arabic uniqueness key; own retired names
are reclaimable. Suggestion excludes the current draft and reserves nothing.

A version conflict shows the latest acknowledged name/version, preserves the draft
and requires explicit review before another Save. Name-taken/invalid-version
refusals require a fresh explicit GET and review. A transport error, malformed 200,
unexpected response or server error is an unknown outcome: Save/Generate/Cancel
are blocked until explicit reconciliation. GET matching the attempted name does
not prove this operation committed; a different name does not prove failure. Fresh
state permits manual review and a new deliberate CAS Save, never automatic retry.
Cancel only cancels an unsent draft; it cannot undo a submitted write.

Pending-outcome records are memory-only, keyed by client, mode, account and agent;
they survive agent switches, destination remounts and same-client relogin. They
are not durable across reload or replacement of the client. Session changes clear
visible private state synchronously; late responses cannot restore it. A pending
server write can still commit after local abort/sign-out. There is no operation ID,
reservation-list endpoint or historical proof in GET.

Offline tests exercise complete controller flows, React SSR and ephemeral fictional
HTTP bridge flows, not browser interaction or the real backend. The UI copy is
English draft. Q-20 owner/admin policy and production security review remain open.
Chat SSE is described below; isolated full-browser integration remains separate. Live password
fields now support origin-bound password managers; mock fields keep autocomplete
off. Protected 429/421 show session notices without signing out or retrying. First-run
setup discovery remains a separate auth follow-up. The later read-only lineage pin
`2ce507d5cc89e6dd4f5016a56537b613992094fb` adds auth refusal codes (agent naming
contract unchanged). Client and bridge allowlist status-bound `published_password`,
`account_inactive`, `rate_limited`, `origin_not_allowed` and
`host_not_allowed`, with distinct local copy, never backend error/message text.
Older backends without codes retain generic notices.


### Current-session chat streaming

The authenticated workspace includes Chat through the existing injected
SessionClient. The default fixture still makes no network requests. To exercise
fictional streaming after intentionally selecting this candidate, choose **Open
offline login mock**, enter the displayed fictional pair, then enter a message
and press **Send**. No real credentials or model calls belong in that exercise.

Chat sends only POST /api/chat, with Bearer auth and one cryptographic
Idempotency-Key per explicit new send. The exact body contains `stream:true`,
`sessionId`, alternating text-only `messages`, and optional `agentId`. Blank
agent ID leaves primary/fallback resolution to the backend; a supplied ID is
not proof of an existing agent or a permission grant. Selection freezes after
first send. No model, system prompt, user ID, memoryScope, tools or permission
parameters can be supplied through this interface. A new UI conversation ID is
created for this sign-in workspace. Prior server history is not fetched; the
current conversation is kept in memory only, with no silent truncation.

The shared dependency-free protocol module handles incremental UTF-8, LF/CRLF/CR,
comments, multi-line data, chunk boundaries and unknown event kinds. It retains
runId/messageId, text and terminal/replay/incomplete/truncated flags. Tool events
show only an activity count, not inputs or outputs. Unknown event kinds cannot
render content or complete a turn. Typed errors use fixed local copy. Legacy
`content` plus `done:true` stays text, including textual backend errors; it is
not relabeled as a typed success/error. All content is React text, with no HTML,
Markdown renderer, URL following, tool execution or eval.

Limits: 64 messages, 32,768 UTF-16 units per request message, 128 KiB serialized
request; 1 MiB stream bytes, 64 KiB per frame, 4,096 data frames, 262,144 output
characters per turn. JSON chat errors are capped at 16 KiB. Bridge request-body intake has a 10-second deadline. Chat upstream header wait
and streaming share one 120-second absolute deadline, with 30 seconds idle
after headers. No-frame upstream chunks emit only fixed `: keepalive\n\n`
comments, at most once per three seconds. Raw upstream comments/metadata never
leave the bridge. Heartbeats share stream backpressure and the 1 MiB downstream
byte cap; they cannot extend the absolute deadline. The client also bounds the full chat operation at 120 seconds
and 30 seconds idle. Oversize/malformed/incomplete streams fail closed with an
unknown outcome, retaining only already received unconfirmed text. Cancelling
clears messages; logout/epoch/mode changes synchronously clear protected state
and cancel the reader. Disconnect closes upstream; this is not proof that backend
execution or tool side effects stopped.

There is no resend button or automatic retry. At backend source pin
`bbcdec18bbd948b05b066375fba17e3caab707fc`, completed key entries expire ten
minutes from creation; running entries have a separate fifteen-minute stale
guard. The ledger has a 2,000-entry global cap and a four-running-keyed-turn
cap per authenticated user (429 `rate_limited`, upstream `Retry-After: 30`).
Only finished entries are evicted for capacity. A disconnect before response
end drops the key immediately: an explicit same-key request can start a NEW
run with new run/message IDs. State is lost on restart; it offers no observable
durable recovery guarantee. Therefore even a
same-key retry cannot safely be enabled here. Unknown outcome locks further
sends in this conversation. Explicit 409 in-progress and 422 reused-key codes
are preserved; raw errors/headers are not. Run/message IDs also survive untyped
JSON errors when valid. Upstream **421 maps to bridge 502 for every non-GET**, keeping
`host_not_allowed`, to prevent Fetch's automatic write replay. Tests assert
one upstream call for every allowed write route. GET retains 421.

CHAT-01 source trace at that pin: `packages/backend/src/services/chat-sse.ts`
flushes accepted SSE headers immediately and emits `: ping` every 12 seconds;
the bridge resets idle on incoming bytes and emits its fixed sanitized heartbeat.
`api/routes/agentic-chat.ts` and one-shot CLI answers in `api/routes/chat.ts`
use 4 KiB JSON-escaped content chunks. `services/chat-idempotency.ts` replays
16 KiB chunks with `truncated` only on the last text frame, followed by done
with `incomplete:true` when the original stream never completed. These are
content bounds, not total serialized frame sizes; streaming Ollama deltas are
forwarded individually rather than rechunked by this helper.

Typed failures terminate without a later done; the Ollama failure adds
`code:model_unavailable`, which this UI intentionally discards while retaining
the typed error and fixed safe copy. CLI failure catches still use legacy
text plus `done:true`; this is not a typed success verdict. Pre-stream refusals
remain JSON; non-stream Ollama 502 is outside this stream-only request surface.
The request fingerprint covers all defined request fields, including earlier
history and model/options, not just the last message. The UI forwards its
existing exact allowlist intact and exposes no additional options or recovery API.
Source review plus `tests/chat01-contract.test.cjs` verifies the existing
implementation unchanged; mock HTTP fixtures do not certify backend execution.

Reproducible offline trials (from this package, existing dependencies only):

```sh
node --test tests/chat.test.cjs tests/chat-http.test.cjs tests/chat01-contract.test.cjs
npm run typecheck
npm test
npm run build:candidate
```

The HTTP trial binds only ephemeral loopback ports and closes all owned servers;
it runs login → chat chunks → cancel/logout, with negative protocol, origin,
Host, schema, redirect, size, deadline, auth and idempotency tests. It substitutes
the fixed client origin only in test code, never in the executable. These are
mock transport tests, not real-backend security or browser acceptance. A later
reviewed live deployment must inject the existing same-origin client explicitly;
no entry change, persistent listener or current-pointer promotion occurs here.
Protected 403 `inactive_user` now clears the session (403 `forbidden` does not).
Setup discovery and memory response projection are documented below.

### Memory review response boundary

The bridge projects each memory route separately: drawer text/identity/revision/hash/count (never the server file path), proposal summaries plus `counts`, full proposal changes, and approve `{proposal, revision, applied}` or reject proposal. Unknown metadata outside hashed changes is omitted. Unknown or missing keys inside a change or entry fail closed (HTTP 502); the client independently rejects those key sets before creating consent. Content is preserved as text. Notes and reasons are labelled context, outside the change review hash.

Memory size limits are deliberately independent: upstream JSON is limited to **4,194,304 UTF-8 bytes**, including every field, JSON punctuation and escape sequence; drawer content is limited to **2,000,000 UTF-16 code units**, and each entry to **50,000 UTF-16 code units** (JavaScript string length, matching the backend entry bound). Emoji generally uses two code units, Arabic generally two UTF-8 bytes, CJK generally three bytes; control-character JSON escaping can use six bytes. Passing a text limit does not guarantee the whole response fits the byte limit. Oversize, malformed UTF-8 or invalid schema gives 502, without truncating reviewed content. The remaining bounds stay 200 list items, 500 changes/reasons, request body 131,072 bytes and 10-second absolute non-chat bridge deadline. This is a bounded review UI, not a guarantee to display every backend export or proposal.

A trusted `SessionFailure('blocked')` means no wire dispatch and clears only that attempt's uncertainty; a received memory-decision 401/403 settles that attempt even when session invalidation has already cleared the view. A late refusal cannot sign out a newer login or restore old content. A dispatched request with no definitive answer (including cancellation, timeout, malformed success or 5xx) remains blocked against duplicate decisions, including remounts on the same transport. Read-only reconciliation cannot establish execution. The ledger is in memory and is not durable across reloads or transport replacement. Device-token changes and live deployment validation remain separate work.


### Explicit setup discovery

Fixture remains the default. Selecting the offline mock or an explicitly injected live client sends no request: **Check setup status** performs one unauthenticated `GET /api/setup/status`. No mount effect, polling, automatic retry or live fallback is installed. The static preview and entry point remain unchanged. The default offline mock reports an existing owner; `createLoginMock(undefined, 'first-run' | 'error')` supplies the other fictional scenarios without network access.

At backend revision `d90f1a8f12e5048570f5368160275d9e6dbb00b5`, HTTP 200 must contain exactly `{setupComplete, setupRequired, message}`. The booleans must be complementary and the message must be the corresponding fixed literal `Setup already completed` or `Setup required`. The shared browser/bridge validator rejects unknown/missing fields, wrong types, inconsistent booleans/messages and every non-200 response. Successful output is reconstructed; backend text/codes are never displayed. Invalid upstream status/schema produces bridge 502 and a local unavailable notice. Existing redirect/header/size/deadline boundaries still apply.

The login form appears only after explicit discovery reports completion. Incomplete discovery shows CLI guidance with no bootstrap action; unavailable discovery withholds the form and offers an explicit recheck. Checking can be cancelled. Setup completion only reflects the flag file OR a non-system owner/admin account; it says nothing about an account being active, password validity, installation identity, provider readiness or authenticated access. The backend catches an owner-query failure as false when no flag exists, so a required result cannot distinguish a fresh installation from that database failure. No stronger claim is made here.

Discovery never sets user/token/authenticated state. The explicit low-level `login()` API remains separately usable without a discovery result, preserving existing authentication callers; it still requires login plus matching `/me`. Once discovery is checking/required/unavailable, that API also refuses to dispatch login until a successful explicit recheck or local reset. AuthBoundary always gates its form on discovery. Protected adapters cannot request setup status; only `discoverSetup()` sends the anonymous read. Epoch changes abort it, and late results cannot replace newer discovery or authentication. Authenticated/signing-in/signing-out states cannot start discovery. Logout clears the discovery result; its all-device confirmed/unknown notice survives a subsequent explicit check.

The bridge adds only exact GET `/api/setup/status`, no query, body or Authorization. Host must remain its exact loopback address/port; an Origin, when present, must match exactly, and cross-site/same-site fetch metadata stays refused. Absent Origin is permitted for GET under the existing policy; POST/PUT still require the exact Origin. Upstream Host is rewritten to the fixed loopback backend and cookies are discarded. Owner creation (INSTALLER-07) is the one setup write: exact POST `/api/setup/admin` with `{ name, email, password, setupToken }`, no Authorization, replies projected to fixed codes; the backend accepts it only from a loopback peer with the one-time setup code that `agent-player setup` / `start` shows on the installation computer's terminal (or in a local `#setup=` link, read once and removed from the address bar). The other setup steps, `/api/setup/check`, onboarding and instance routes remain outside the allowlist. No credential/device-token persistence is added.

Validation: `node --test tests/setup-discovery.test.cjs`, `npm run typecheck`, `npm test`, `npm run build:candidate`. Tests use fictional offline data, React SSR and owned ephemeral loopback HTTP listeners, never the actual backend. Candidate only; no current build promotion, rendered acceptance or live-security readiness claim.


### Login device-token contract

Source pin `d90f1a8f12e5048570f5368160275d9e6dbb00b5` supersedes the older
account-lockout contract: login 429 uses `rate_limited`. Obsolete `account_locked`
is not relayed or displayed; an unknown 429 still means try later. No retry is
scheduled, including when Retry-After is present.

Login alone may send `{email,password,deviceToken?}` and consumes success
`{user,token,deviceToken}`. Client and bridge require a 43-character base64url
returned device token. Malformed explicit input is rejected before forwarding;
the backend itself treats missing/invalid/expired device tokens as absent.
The backend input parser is more permissive than the emitted token shape.

SessionClient keeps one device-token slot in private memory, bound to the request
email after trim/lowercase (matching the throttle), its client instance and its
selected mode/transport. Credential input itself is not normalized. Changing email
or explicitly selecting a mode discards the slot; new clients/reloads start empty.
Logout, cancellation and authentication expiry clear the separate Bearer session;
they do not persist or promote the device credential. A validated login success
replaces the device slot before /me, since rotation already happened at the server.
/me must still confirm the user id before protected access. Stale epochs cannot
replace a newer token or restore identity. A late 200 after cancellation or another
epoch change retains only a validated advisory device token if the client, mode
and normalized-email binding still match and no newer login attempt has started.
Even a mode/account round trip invalidates the binding; older replies are discarded
conservatively even if a newer attempt fails. No late result starts /me or sets auth/user.
Responses lost after server-side rotation
can leave the local advisory token obsolete; no delivery or expiry guarantee is made.

There is no localStorage, sessionStorage, cookie, URL, logging or snapshot exposure
of either token. The bridge projects deviceToken only on login success; it is never
forwarded on /me, logout, discovery, chat, memory or agent requests. Possession is
only a throttle input, never proof of authentication. Password checks and /me remain
required, and unrelated route limits may still refuse a request. This is candidate
source plus fictional loopback verification, not live backend or browser acceptance.

### Owner personality proposal review

The existing Agents destination includes an explicit read/list/detail and approve/reject surface for CORE-01c, pinned to backend `912436b9e`. The default remains fixture mode; the explicit offline login mock contains one fictional proposal for `sample-main` and an empty queue for `sample-helper`. No backend is contacted. Real transport remains injection-only.

All nine base/proposed traits, each delta, reason, evidence and review identity are shown before the owner checks full-review consent and chooses a decision. Selection, detail refresh and session epoch changes invalidate consent. The sole decision body is `{expectedReviewHash}`; no proposal creation, preset editing, optional rejection note or broader personality mutation endpoints are allowed. Personality never grants tools or permissions. Copy is an English draft.

Exact shared response schemas reject extra fields rather than hiding hash-covered content. Every 409 causes a read-only detail refresh and requires fresh consent. Writes have no automatic retry. Uncertain outcomes remain blocked for the proposal/account on that client, including after pane remount; explicit GET observes state but does not establish which request succeeded. 401/inactive-user 403 clears the session and review. The bridge maps write421 to502 to avoid fetch replay; that outcome is conservatively unknown.

Verification is offline controller/React server-render/schema and owned ephemeral fictional HTTP testing only. No browser, rendered accessibility, live backend, security certification or deployment acceptance is implied. The previous formal review requests remain pending.

### Agent read and rename refusals

Agent list/detail projection keeps valid IDs and positive safe versions when a legacy stored name is invalid. Such rows contain exactly `{id, version, nameUnavailable: true}`; valid rows retain exactly `{id, name, version}`. Raw invalid names and other backend fields never reach the view. Rename inputs, Save and Generate are disabled for unavailable names; another valid agent remains usable. This is a display quarantine, not a repair or a new backend schema. Suggestions remain the existing agent-independent endpoint; no extra ID or marker is sent in requests.

A pre-transport blocked Save clears only its own pending attempt and reports refusal. Sent/cancelled or otherwise ambiguous outcomes still require explicit reconciliation. A definitive reconciliation 404 removes that selection and its pending attempt only, without claiming whether an earlier Save committed. Stale results never change the active selection/session.

## Live entry candidate (source preparation only)

`npm run build:candidate -- --live-entry` explicitly compiles the live injection.
Without this flag all builds stay fictional. The flag requires `--candidate`;
unknown, repeated, origin and current/promotion arguments are rejected before writes.
No environment, query or browser-storage value selects live mode. Production builds
use `configFile:false` and `envDir:false`; no Vite environment files are loaded.

The live candidate checks the actual page origin is exactly `http://127.0.0.1:42522`
before mounting, then injects a SessionClient with the fixed-origin transport and
window-bound fetch. Wrong origins fail closed. Initial mode remains fixture, with
zero mount requests. Select **Use live sign-in**, **Check setup status**, then
explicitly submit login. Live failure never selects a mock, retries or falls back.
Returning to the fixture is a separate explicit local action. AuthBoundary constructs
the offline fallback only while no client is supplied; an injected live client has
no executable fallback to mock. Static imports still include fictional fixture/mock
code in the bundle; conditional construction is not bundle elimination.

After separate runtime approval and explicit listener handover, serve a live
candidate only with `node scripts/application-server.cjs --enable-isolated-api --candidate`.
Do not serve a live candidate with `preview.cjs`: the static preview has no API bridge.
Building does not start this server or authorize backend startup.

Typed stream errors retain only `code: model_unavailable` and sanitized error text.
The UI identifies an unavailable model while keeping side effects unconfirmed.
The unchanged absolute chat limit is 120 seconds; reaching it leaves the outcome
unknown and never retries. An interrupted bridge stream may not expose its exact
termination cause, so the UI states the bound without inventing a cause.
On HTTP 429, only an integer Retry-After from 1 through 3600 seconds is forwarded
and displayed. Dates, fractions, duplicate values and out-of-range delays are
dropped. This is advisory display only, cleared with the session epoch; no timer
or automatic retry is introduced.

Candidate manifests record `entryMode:live-candidate` and hash an HTML entry marker.
Artifact readers reject live provenance on current, including a candidate pointer
accidentally copied to current (or its entryMode removed). Legacy fictional current
manifests remain supported. There is no live promotion command. These integrity
checks prevent accidental exposure, not deliberate rewriting of artifacts/hashes.

This is source preparation, not runtime approval. Pending reviewer acceptance,
backend isolation, synthetic setup and explicit listener handover still gate any
live deployment. Building a candidate does not change the frozen current preview.

### Stage 1 bridge guard (explicit opt-in)

For the bounded read/auth slice, use:

```sh
node scripts/application-server.cjs --enable-isolated-api --candidate --stage1-read-only
```

`--current` is also accepted in the same position. The flag is optional; omitting
it preserves the existing ordinary bridge behavior, including reviewed writes
and chat. Unknown, misspelled, duplicate or valued flags refuse startup rather
than silently selecting ordinary mode. The internal server factory and
`startApplication(channel, options)` accept the strictly boolean
`stage1ReadOnly: true`; they default to false. No environment toggle, alternate
CLI destination, retry, build or pointer promotion is introduced.

Stage 1 forwards only these existing bridge routes, with their existing strict
identifier, canonical encoding, query, body and response validators:

- GET `/api/setup/status` (no Authorization), `/api/auth/me`, `/api/agents`,
  `/api/agents/:id`.
- GET `/api/memory/files/:drawer?agentId=:agentId`,
  `/api/memory/proposals`, `/api/memory/proposals?status=pending`,
  `/api/memory/proposals/:id`.
- GET `/api/agents/:id/personality/proposals` and
  `/api/agents/:id/personality/proposals/:proposalId`.
- POST exact `/api/auth/login` and `/api/auth/logout`, with unchanged schemas.

All other API routes/methods are denied before upstream I/O with HTTP 403 and
`{"code":"stage1_read_only"}` (HEAD has no response body). Host/Origin failures
and malformed transport requests retain their existing boundary errors.
Reserved agent names `status` and `name-suggestion` are denied throughout this
read slice, including case variants; encoded aliases do not pass the canonical
allowlist. `/api/agents/status` is a provider-probing static route, not an agent
detail read. Re-audit static backend route names whenever that source changes.
Skills/marketplace, avatar, tool grants, personality current/history, arbitrary
GETs, HEAD/OPTIONS API requests, setup mutations, chat, name suggestion, CAS
rename and memory/personality decisions are not enabled.

The existing Host/Origin/auth checks, security headers, response projection,
size/deadline bounds and no-retry behavior remain in effect. Login/logout and
auth/audit may write disposable backend state: this is a bridge read/auth
boundary, not a write-free backend or a network sandbox. Direct backend access
and browser integration are outside this guarantee. The UI is unchanged and
may still offer actions that this mode refuses. Synthetic tests use only
ephemeral loopback upstreams and close their listeners; they do not certify a
real isolated backend run.

## Phone pairing (MOB-PAIR-01)

Settings › Phone, the sidebar phone button and the last setup step share one
pairing flow (`src/phone.ts`, `src/PhonePairing.tsx`, `src/PhoneSettings.tsx`).
`src/phone-contract.js` is the only way to `/api/phone/*`: owner only, exact
bodies, known reply fields and fixed codes; it is wired into `session.ts` and
`scripts/application-server.cjs`. The QR code is drawn by the own encoder in
`src/qr-code.ts` (byte mode, level M). Tests: `tests/qr-code.test.cjs`,
`tests/phone-contract.test.cjs`, `tests/phone-ui.test.cjs`.
