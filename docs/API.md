# API Reference

All backend API endpoints.

**Base URL:** `http://localhost:41522`

---

## Authentication

### POST /api/auth/register
Register new user
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "User Name"
}
```

### POST /api/auth/login
Login user
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```
**Returns:** `{ token: "jwt_token" }`

### POST /api/auth/logout
Logout current user

---

## Agents

### GET /api/agents
List all agents

### POST /api/agents
Create new agent
```json
{
  "name": "My Agent",
  "emoji": "🤖",
  "system_prompt": "You are a helpful assistant",
  "model": "claude-sonnet-4.5"
}
```

### PUT /api/agents/:id
Update agent

### DELETE /api/agents/:id
Delete agent

### Agent files (owner only)
| Route | Body / answer |
|---|---|
| `GET /api/agents/:id/library` | `{ files: [{ name, kind, size, read }], removed }` — `PERSONALITY.md` (who it is), `MEMORY.md` (its notes), knowledge files |
| `GET /api/agents/:id/library/file?name=` | `{ name, kind, content, hash, managed, redacted, read, version? }` |
| `PUT /api/agents/:id/library/file` | `{ name, content, expectedHash }` → `{ hash, redacted, version? }`; `409 changed` when the file moved on |
| `POST /api/agents/:id/library/file` | add a knowledge file `{ name, content, read? }` |
| `GET /api/agents/:id/library/versions?name=` · `GET …/library/version?name=&id=` | earlier versions |

### Personality (owner only)
| Route | Body / answer |
|---|---|
| `GET /api/agents/:id/personality/current` | the current version (traits, dialect, lock); with `GIRRU_STORE_P4` also `text` |
| `GET /api/agents/:id/personality/versions` | every version, newest first |
| `PUT /api/agents/:id/personality/text` | `{ text, expectedVersion }` → a new version (`GIRRU_STORE_P4`; `409 changed`) |
| `POST /api/agents/:id/personality/rollback` | `{ version }` → a new version with that version's content |
| `GET /api/agents/:id/personality/proposals` | suggestions and outside edits of `PERSONALITY.md`, with the text before and after |
| `POST /api/agents/:id/personality/proposals/:pid/approve` · `…/reject` | `{ expectedReviewHash }` |
| `GET /api/agents/:id/personality` · `PUT …` | the `PERSONALITY.md` file; with `GIRRU_STORE_P4` the `PUT` needs `{ content, expectedVersion }` |

### Agent notes (MEMORY.md, owner only)
| Route | Body / answer |
|---|---|
| `GET /api/agents/:id/memory` | `{ content, hash, truncated, redacted }` — with `GIRRU_STORE_P5`, from the agent's own drawer after the import |
| `PUT /api/agents/:id/memory` | `{ content, expectedHash }`; a write with an old hash is refused (`409`) |
| `GET /api/agents/:id/memory/status` | `{ imported, versions, outsideChange }` (`GIRRU_STORE_P5`) |
| `GET /api/agents/:id/memory/history` | `{ versions: [{ version, change, createdAt, by, reason, content }] }`, newest first; `by` is `owner` for the owner's own changes (`GIRRU_STORE_P5`, else `404`) |
| `GET /api/agents/:id/memory/outside` | `{ outside: { file, fileHash, notes, notesHash } }` while MEMORY.md differs from what Girru last wrote, else `{ outside: null }` |
| `POST /api/agents/:id/memory/outside` | `{ pick: "use" \| "keep", fileHash }` → `{ hash, previousHash }`. `use` saves the file text as the next version of the notes; `keep` writes the file again from the notes. `409 changed` when the file moved on since `fileHash` |

Agents cannot write their own notes; only the owner saves them.

### Coding-app sessions (`GIRRU_STORE_P6`)
| Route | Body / answer |
|---|---|
| `PATCH /api/memory-bridge/projects/:projectId` | also `{ companyFacts: true | false }`: company facts may reach coding-app sessions in this project; folder settings then include `companyFacts` |
| `POST /api/memory-bridge/projects/:projectId/capabilities` | `{ scopes, client?, ttlMs? }` → `{ token, capability }` (token shown once); `company:read` is an extra scope |
| `GET /api/memory-bridge/projects/:projectId/sync` | the brief file's sync state for any project (not only the pilot) |

### Project files, task numbers and places (owner only, `GIRRU_STORE_P6`)
| Route | Body / answer |
|---|---|
| `GET /api/store-switches` | also `p6: true` while the switch is on |
| `GET /api/memory/project-files` | `{ projects }`, needs-you first, then by name. Each: `projectId`, `name`, `folder`, `writeFiles`, `companyFacts`, `state`, `needsYou`, `writtenAt`, `version`, `files[{ path, what, version, state, reason? }]`; `state` is `up_to_date`, `waiting`, `changed_in_both`, `folder_not_found` or `could_not_write` |
| `GET /api/memory/project-files/:projectId/compare?path=` | `{ path, version, girruText, folderText }` (Girru's part only for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) |
| `POST /api/memory/project-files/:projectId/rewrite` | writes the files again, never over a file changed in both → `{ project }` |
| `POST /api/memory/project-files/:projectId/use-girru` | `{ path }` → `{ project, undo }`; the folder's text becomes a proposal with reason `repository-file` |
| `POST /api/memory/project-files/:projectId/undo` | `{ undo }` → `{ project }`; `409 undo_expired` once the file changed |
| `PATCH /api/memory/project-files/:projectId` | `{ writeFiles?, companyFacts? }` → `{ project }` |
| `GET /api/memory/project-files/needs-you` | `{ items[{ id, kind, projectId, projectName, file, number, titles, line }] }`, `kind` `duplicate_number` or `unknown_number` |
| `POST /api/memory/project-files/needs-you/:id` | `{ action: "new_task" \| "add_task" \| "leave" }` → `{ ok: true }` |
| `GET /api/memory/place-settings` | `{ places: { [place]: { staysLocal } } }`; places `owner`, `people`, `experience`, `tasks`, `company`, `project:<key>`; People stays local by default |
| `PUT /api/memory/place-settings/:place` | `{ staysLocal }` → `{ place, staysLocal }` |

Errors are `{ error, code }` with `not_found`, `folder_not_found`, `bad_path`, `undo_expired`, `could_not_write` or `bad_place`. The task page (`GET /api/boards/:id/cards/:cardId/task`) also carries `task.number`.

With the switch on, every dpro-memory call needs a session (`x-girru-capability`, set by Girru as `GIRRU_SESSION_CAPABILITY` when it starts a coding app). A session also lists `memory_recall`, `memory_save`, `memory_supersede`, `memory_handoff` and `memory_propose`; writes accept an optional `request_id` and answer `503 not_saved` when they could not be written.

### Project folder layout (owner only, `GIRRU_STORE_P7`)
| Route | Body / answer |
|---|---|
| `GET /api/memory-bridge/projects/:projectId/layout` | dry run, writes nothing → `{ preview: { files, previewHash, conflicts, changes } }`; each file has `relative`, `action` (`create`, `update`, `unchanged` or `conflict`), `by` (`project-files`, `rules`, `task-file` or `brief-sync`), a `reason` for a conflict and Girru's part as a `diff` |
| `POST /api/memory-bridge/projects/:projectId/layout` | `{ previewHash, confirm: true }` → `{ result }`, the same shape after the write. `409 preview_stale` when anything changed since the preview; `409 conflict` writes nothing |

The layout turns the project's files on with the task file in one step: `AGENTS.md`
with the one Girru section, `CLAUDE.md` and `GEMINI.md` pointers, `.girru/rules.md`,
`.girru/tasks.md` (an existing one is kept as it is), Girru's lines in
`.git/info/exclude`, and `.girru/brief.md` when the brief sync (`GIRRU_STORE_P6`) is
on. It needs the one Girru section (`GIRRU_STORE_P2`): `409 p2_off` otherwise.

### Coding tools with `GIRRU_STORE_P7` (owner only)
`cursor` and `copilot` (GitHub Copilot CLI) join the `:client` values of the memory bridge
routes. Turning a tool off (`PUT /api/memory-bridge/clients/:client` with
`{ enabled: false }`) also undoes Girru's registration in its config and answers
`{ undone, failed }`. `POST /api/memory-bridge/clean-up` undoes every registration
before Girru is removed → `{ undone: [{ id, client, mode }], failed }`; only Girru's entry
leaves each file. Tool configs are written through the safe file writer, so a linked
config is refused.

### Agent file for Claude Code (owner only, `GIRRU_STORE_P7`)
| Route | Body / answer |
|---|---|
| `GET /api/agents/:id/user-export?tool=claude-code` | `{ agentId, tool, file, action: create\|update\|unchanged\|conflict, reason, text, previewHash }`; writes nothing |
| `POST /api/agents/:id/user-export` | `{ tool?, previewHash, confirm: true }` → the same answer after the write. `409 preview_stale` or `conflict`, `400 confirm_required` |
| `DELETE /api/agents/:id/user-export?tool=claude-code` | `{ removed, file }`; `409 not_girru` when the file is not Girru's copy of this agent |

The file is `~/.claude/agents/girru-<name>.md` in the user's home, never in a project. A
file without Girru's marker line (or with another agent's) is never changed or removed.

### Tasks from the project's task file (owner only, `GIRRU_STORE_P7`)
| Route | Body / answer |
|---|---|
| `GET /api/memory-bridge/projects/:projectId/task-approval` | `{ approval: { projectId, approved, approvedAt, waiting } }`; `waiting` counts open tasks from the file that wait for the approval |
| `POST /api/memory-bridge/projects/:projectId/task-approval` | `{ confirm: true }` → the same answer, approved. `400 confirm_required` without it |
| `DELETE /api/memory-bridge/projects/:projectId/task-approval` | takes the approval back → the same answer |

A task written in `.girru/tasks.md` (or a block the file changed) is text from someone
else. Until the owner approves the project once, Continue on such a task opens its chat
in "Plan first" mode, so every tool that changes something asks the owner, and its answer
carries `approval: { needed: true, projectId }`. A scheduled run of it does not start and
the owner gets a notification. The task's text always reaches the model as data, never as
a rule.

### Task links, handoffs between agents and run notes (owner only, `GIRRU_STORE_P8`)
| Route | Body / answer |
|---|---|
| `GET /api/store-switches` | also `p8: true` while the switch is on |
| `GET /api/boards/:id/cards/:cardId/links` | `{ taskNo, notesPlace: { place, count } \| null, handoffs, chats: [{ id, title, at }], taskFile: { path, line } \| null, blocked }`; `handoffs` newest first |
| `PATCH /api/handoffs/:id` | `{ blockers: string[] }` → `{ handoff }`; only blockers change (in place); files touched stay as written |
| `GET /api/runs/:runId/notes?kind=chat\|task\|delegation` | `{ notes: [{ seq, text, at }], clearsAt }`, read only; `runId` may also be the Runs id (`chat:…`, `task:…`, `handoff:…`) |

A handoff in these answers is `{ id, agentId, agentName, app, fromAgentId, fromAgentName, at, done, left, next, blockers, files, questions, cardId, taskNo, conversationId, conversationTitle }`; `fromAgentName` is the lead who handed the work over ("Sara handed this to Omar"). With the switch on, a board's cards carry `handoffCount` (only when > 0) and `blocked: true` (only when the newest handoff names a blocker), and `GET /api/handoffs` items carry `blockers`, `files`, `cardId`, `taskNo`, `conversationId`, `fromAgentId` and `boardId`. Errors are `{ error, code }` with `invalid_request` or `not_found`.

The dpro-memory tools `project_brief` and `latest_handoff` take an optional `task` (`T-12`); `handoff_write` and `memory_handoff` take `blockers`, `files` and `task` (`404 unknown_task` for a number that is no task of the project). These arguments are listed only in a dpro-memory process started with the switch on. Agents on a model that is not on this computer (the Claude API, coding apps) also get `run_note`, `handoff_save` with `blockers` and `files`, and `team_delegate` with `task` and `handoff`; local models keep the tools they had.

### One person's data and memory health (owner only, `GIRRU_STORE_P9`)
Each answers `404 not_found` while the switch is off.

| Route | Body / answer |
|---|---|
| `GET /api/memory/people/:key/export` | a download (`person-<key>-<date>.json`): `{ person, exportedAt, names, drawer, mentions, agentNotes: { count, ids }, graph, handoffs }`; `mentions` items carry `why: graph \| name`; `400` for a key that is not a person |
| `POST /api/memory/people/:key/forget` | `{ confirm: <key>, mentionIds?: string[] }` → `{ drawer, mentions, graph }` (how many were forgotten); `mentionIds` must come from the export (`400` otherwise); handoff notes are kept |
| `GET /api/memory/health` | `{ checkedAt, rows: [{ id: remembering\|saving\|backups\|coding_apps\|background, state: ok\|needs_you, word, detail }] }`; counts and ids only |
| `GET /api/memory/health/support` | a download (`girru-support-<date>.json`): versions, switches, database driver and migration, counts per memory kind, the health rows and the last 200 events (kind, id, time); never memory text |

### How sure a memory is, corrected after use, open questions (owner only, `GIRRU_STORE_P9B`)
Each answers `404 not_found` while the switch is off. Agents never mark a memory verified.

| Route | Body / answer |
|---|---|
| `GET /api/memory/trust?ids=a,b` | `{ items: [{ id, level: verified\|heard-once\|not-checked, byOwner, heardFrom: [{ kind, agentId? }], uses, lastUsedAt }] }` (at most 200 ids; kinds and ids only) |
| `POST /api/memory/trust/:id/verify` · `/unverify` | `{ item }`; verify adds the owner's mark (high, verified at once); unverify takes exactly that mark away (Undo) |
| `GET /api/memory/trust-waiting` | `{ corrected, questions }` that wait for the owner |
| `GET /api/memory/corrected` | `{ items: [{ memoryId, nowId, drawer, was, now, changedAt, how: edited\|replaced, checked, replyCount, replies: [{ runId, sessionId, title, agentId, at }] }] }` |
| `POST /api/memory/corrected/:id` | `{ checked: boolean }` → `{ memoryId, checked }` (false = Undo) |
| `GET /api/memory/open-questions` | `{ items: [{ id, question, agentId, status: open\|resolved\|expired, askedAt, resolvedAt, resolvedMemoryId, endsAt }] }` (last 30 days) |
| `POST /api/memory/open-questions/:id/answer` | `{ text, drawer? }` → `{ question, memoryId }`: saved as the owner's own fact; `409 not_open` when it no longer waits |
| `POST /api/memory/open-questions/:id/forget` · `/restore` | forget (no confirmation) → `{ id, undo }`; restore within 10 minutes → `{ question }`, else `410 gone` |

### Memory helper (owner only, `GIRRU_MEMORY_HELPER`)

| Route | Body / answer |
|---|---|
| `GET /api/memory/helper` | `{ status, row }`: the helper's phase (`waiting`, `checking`, `starting_runtime`, `downloading`, `verifying`, `reembedding`, `ready` or `fallback`), download progress and the fallback reason; codes and counts only, never memory text or paths. `row` is its Memory › Health row |
| `POST /api/memory/helper/retry` | try again now after a failure; answers at once |

### Document memory (owner only, `GIRRU_DOC_INDEX`)

| Route | Body / answer |
|---|---|
| `GET /api/memory/documents` | `{ projects, agents }`: each project with its folders (with files read), and `source` (on, state, files, files that cannot be read with a reason code); the agents' Knowledge folders together. No file text |
| `PUT /api/memory/documents/sources` | `{ kind: "project", refId, enabled }` turns a project's documents on or off; off forgets its index (the files are not touched) |
| `POST /api/memory/documents/sources/:id/reindex` | look at the files again now (background; `202`) |
| `POST /api/memory/documents/read-pdf` | `{ data }` (base64, 10 MB at most) → `{ text }` with `--- page N ---` markers, or `{ reason }`; nothing is kept (chat attachments) |

### Agent Connect (owner configuration)

| Route | Body / answer |
|---|---|
| `GET /api/agent-connect/catalog` | Existing channel metadata and masked configuration state, plus `app: { installed, ready }`; `configurable` is false until the separate app is ready. No credentials or program paths are returned. |
| `PUT /api/agent-connect/:id/config` | Saves the existing allowed sender/conversation lists and provider configuration; saving never starts a provider. |
| `PUT /api/agent-connect/:id/activation` | `{ enabled }`; enabling requires the installed runtime, an owner and configured channel. A restart may be needed for the app's routes to load. |

`store:agent-connect` uses the normal Store install/consent/job APIs. Its reviewed package includes a bounded `runtime-packages.npm` list of exact npm archives. These are streamed, size/hash checked and unpacked before atomic activation, without running package scripts. Removing the app retains its channel configuration, credentials and `channel_events`; it stops running hosts and removes only program files. Older hosts without the integration capability are asked to update before the Store plugin registers anything.

### Optional app runtimes (owner only except local program metadata)

| Route | Body / answer |
|---|---|
| `GET /api/apps/code` | `{ state, platform, version, update, available, job }`; `state` is `installed`, `missing`, `unsupported` (no archive for this platform), `bundled` (a developer build that includes Code) or `unavailable`; `update` names a newer version when there is one; `job` is a running install |
| `GET /api/apps/genvr` | Owner-only, loopback-only runtime/install metadata: `{ state, platform, version, update, available, job }`; same state vocabulary as Code; only the SDK version pinned by this Girru build can be installed |
| `GET /api/genvr/runtime` | Local UI bridge only: `{ state: "installed" \| "bundled" \| "missing", version }` describes the runtime loaded by this bridge; no account, paths or job details; GET without query/body |
| `POST /api/store/install` | `{ id: "girru:genvr" \| "girru:code", hash }` adds the reviewed app runtime using the exact catalogue consent hash (download, size and SHA-256 check, unpack); follow `GET /api/store/install/:job`; existing job progress reports whether a restart is automatic or manual |
| `POST /api/store/uninstall` | `{ id: "girru:genvr" }` removes only the managed runtime and closes its managed MCP connection; worlds, projects and account settings remain; removal retains grants, but re-adding or moving the managed launch resets agent grants for review; a restart may be required |

### Open in Code (owner only)

| Route | Body / answer |
|---|---|
| `POST /api/code-open` | `{ path, line? }` → `{ folder, file, path, line, generated, where: project\|data, project }` for a regular file inside one of the owner's projects or the data folder (real path, no links); `403 { code: outside }`, `403 { code: not_allowed }` for keys, environment files, databases and folders, `404 not_found`, `400 invalid` |

With the switch on, a waiting memory flagged as personal data or a sensitive topic (`GET /api/memory/proposals[/:id]`, reasons `personal-data` / `special-category`) also has `privacy: { personalData: (email|phone|bank-account|card|address|id-number)[], sensitive: (health|religion|politics|sexuality|origin|union|genetic)[] }` (kinds and topics, never the values), and `GET /api/store-switches` answers `p9: true`. Agents do the same through the tools `memory_person_export` and `memory_person_forget` (the person's place open for the run; every call needs the owner's approval), `memory_privacy_review` (read only) and `memory_privacy_decide` (keep or forget one, with its review hash; owner's approval).

With the switch on, a memory retention run's answer also has `people: { forgotten, afterDays }` (replaced facts about people forgotten after 365 days). The dpro-memory `memory_search` and `memory_recall` answer "This project's memory stays on this computer…" for a project whose place stays on this computer.

### Agent packages (owner only, `GIRRU_STORE_P5`)
| Route | Body / answer |
|---|---|
| `GET /api/agent-packages/status` | `{ on: true }` while the switch is on (`404` otherwise); the pages show Export and Import only then |
| `GET /api/agents/:id/package` | one JSON package: `format: "girru.agent"`, `schemaVersion`, `packageHash`, agent, instructions, personality, specialties and skills (by content hash), knowledge files |
| `POST /api/agent-packages/preview` | `{ package }` → what an import creates, what it leaves out (`refused`) and what this computer lacks (`missing`) |
| `POST /api/agent-packages/import` | `{ package, expectedPackageHash, again? }` → `{ agentId, refused, missing }` |

An imported package is untrusted: permissions, tool grants, credentials, hooks and
private history (notes, conversations) are never imported, a value that looks
like a secret refuses the package, and nothing is downloaded. The new agent
starts with the default permissions.

---

## Chat

### POST /api/chat
Send message to AI
```json
{
  "message": "Hello",
  "agentId": "agent-id",
  "sessionId": "session-id"
}
```
**Returns:** Server-Sent Events (SSE) stream

### GET /api/chat/sessions
List chat sessions

### GET /api/chat/sessions/:id/messages
Get session messages

### DELETE /api/chat/sessions/:id
Delete session

---

## Runs

Everything that runs (chat replies, agent tasks, small helpers, coding apps, system jobs, chats waiting for an OK) in one read model. The owner sees every run; anyone else sees only their own, never system jobs or agent check-ins. Texts are secret-redacted.

### GET /api/runs
Query: `place` (`running` | `waiting` | `finished` | `failed`), optional `kind` (`chat` | `task` | `helper` | `code` | `job`), `agent`, `project`, `q`, `before` (the `next` value of the previous page), `limit` (up to 100). Returns `{ runs, next, counts: { running, waiting } }`, newest first. Each run has a plain `reason` (`code`, `title`, `text`, `bug`) when it waits, failed or stopped.

### GET /api/runs/item/:id
One run (`chat:…`, `task:…`, `code:…`, `job:…`, `approval:…`): `{ run, steps, log, result, copy }`.

### POST /api/runs/item/:id/stop
Stops a working chat reply, agent task or coding app (same gates as the chat and task-run routes). Body `{}`.

### POST /api/runs/item/:id/retry
Sends a failed or stopped chat reply again, in the same chat, as a new run. Body `{}`.

### GET /api/runs/schedules
System jobs and agent check-ins (owner), chat schedules and card schedules, each with its next and last run and the last result.

### POST /api/runs/schedules
Owner only. "Schedule a task": `{ instructions, every, at, weekday?, agentId?, notify?, newChat?, model?, thinking?, projectId? }`. Makes a board card with the instructions and its repeat; each run continues that task. Returns `{ id, boardId, cardId }`.

### GET /api/runs/schedules/:id/runs
The last runs of one schedule (`job:…`, `chatsch:…`, `cardsch:…`, `checkin:…`).

## Storage

### GET /api/storage
List files

### POST /api/storage/upload
Upload file (multipart/form-data)

### DELETE /api/storage/:id
Delete file

### GET /api/storage/:id/download
Download file

---

## Extensions

### GET /api/extensions
List all extensions

### POST /api/extensions/:id/enable
Enable extension

### POST /api/extensions/:id/disable
Disable extension

### DELETE /api/extensions/:id
Delete extension

---

## Database

### GET /api/database/stats
Get database statistics

### POST /api/database/backup
Create database backup

### POST /api/database/restore
Restore from backup

### POST /api/database/vacuum
Optimize database (VACUUM)

### POST /api/database/cleanup
Delete old records (90+ days)

---

## Notifications

### GET /api/notifications
List notifications

### PUT /api/notifications/:id/read
Mark as read

### DELETE /api/notifications/:id
Delete notification

### GET /api/notifications/settings
Get notification settings

### PUT /api/notifications/settings
Update settings

---

## Avatar

### GET /api/avatar/settings
Get avatar settings

### PUT /api/avatar/settings
Update avatar settings

### GET /api/avatar/user/:userId
List user avatars

### POST /api/avatar/user/:userId
Create user avatar

---

## Multiverse (Worlds)

### GET /api/multiverse
List user worlds

### POST /api/multiverse
Upload world (GLB file)

### PUT /api/multiverse/:id
Update world

### DELETE /api/multiverse/:id
Delete world

### GET /api/multiverse/system
List system worlds

---

## Profile

### GET /api/profile
Get user profile

### PUT /api/profile
Update profile

### POST /api/profile/picture
Upload profile picture

---

## Tools

### GET /api/tools
List available AI tools (18 built-in)

---

## Webhooks

### GET /api/webhooks
List webhooks

### POST /api/webhooks
Create webhook

### DELETE /api/webhooks/:id
Delete webhook

---

## System

### GET /api/system/health
Health check

### GET /api/system/stats
System statistics

---

## Authentication

All endpoints except `/api/auth/*` require JWT token:

```
Authorization: Bearer <token>
```

Get token from login response and store in `localStorage`.

---

## Error Responses

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**Status Codes:**
- 200: Success
- 400: Bad request
- 401: Unauthorized
- 403: Forbidden
- 404: Not found
- 500: Server error


### Chat file previews and command sessions

The owner-only project pane routes accept a relative `path` within the selected project:
`GET /api/chat/projects/:id/file`, `/pdf`, and `/media`.
Text previews are limited to 512 KB. The media route returns `{path,size,mime,base64}`
for supported images (PNG/JPEG/GIF/WebP/SVG), video (MP4/WebM), and audio (MP3/WAV/M4A),
or `{path,size,reason}` when hidden, unavailable, unsupported, or over the 32 MB preview limit.
Secret files and symlink targets outside the project remain refused. SVG is displayed as an
image, never as an active document. CSV and JSON previews are read-only; CSV formulas are text.

`POST /api/terminal/sessions` optionally accepts `command` (1–16,000 characters; tab and
newline allowed, but no other control or format characters (zero-width, text-direction,
tag), no line or paragraph separators and no invisible fillers, so what the owner approves
is exactly what runs; otherwise `400 invalid`). The approval shows the exact command text
with the existing `projectId`, `cols`, and `rows`. The owner reviews and approves the exact
command in chat before creation. This starts a dedicated command session in the same Girru
PTY manager, using the existing owner/loopback checks, project folder and environment rules.
Its stream exit event is the actual command-shell exit. Opening the Terminal pane attaches
the same controller and transcript, and does not create or execute another command.
`POST /api/terminal/sessions/:id/stop` requests termination without discarding the transcript;
the UI waits for the real exit event. Closing a terminal still uses DELETE.
This does not grant agents additional execution permissions.
On Windows a `command` is refused with `501 unsupported` until it is verified on a real
Windows shell; an interactive terminal still opens there. A finished command session keeps
its transcript for replay but no longer counts toward the four-terminal limit, and it is
released after the idle timeout.

`GET /api/chat/projects/:id/office?path=…` previews DOCX/XLSX inside the same owner-only
project pane. The response is `{path,kind,parts:[{name,text}],images:[{name,mime,base64}],truncated}`
or `{path,reason}`. The file cap is 16 MB, selected XML is bounded to 2 MB/128 parts,
and the projected response stays below 3 MB. Archive members are read in memory with
size and CRC checks; no files are extracted. Encrypted, split/ZIP64, malformed and
DTD/entity-bearing packages are refused. External links, macros and embedded programs
are not loaded or executed.
DOCX supports basic paragraphs, emphasis, headings, raster images and tables; layout
is approximate. XLSX shows visible sheets/rows and saved cell values, with search and
copy-cell, without recalculating formulas or loading external data. Preview limits are
20 sheets, 1,000 rows, 100 columns and 20,000 cells per sheet. Advanced formatting,
charts and legacy DOC/XLS files are not supported.

The same `/office` route also previews PPTX. It reads the presentation's ordered slide
relationships and supports up to 40 visible slides, 200 basic shapes per slide, plain/rich
text and embedded raster images. The viewer offers previous/next, slide selection and
arrow keys. Direct shape coordinates are retained where available; slides depending on
layout inheritance use a simplified content layout. Master themes, grouped shapes,
charts, embedded programs, hyperlinks, transitions and animation are not reproduced or
executed. Hidden slides are omitted. All archive, XML, image and response limits above
remain in force. Legacy PPT is not supported.

Format references: [Office Open XML document structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document),
[SpreadsheetML structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document),
and [ZIP format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
