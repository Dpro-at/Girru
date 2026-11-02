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

### GET /api/agents/:id/files
Get agent files (PERSONALITY.md, MEMORY.md)

### PUT /api/agents/:id/files/personality
Update agent PERSONALITY.md

### PUT /api/agents/:id/files/memory
Update agent MEMORY.md

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
