# Storage map

This page answers four questions for every piece of information Girru keeps:

- where it is stored;
- which place owns it, so that an edit there wins;
- which copies exist and how they stay in step;
- what leaves this computer, how long it is kept, and how to export or forget it.

Each row is marked **Today** (how the current source behaves) or **Planned** (agreed, not built yet). Contributors who change a store, add a copy or add a new kind of data update this page in the same change.

## Rules

1. **One owner per field.** Each field is edited in exactly one place. Every other copy is a view that is regenerated from the owner, or an input that comes back through review.
2. **The database owns living data.** Memory, handoffs, tasks, permissions and agent settings live in the database. Files are readable copies or review inputs; nothing exists only in a file. One exception: the task file (see [Tasks](#tasks)).
3. **Link by id, show the name.** Links point to ids, never to names, so a rename reaches every copy. Files show the name and carry the id next to it.
4. **An id is a reference, never a permission.** Holding an id, a file or a folder path grants nothing. Access is decided by the server for the signed-in owner or member, the agent's grants and the open drawers.
5. **Stale writes are refused.** A write states the version it changed. If the record moved on, the write is refused and must be retried against the new version. Nothing is overwritten because one watcher fired later than another.
6. **Text from outside is data.** Imported text, tool results and files written by other apps are stored as untrusted and are never followed as instructions.

## Where the data lives

Everything is stored on the computer that runs Girru, under one data folder: `AGENT_PLAYER_DATA_DIR` when it is set, otherwise `.data` next to the backend.

| Store | Location | Holds |
|---|---|---|
| Main database | `<data>/agent-player.db` (SQLite), or a PostgreSQL database chosen in setup | All living data and definitions listed below |
| Memory copies | `<data>/memory/<user>/` | One readable Markdown file per memory (a copy, never read back) |
| Agent folders | `<data>/agents/<agent id>/` | `PERSONALITY.md`, `MEMORY.md`, `knowledge/`, drawer exports |
| Skill library | `<data>/skill-library/` | Skill files, content-addressed (the file name is its hash) |
| Credentials | encrypted store in the data folder | Keys and tokens, never in memory or prompts |
| Project folders | the owner's own folders | Girru's managed sections (see [Project folder](#project-folder)) |

Girru's own servers store none of this. Updates and the Store index come from the public repository; device-to-device traffic, when it exists, is relayed end-to-end encrypted and not kept.

## Three classes of information

| Class | Examples | How it is kept |
|---|---|---|
| **Definitions** — what an agent is | personality, specialties, skills, rules | A versioned record per definition. Specialties and skills already work this way: a content-addressed text plus a database row that points to a version. **Planned:** personality text and traits become one versioned record of the same kind. |
| **Living data** — what happens | memory, handoffs, tasks, runs, permissions | The database is the owner. Files are generated views or come back through review. |
| **Agent package** — an agent to move | export, import, Store, hiring, backup | **Planned:** one folder format generated from the database and imported back into it. It is a transport format, not a second store. |

## Field authority

### Memory

| Field | Owner (edit here) | Copies and views | Conflict rule | State |
|---|---|---|---|---|
| Text, type, importance | `memories` row | per-memory Markdown copy; drawer export files; project brief; `AGENTS.md` section; MCP answers | Edits in a drawer export or from a coding tool become a proposal the owner approves | Today |
| Version for compare-and-set | `memory_versions` (last version) | — | An edit that sends `expectedVersion` from an older version is refused with the current text | Today (when the caller sends it) |
| Drawer (owner, project, experience, task, people) | `memories` row | the drawer's export file | Moving a memory is an edit of the row | Today; project key is the project slug — the project id with `GIRRU_STORE_P3` |
| Valid from / valid until / replaced by | `memories` row | shown as "as of" in recall | A new fact on the same topic replaces the old one instead of keeping both | With `GIRRU_STORE_P3` |
| Source and trust | `memories` row | — | Untrusted text is labelled as data in every prompt | With `GIRRU_STORE_P3` (source and trust are stored; the memory panel shows them next) |
| Embedding | derived from the text | — | Never edited; recomputed when the text or the model changes | Today |
| History | `memory_versions` (append-only) | Trash | Delete keeps the history (undo); Forget removes it | Today |
| Pinned facts (company, department, project) | `memory_pinned_facts` | project brief; `AGENTS.md`; prompts | Owner edits only | Today |
| Agent `MEMORY.md` | the file, with a hash check and `.memory-versions/` history | read into chat as untrusted text | A write with an old hash is refused | Today — **Planned:** an agent drawer in the database, the file becomes its view |

### Handoffs

| Field | Owner | Copies and views | Conflict rule | State |
|---|---|---|---|---|
| Notes from Girru's agents | `agent_handoffs` | chat and task prompts | New version per note; newest wins on read | Today |
| Notes from coding tools | `memory_bridge_handoffs` | project brief, `latest_handoff`, `AGENTS.md` | Same | Today; chat and task prompts read only the first table — **Planned:** one table read by every entry point |

### Agents

| Field | Owner | Copies and views | Conflict rule | State |
|---|---|---|---|---|
| Name, model, provider | `agents_config` | task file shows the name with the id | `version` + `If-Match`; **Planned:** required on every write | Today (optional check) |
| Permissions and tool grants | their database tables | — | Server-side only | Today |
| Persona text | `PERSONALITY.md` **and** `system_prompt` | — | Two owners today: chat reads the file first, task runs and coding apps read `system_prompt` | Today — **Planned:** one versioned personality record; `PERSONALITY.md` becomes a view whose edits come back through review |
| Personality traits | `agent_personality_versions` | a generated block in `PERSONALITY.md` | Append-only versions | Today — **Planned:** part of the personality record |
| Specialties | `agent_specialties` link + `specialty_template_versions` | read-only copy (Planned) | Versioned | Today; the unused `agents_config.specialty` column is removed (Planned) |
| Skills | central skill library (content-addressed) + assignments | read-only copy (Planned) | Content hash and assignment revision are checked | Today |
| Rules | `agent_rules` + `agent_rule_versions` | `.girru/rules.md`; `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; prompts | Versions and restore today; **Planned:** compare-and-set on edit | Today |
| Knowledge files | the files in `knowledge/` | read into prompts | The file is the owner (documents the owner adds) | Today |

### Projects

| Field | Owner | Copies and views | State |
|---|---|---|---|
| Name, folders | `chat_projects` | — | Today |
| Girru sections in project files | generated from the database | see [Project folder](#project-folder) | Today (two separate writers) — **Planned:** one writer, one section |
| Text outside Girru's markers | the owner or the coding tool | — | Never changed by Girru | Today |
| Design section (`DESIGN.md`) | the design record in the database | the file's Girru section | Today |

### Tasks

The task file `.girru/tasks.md` is the one place where a file owns text:

| Field | Owner | Conflict rule | State |
|---|---|---|---|
| Title and body (done, left, next, log) | the task file, read as a revision | A file edit and a board edit made against the same exported version produce a **conflict** the owner resolves, not a silent overwrite | Today: two-way sync — **Planned:** checked against the last exported version |
| Card id (`T-n`), column, department, agent | the board in the database | The file shows the name and carries the id; a renamed agent or department is rewritten from the id | Today by name — with `GIRRU_STORE_P3` a department rename or merge follows into boards and cards; agents **Planned** |
| Run status and steps | the task runner | Read-only everywhere else | Today |
| Link to memory and handoffs | the database | — | Planned |

## Project folder

| File | Today | Planned |
|---|---|---|
| `AGENTS.md` | two Girru sections (memory brief and rules) from two writers | one Girru section: brief, rules and a pointer to the task file |
| `CLAUDE.md`, `GEMINI.md` | short pointers to `AGENTS.md`, plus a rules import line | pointers only |
| `.girru/rules.md`, `.girru/tasks.md`, `tasks-done.md` | written after the owner turns on project files | written when the project is created, after a preview |
| `DESIGN.md` | Girru design section | unchanged |
| `.git/info/exclude` | Girru adds its files so they are not committed | unchanged |
| Other coding tools (for example `.cursor/rules/`) | not written | optional, chosen by the owner |

Creating a project today writes no files; they appear when the owner turns them on.

## Coding tools

| Tool | Reads instructions from | Live memory | State |
|---|---|---|---|
| Claude Code | `CLAUDE.md` → `AGENTS.md` | `dpro-memory` MCP server | Today |
| Codex | `AGENTS.md` | `dpro-memory` MCP server | Today |
| Gemini CLI | `GEMINI.md` → `AGENTS.md` | `dpro-memory` MCP server | Today |
| Antigravity | — | `dpro-memory` MCP server | Today (MCP only) |
| Cursor | — | — | Planned |

The MCP server answers only for folders Girru knows as project folders, and only from that project's drawer. Coding tools never write memory directly: `memory_propose` creates a proposal the owner approves, and `handoff_write` leaves a handoff note. Girru changes only its own entry in each tool's settings file; the tools' own memory files are read for import only through review.

When Girru runs a coding app as a reply inside a chat, the app gets the agent's definition, a fixed memory pack and the conversation; it does not use the owner's own MCP settings.

## Sync status

Today the generated copies are refreshed every 60 seconds. **Planned:** every change writes a change event in the same transaction as the record; a worker updates files, MCP answers and status from those events and resumes after a crash. Each project then shows, per file:

| Status | Meaning |
|---|---|
| Up to date | The file shows the current version |
| Waiting | A change is queued |
| Conflict | The file was edited against an older version; the owner chooses |
| Not reachable | The folder is missing or not writable |

Open coding-tool sessions keep the copy they loaded, so the brief asks them to call `project_brief` or `latest_handoff` when work resumes.

### Pilot (one project, off by default)

A first version of the change log, the session capability and the shared agent context runs for one project and one agent when these backend environment variables are set:

| Variable | Effect |
|---|---|
| `GIRRU_STORE_PILOT=<project id>` | The project's memory drawer keeps a change log (database triggers, same transaction as each write). A worker keeps `<project folder>/.girru/brief.md` in step and records its status (up to date, waiting, conflict, not reachable, failed). Coding tools must call the `dpro-memory` server with a session capability for this project. |
| `GIRRU_STORE_PILOT_AGENT=<agent id>` | The agent's task runs use the shared agent context (owner rules, instructions, personality, team, knowledge), and its coding-app replies also get the project's pinned facts and newest handoff as data. |

- **Session capability:** the owner issues one with `POST /api/memory-bridge/projects/:projectId/capabilities` (`scopes`: `brief:read`, `memory:read`, `memory:propose`, `handoff:write`; optional `client`, `ttlMs` up to 24 hours) and revokes it with `DELETE /api/memory-bridge/capabilities/:id`. Girru's launcher passes the token to the coding tool's process as `GIRRU_SESSION_CAPABILITY`; only its hash is stored. The project comes from the capability; a folder path in a call never grants access, and a folder of another project is refused.
- **Sync status:** `GET /api/memory-bridge/projects/:projectId/sync`; `POST` with `{"action":"rebuild"}` re-renders from the current records, `{"action":"use_girru_version"}` resolves a conflict by keeping the outside file next to the brief and writing Girru's version.
- Lines removed from `brief.md`, or the whole file, are never read back: the file is regenerated and no memory is forgotten.

### Foundations (off by default)

`GIRRU_STORE_P3=1` turns on:

- **One list of departments** for agents and projects (`departments`). Renaming or merging a department follows into agents, boards, cards, specialty templates, hire items, meeting decisions and rule targets; a merge can be undone; deleting one lets its agents and rules go (a rule left without a department is paused). Owner routes: `GET/POST /api/departments`, `PATCH /api/departments/:id`, `POST /api/departments/:id/merge`, `POST /api/departments/merges/:mergeId/undo`, `POST /api/departments/questions/:id`.
- **Projects by id in memory:** at start-up every project key moves from the slug to the project's id; a key with no project becomes a real project. Deleting a project keeps its memory under its own id, so a new project with the same name starts empty. Links that name a project by its slug keep working for one release. With the switch off again, the keys move back.
- **Source, trust and replaced facts:** new memories record where they came from (owner, agent, coding app, import, channel) and how far to trust them (checked, unchecked, imported); a background job fills older rows. A new fact on a known topic replaces the old one, which stays in History and is never recalled. `PUT /api/memory/scopes/memories/:id/checked` marks a memory as checked or undoes it.
- **Start-up after an update:** Girru stops before writing anything when the data was written by a newer Girru, and a failed update step is named with an error id; the desktop start page explains both.

### One agent context and one Girru section (off by default)

`GIRRU_STORE_P2=1` turns on, for every agent:

- **One resolved context** for chat, task runs and coding-app replies: owner rules first, grouped from most to least binding (safety rules, this project, rules naming the agent, its department, all agents), then the hired instructions, personality text, working style, team and knowledge files. Memory, pinned facts and handoff notes are framed as data.
- **Guides by name:** skills and specialties are listed by name and the first line of their description; the agent loads one guide's full text with the `guide_read` tool, and only its own.
- **Save criteria and dates:** `memory_save` and the project brief say what is worth saving; memories recalled for a message show the date they were saved and their drawer.
- **Coding-app memory budget:** the memory sent with a coding-app reply has a token budget instead of a character cap.
- **One Girru section:** `AGENTS.md` gets one section between `<!-- girru:start … -->` and `<!-- girru:end -->` with the memory brief (where memory files are on), the owner's rules and the task-file pointer; `CLAUDE.md` and `GEMINI.md` only point to `AGENTS.md`. The two older sections (`dpro-memory`, `girru:rules`) are replaced in place. With the switch off again, the next write restores the earlier layout.

## Privacy

### What leaves this computer

| Data | Sent to | When |
|---|---|---|
| The prompt of a turn: agent definition, rules, recalled memory, conversation | the model provider chosen for that agent or chat | Only for that turn. With a local model (Ollama or LM Studio) nothing leaves the computer. |
| Memory extraction and summaries | the local model | Always local unless the owner explicitly allows a paid provider for that job |
| Embeddings | the local embedding model on this computer, or an offline hash | Never a remote address |
| Channel messages (Telegram, Discord and others) | the channel's service, and the model provider | A channel sender gets no owner memory |
| Facts about people | **Planned:** the local model only, unless the owner allows a provider | Planned |

### How long it is kept

| Data | Kept |
|---|---|
| Memory | Until it is deleted or forgotten. Automatic retention is off until the owner turns it on; it never touches the owner, project or people drawers. |
| Deleted memory | In the Trash, with its history, for the company's Trash period (7, 30 or 90 days, or never; 30 by default), then forgotten |
| Memory history | Until the memory is forgotten |
| Handoff notes | The newest 20 versions of each agent's note, and the newest 20 notes per project from coding tools |

### Export and forget

- **Export:** each drawer can be exported as a Markdown file. **Planned:** export of everything about one person, and the agent package.
- **Delete** moves a memory to the Trash and can be undone.
- **Forget** cannot be undone. It removes the memory, the text of all its versions (one tombstone without text remains), its index rows, its Markdown copies and exports, its text in proposals and its lines in stored summaries.
- **Planned:** a forget ledger that is applied again after a backup is restored, so forgotten data does not come back.
- **Planned (decided):** in a workspace with members, the owner sees shared scopes only, never a member's private memory; a test will enforce it.

## Related pages

- [Database](../DATABASE.md)
