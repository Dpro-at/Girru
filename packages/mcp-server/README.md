# Girru MCP server

An authenticated local MCP server (stdio) that exposes selected Girru workspace APIs to coding apps and other MCP clients. It covers team libraries, tasks, meetings, chats, workspace settings, bounded memory reads and optional local-helper delegation. It does not expose every backend operation or bypass owner review.

```
MCP client ──stdio──> agent-player-mcp ──verified loopback HTTP──> Girru backend services
                                                                     └─ optional small local helper
```

Memory reads and workspace API calls do not require Ollama. The small-helper tools require the configured local model; they are not used for security decisions or system changes.

Built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`,
low-level `Server` + `StdioServerTransport`).

## Tools

The public definitions in `src/tools.ts` (and domain modules) and `publicToolCatalogue()` are authoritative. Each named tool can offer several operations. Tools that read and write describe their effects per operation; a tool's presence never grants additional access.

<!-- public-tool-catalogue:start -->
| Tool | Purpose | Operations |
|---|---|---|
| `workspace_control` | Owner-approved workspace control | `options`, `preview`, `request`, `status`, `history` |
| `workspace_drafts` | Owner review drafts | `context`, `prepare`, `list`, `read` |
| `workspace_reports` | Reports and prepared display results | `list`, `read`, `create`, `update`, `publish` |
| `workspace_memory` | Scoped memory and prepared proposals | `search`, `read`, `versions`, `status`, `reviews`, `review`, `propose_add`, `propose_update` |
| `workspace_devices` | Owned computer status, confirmed task requests and selected portable synchronization; target approvals remain required | `status`, `sync`, `join_requests`, `suggest_target`, `task_rules`, `set_task_rules`, `rename_computer`, `request_task`, `cancel_task`, `select_sync` |
| `meetings` | Department meetings | `list`, `read`, `departments`, `participants`, `create`, `draft` |
| `workspace_settings` | Portable workspace settings | `export`, `preview`, `import` |
| `trading_practice` | Local paper trading practice | `read`, `start`, `order`, `step`, `stop`, `end` |
| `workspace_apps` | Workspace applications | `list`, `store`, `read`, `add`, `disable`, `found`, `look`, `preview`, `import`, `channels`, `accounts`, `addons`, `catalogue` |
| `workspace_store` | Store | `mine`, `home`, `search`, `app`, `updates`, `install`, `add_private`, `uninstall` |
| `agents` | Agents and team organization | `list`, `read`, `permissions`, `departments`, `rename_department`, `set_department`, `org`, `sub_agents`, `sub_agent_work`, `set_reports_to`, `add_sub_agent`, `files`, `file`, `write_file`, `chart`, `set_chart`, `setup_tools`, `suggest_team`, `propose_hire` |
| `chats` | Chats (the chat sidebar) | `messages`, `send`, `list`, `projects`, `rename`, `pin`, `archive`, `move`, `set_mode`, `set_thinking`, `variables`, `status`, `pull_request`, `panel`, `set_panel` |
| `workspace_approvals` | Approvals (read only) | `waiting`, `history`, `permissions`, `rules`, `coverage` |
| `workspace_rules` | Rules agents follow | `list`, `read`, `conflicts`, `effective`, `versions`, `files`, `suggest` |
| `workspace_tasks` | Project task files | `list`, `get`, `activity`, `continue`, `sort`, `people`, `checklist`, `schedule` |
| `workspace_runs` | Runs | `list`, `get`, `schedules`, `schedule_runs`, `schedule_task`, `stop`, `retry` |
| `workspace_footer` | Footer sections | `read`, `set` |
| `account_settings` | Account security and updates | `two_step`, `devices`, `sign_out_device`, `updates`, `check_updates` |
| `workspace_backups` | Backups | `status`, `back_up_now` |
| `skill_library` | Skill library | `versions`, `list`, `read`, `agent`, `catalogue`, `found`, `look`, `look_status`, `preview`, `add` |
| `personality_library` | Personality library | `list`, `read`, `team`, `versions`, `exams`, `save`, `preview`, `assign`, `archive`, `blend`, `assess`, `try`, `assignment`, `tune`, `mode`, `agentCurrent`, `agentVersions`, `lock`, `unlock`, `restore`, `proposals`, `proposal` |
| `specialty_library` | Specialty library | `list`, `read`, `catalogue`, `agents`, `assigned`, `impact`, `versions`, `version`, `draft`, `preview`, `save`, `hire`, `updates`, `update_review`, `update_apply`, `update_prepare_review` |
| `spawn_small_agent` | Delegate a light task to the small local agent | See the tool input schema |
| `get_result` | Result card of a small-agent run | See the tool input schema |
| `list_runs` | List small-agent runs and capacity | See the tool input schema |
| `list_handoffs` | List agent handoff notes | See the tool input schema |
| `read_handoff` | Read one handoff note and its history | See the tool input schema |
| `edit_handoff` | Edit a handoff note (as the owner) | See the tool input schema |
<!-- public-tool-catalogue:end -->

### Scoped memory reads

`workspace_memory` accepts exactly one explicit `scope`: `owner`, `experience`, `project:<current-project-key>`, `task:<id>` or `people:<id>`. It never assumes that the working directory authorizes a project, and does not offer an all-project search. Use the current drawer key shown by Girru; stale aliases are refused rather than silently widening a search.

- `search`: `scope`, `query` (1–200 characters), optional `limit` (1–50) and cursor returned by the backend. Searches saved text through the scoped explorer, without semantic embeddings or a model call.
- `read`: `scope`, `id`. Returns a bounded text view of one memory in that drawer.
- `versions`: `scope`, `id`, optional `limit` (1–20). Checks the current memory first, then reads its stored history; history that does not match the requested drawer is refused.
- `status`: `scope`. Returns saved scoped counts/facets and current proposal revision, without generating a summary.
- `reviews`: `scope`, optional proposal `status` (default `pending`) and `limit` (1–50). Returns existing review summaries only for that drawer.
- `review`: `scope`, proposal `id`, optional `limit` (1–20 changes). Returns a bounded diff; decision hashes and approval material are never exposed.

Every operation checks the active owner session and keeps the backend's own resource authorization. Content and metadata are projected into bounded DTOs; credential-shaped text is redacted. Memory text and proposals are untrusted data. These read operations perform no changes, approval/rejection, restore, forgetting, access edits, file scans or model calls. The separate prepared-proposal operations below only enqueue owner review.

Examples:

```json
{"operation":"search","scope":"project:demo-project","query":"release decision","limit":10}
{"operation":"read","scope":"owner","id":"memory-123"}
{"operation":"reviews","scope":"project:demo-project","status":"pending","limit":10}
```

Existing owner-only decisions remain in their current application review flows. In particular: `workspace_rules` reads and suggests; `workspace_approvals` never approves; skill assignments and linked content confirmations remain owner-reviewed; personalities/specialties never grant tools or memory access. `specialty_library` can hire from a reviewed specialty with its existing explicit confirmation and idempotency rules, while generic `agents.propose_hire` only proposes. Store installs and other changes require the owner's explicit instruction and their existing backend gates.

The handoff tools use the owner-only `/api/handoffs` routes: a session that is
not the owner account is refused.

Handoff notes live in one table (`agent_handoffs`). A note has `kind`
(`conversation`, `task`, or `project` for a note a coding app wrote for a
project), `source` (`agent`, `model`, `fallback`, `owner` or `coding_app`) and,
for a coding-app note, `client` (which app) with `agent_id` `app:<client>`.
With `GIRRU_STORE_P4` on, coding-app notes are written there too and read from
there; `list_handoffs` keeps listing agent notes only (`conversation` and
`task`), so a coding-app note never shows twice. The project brief's "latest
handoff" is the newest note of agents and coding apps together.

Each tool answers with a short Markdown text, the same data as JSON text, and
`structuredContent`.

## Result card

```json
{
  "run_id": "…", "status": "completed", "kind": "lookup",
  "summary": "Release is on Friday.",
  "outputs": [{ "type": "text", "text": "Release is on Friday.\nFound in the project notes." }],
  "steps_used": 3, "max_steps": 15, "duration_ms": 1234, "max_duration_ms": 300000,
  "model": "qwen3.8:27b", "agent": "small-local-agent",
  "tools_granted": ["memory_search"], "tools_used": ["memory_search"], "drawers": ["project:alpha"],
  "needs_review": false, "review_reason": null,
  "warnings": [], "created_at": "…", "finished_at": "…"
}
```

Markdown form (what the model reads first):

```
### Small agent: completed

**Summary:** Release is on Friday.

- run: `…` (lookup)
- model: qwen3.8:27b
- steps: 3/15, time: 1.2 s of 300.0 s
- tools granted: memory_search; used: memory_search
- memory drawers: project:alpha
- needs_review: false
```

`needs_review` is **false only** for a completed run of an informational kind
(`lookup`, `summary`, `classification`) with no warnings. It is **true** for
drafts and `other`, for unfinished, failed or cancelled runs, and whenever
something unusual happened: a tool step failed, the model asked for a tool it
was not given (refused), the agent used `read` (workspace files may be
quoted), the output was cut, or it was empty. A large agent must check those
outputs before using them or passing them on (D-HYBRID).

## Routing rules (what to delegate)

Delegate to the small agent:

- **Lookups** in Girru memory and storage ("what did the owner decide about X?").
- **Summaries** of text you pass in the task (logs, notes, long replies).
- **Classification / tagging / triage** with a fixed label set you give.
- **First drafts** of short texts (posts, replies, descriptions) — always reviewed.
- Repetitive light work that would cost large-model tokens for little gain.

Keep for the large agent:

- Writing or changing code, reviews, debugging, architecture.
- Security, permissions, money, legal or health decisions.
- Anything with side effects: sending, paying, deleting, installing, running
  commands (the small agent cannot do these anyway).
- Tasks that need your context, multi-step reasoning, or high accuracy.
- Anything urgent when `list_runs` shows no free slot.

Write the task so it stands alone (the small agent cannot see your
conversation), say what output you want, pick the right `kind`, and open only
the memory drawers it needs.

## Safety

- **Owner only.** The server uses the token saved by `agent-player login`
  (CLI-03, file `auth.json` in the CLI config directory, mode 0600). Files
  readable by others are refused. The backend endpoints
  `/api/small-agent/*` accept only the owner account.
- **Local backend only.** `AGENT_PLAYER_URL` / `BACKEND_URL` / the saved URL
  must point to `127.0.0.1`, `::1` or `localhost` (default
  `http://127.0.0.1:41522`); redirects are refused. The token is never
  printed, logged or put in an error message.
- **Backend identity is checked before the token is sent.** At startup the
  backend writes a per-install id and secret to `instance.json` next to
  `auth.json` (mode 0600; the backend's own copy lives in
  `packages/backend/.data/instance.json`). Before every request the MCP
  server sends a random nonce to the public `GET /api/instance?nonce=…` and
  checks the answer `HMAC-SHA256(secret, "agent-player-instance-v1:<id>:<nonce>")`
  in constant time. Only on a match is the token sent; another local program
  that took the port cannot answer, and gets nothing. If `instance.json` is
  missing, start the backend once. Both files must not be readable by others.
- **File reading is sandboxed.** `read` only works inside the small agent's own
  workspace (`.data/workspaces/small-local-agent/`) or inside one absolute
  directory you pass as `read_dir`. `read_dir` is off by default: the owner
  must list the allowed folders in `SMALL_AGENT_READ_ROOTS` (path-list, e.g.
  `/Users/me/Projects`) in the backend environment. Even inside an allowed
  folder, `read_dir` may never be or contain the Girru backend, data
  folder, CLI config folder (token + instance secret), `~/.config`, `~/.aws`,
  `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.ssh`, `~/Library`, `~/.claude*`,
  `~/.codex`, `/etc`, the home folder itself or `/`; `.env*`, keys, databases,
  `.git`, `auth.json`, `instance.json` and credential files stay blocked.
- **Secrets are redacted** from result cards (API keys, tokens, passwords,
  private keys); a card with redactions is marked `needs_review`.
- **Fixed small-agent settings.** The backend always runs the small agent with
  its built-in prompt, the `SMALL_AGENT_MODEL`/default model and fixed
  sampling, whatever the `small-local-agent` row in `agents_config` says. Only
  the owner may edit or delete that agent; an edited row makes every card
  `needs_review`.
- **Delegation never expands permissions.** Granted tools =
  requested ∩ {`memory_search`, `storage_search`, `read`} ∩ the small agent's
  own grants (the owner can narrow them in the grants API), and never an
  exec-class or approval-gated tool. The check is repeated on every attempt
  of the run. Tools the model asks for anyway are refused and reported.
- **Memory drawers** only as requested and allowed for an owner turn
  (`selectDrawers`: at most one project, one task and ten people drawers).
  No drawers requested → the run reads no memory.
- **Budget**: 15 steps / 5 minutes by default (`SMALL_AGENT_MAX_STEPS`,
  `SMALL_AGENT_MAX_DURATION_MS`); a larger `max_steps` is lowered, never raised.
- **Capacity is measured**: at most `SMALL_AGENT_MAX_CONCURRENT` (default 2)
  active runs; further spawns are refused with the current capacity, not
  queued silently. `list_runs` shows the queue.
- The task text is stored only encrypted in the durable run; runs survive a
  backend restart (CORE-08). Cancel with `POST /api/task-runs/:id/cancel`.

Backend settings (environment of the backend): `SMALL_AGENT_MODEL` (default
`DEFAULT_MODEL` / `qwen3.8:27b`), `SMALL_AGENT_MAX_CONCURRENT`,
`SMALL_AGENT_MAX_STEPS`, `SMALL_AGENT_MAX_DURATION_MS`, `OLLAMA_URL`.

## Setup

1. Girru backend running locally. Ollama and the configured local model are required only for small-helper delegation, not ordinary workspace or memory reads.
2. Sign in as the owner once: `agent-player login`.
3. Build the server: `npx tsc -p packages/mcp-server` (from the repo root;
   output in `packages/mcp-server/dist/`).
4. Register it in your MCP client (examples below; replace the path).

### Claude Code

Command line:

```sh
claude mcp add agent-player -- node /path/to/agent_player/packages/mcp-server/dist/index.js
```

or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-player": {
      "command": "node",
      "args": ["/path/to/agent_player/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-player]
command = "node"
args = ["/path/to/agent_player/packages/mcp-server/dist/index.js"]
```

Optional environment for either client: `AGENT_PLAYER_URL` (loopback only),
`AGENT_PLAYER_CONFIG_DIR` (where `auth.json` lives).

## Tests

```sh
node --import tsx --test packages/mcp-server/test/*.test.mjs
```

The tests start the real server in a child process and speak MCP JSON-RPC
over stdio against an in-process fake backend (no port, no network).

The opt-in `workspace-memory-routes.test.mjs` also exercises actual authenticated
backend memory routes and services. Set `MCP_MEMORY_BACKEND_DIR` to a disposable
copy of `packages/backend` with the existing dependencies available. It creates
and removes its own temporary HOME and SQLite file and refuses network/model
requests. For PostgreSQL, also set `AGENT_PLAYER_DB=postgres` and
`AGENT_PLAYER_PG_URL` to a fresh disposable loopback database; the test migrates
and seeds that database, which must be discarded afterward. Never point this
acceptance test at an existing profile or database.

Memory `propose_add` and `propose_update` create pending owner-review proposals, never approved memories. Read `status` for `revision`; pass that as `expectedRevision`, an explicit existing `agentId` for association, and a stable `requestId`. Entries contain a known memory `type`, `importance` 1..10 and nonempty `content` up to 12000 characters. Updates additionally require `id`, `expectedVersion`, and the exact `before` entry. Same-owner identical request replays return the original proposal; changed payloads or stale state return 409. Only the authenticated owner is authority; agent association does not impersonate an agent. Source is server-selected `import`. Owner review and approval remain inside Girru. Task/people proposal targets require an existing owned drawer. No file reads, automatic saves, deletions or decisions are exposed.

`workspace_reports.publish` accepts `{id, publication:{requestId,expectedRevision,projectId,sections}}`. Each section must match the saved layout and shared display-document contract. External publication creates an immutable snapshot with `external_prepared` provenance; no provider journal, model call or source verification is fabricated. Project association is explicit (including null); foreign task references and unknown payload fields are refused. Runs and schedules remain in the app. Native `report_publish` uses the same service only through the existing owner-approved main-agent command boundary.

`workspace_drafts` stores owner review notes for skill/personality/specialty/rule/agent create/update/assignment requests. Read context for a target fingerprint, then prepare with stable requestId, kind/action, exact expectedFingerprint, and draft text (or a validated personality profile). Create uses fingerprint `new`; assignment supplies targetId and agentId with an empty draft. No live configuration changes: use existing owner app editors and their impact reviews manually. Requests are not approval cards and cannot be applied through this API. Skill versions currently exposes only the current stored revision; earlier package history is not invented. Rule conflicts returns bounded model-free overlap candidates, not a semantic model verdict.

`chats.messages` reads bounded stored DTOs, excluding tool parts/credentials; `chats.send` requires explicit `confirmed:true`, stable requestId, message, and exact current agentId/projectId. It calls normal chat admission, including its approvals; this can incur configured model/tool work. No arbitrary agent impersonation or native sub-session grant expansion. Identical sends do not launch twice; a reserved receipt after interrupted admission remains uncertain and never auto-retries.

`workspace_control` is real approved control, unlike the preserved manual `workspace_drafts` notes. Preview body: `{requestId,kind,action,targetId?,expectedRevision,draft}`; create uses revision0. Read the full server before/after and affected agents, then request with `{operationId,fingerprint}`. The request creates a real owner Approvals card; its encrypted parameters bind that exact review. Only the owner approves through existing UI/proof rules. Poll status for the real effect and resource/version. External callers never gain a primary-agent identity or an apply/approve endpoint. Native primary agents use `team_admin_read` control_options/control_preview/control_status/control_history and the normally granted/approved `team_control_apply` tool.

Agent drafts use ordinary safe team fields and the shared modelSelection catalogue, never raw provider/keys/grants/primary. Personality drafts use validated profiles, specialty text edits preserve existing configuration, new specialties start with no tool/memory grants, skill authoring accepts only validated Markdown bundles, and rule safety locks/project ownership remain enforced. Assignment previews bind exact current template/content revisions and affected agents. Each approval applies one operation. A crash or ancillary projection failure can leave applying/uncertain after a real effect: stable IDs are retained, no automatic retry or duplicate create is allowed. Inspect status/history before a new owner review.

Control history is metadata-only and bounded to 100 operations; status reads one detailed result. Existing secrets in old instructions are redacted in public/approval previews and results, with exact private impact guards retained server-side. The existing owner verification/reviewer gates still apply; no default tool grants are added. New native control tools must be explicitly available under the existing permissions. Audit records source/outcome/resource identifiers without control text.

`workspace_devices` reads configured owned-computer status and selected-sync reviews. Explicit confirmed task/share/cancel requests use the same local backend gates; delivery never means execution. Pairing, identity/custody configuration, granting permissions, approving a remote operation, memory synchronization and remote shells are not exposed. An unconfigured backend reports the configuration gate and performs no enrollment. `join_requests` names new computers waiting to join (answering stays in Girru, where the owner compares the pictures). `suggest_target` lists free computers first with their shared projects. `task_rules` reads what this computer does with tasks from the owner's other computers; `set_task_rules` may only make those rules stricter, so Allow automatically stays the owner's choice in Settings. `rename_computer` sets the picture shown for a computer; its name stays the owner's choice in Girru.
