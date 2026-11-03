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

## Calendar

### GET /api/calendar/events
List calendar events

### POST /api/calendar/events
Create event
```json
{
  "title": "Meeting",
  "start": "2026-02-22T10:00:00Z",
  "end": "2026-02-22T11:00:00Z",
  "type": "meeting"
}
```

### GET /api/calendar/sources
List calendar sources (Google, iCal)

### POST /api/calendar/sources
Add calendar source

### POST /api/calendar/sync/:sourceId
Sync calendar source

---

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
