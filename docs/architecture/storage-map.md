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
| Agent `MEMORY.md` | the file, with a hash check and `.memory-versions/` history; with `GIRRU_STORE_P5` on, one memory in the agent's own drawer (`agent:<id>`) whose history holds the file's earlier versions | `MEMORY.md` (written from the drawer; a file changed outside Girru is kept, never overwritten); read into prompts as untrusted text | A write with an old hash is refused | With `GIRRU_STORE_P5`. Only the agent's own prompt and the owner read it; no search, access rule or other agent opens it |

### Handoffs

| Field | Owner | Copies and views | Conflict rule | State |
|---|---|---|---|---|
| Notes from Girru's agents | `agent_handoffs` | chat and task prompts | New version per note; newest wins on read | Today |
| Notes from coding tools | `memory_bridge_handoffs` | project brief, `latest_handoff`, `AGENTS.md` | Same | Today; with `GIRRU_STORE_P4` on they live in `agent_handoffs` too (kind `project`, source `coding_app`) and every entry point reads that one table; the old table is dropped one release later |
| Blockers, files touched, task (`T-n`), chat, card, the lead of a mid-task handoff | `agent_handoffs` columns (migration 178) | the task page's "Linked to T-n", the card's handoff count and "Blocked", `latest_handoff` / `project_brief` with a task | The owner edits blockers in place; files touched are read only | With `GIRRU_STORE_P8`. The card, task number and chat come from trusted rows when the note is saved, never from the model; a coding tool's note is copied into `agent_handoffs` to carry them |
| A run's working notes | `run_notes` | the run (read only) | Append only; at the run's end marked lines become its handoff (when it wrote none) and lesson suggestions the owner reviews, without a model | With `GIRRU_STORE_P8`. Never memory by themselves |

### Agents

| Field | Owner | Copies and views | Conflict rule | State |
|---|---|---|---|---|
| Name, model, provider | `agents_config` | task file shows the name with the id | `version` + `If-Match`; **Planned:** required on every write | Today (optional check) |
| Permissions and tool grants | their database tables | — | Server-side only | Today |
| Personality text and traits | the personality record: `agent_personality_versions` (+ `personality_texts`) | `PERSONALITY.md` (text + a generated settings part) | Append-only versions; an edit names the version it read (`409` when it moved on); an outside edit of the file becomes a proposal | With `GIRRU_STORE_P4` on. Off: the file holds the text, the database the traits |
| Owner's extra instructions | `agents_config.system_prompt` | prompts | `version` + `If-Match` | Today. With `GIRRU_STORE_P4` on, hiring and Evolution no longer write it |
| Job (specialties) | `agent_specialties` link + `specialty_template_versions` | read-only copy (Planned) | Versioned | Today; with `GIRRU_STORE_P4` on a linked hire and a team hire from the library write only the link, and `agents_config.specialty` is no longer written |
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
| Link to memory and handoffs | the database | — | With `GIRRU_STORE_P8`: the task number links the task's notes, its handoffs, its chats and its line in the task file |

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
| Cursor | `.cursor/rules/girru.mdc` → `AGENTS.md` | `dpro-memory` MCP server (`~/.cursor/mcp.json`) | With `GIRRU_STORE_P7` |
| GitHub Copilot CLI | `AGENTS.md` | `dpro-memory` MCP server (`~/.copilot/mcp-config.json`) | With `GIRRU_STORE_P7` |

The MCP server answers only for folders Girru knows as project folders, and only from that project's drawer. Coding tools never write memory directly: `memory_propose` creates a proposal the owner approves, and `handoff_write` leaves a handoff note. Girru changes only its own entry in each tool's settings file. With `GIRRU_STORE_P7`, turning a tool off in Girru takes that entry out again, and a clean-up before uninstalling takes it out of every tool, keeping whatever else the tool's file holds; the tools' own memory files are read for import only through review.

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

### Pilot (one project, opt-in)

A first version of the change log, the session capability and the shared agent context runs for one project and one agent when these backend environment variables are set. `GIRRU_STORE_P2` (every agent) and `GIRRU_STORE_P6` (every project) now do the same for everyone and are on by default, so the pilot adds nothing; it stays opt-in until it is removed:

| Variable | Effect |
|---|---|
| `GIRRU_STORE_PILOT=<project id>` | The project's memory drawer keeps a change log (database triggers, same transaction as each write). A worker keeps `<project folder>/.girru/brief.md` in step and records its status (up to date, waiting, conflict, not reachable, failed). Coding tools must call the `dpro-memory` server with a session capability for this project. |
| `GIRRU_STORE_PILOT_AGENT=<agent id>` | The agent's task runs use the shared agent context (owner rules, instructions, personality, team, knowledge), and its coding-app replies also get the project's pinned facts and newest handoff as data. |

- **Session capability:** the owner issues one with `POST /api/memory-bridge/projects/:projectId/capabilities` (`scopes`: `brief:read`, `memory:read`, `memory:propose`, `handoff:write`; optional `client`, `ttlMs` up to 24 hours) and revokes it with `DELETE /api/memory-bridge/capabilities/:id`. Girru's launcher passes the token to the coding tool's process as `GIRRU_SESSION_CAPABILITY`; only its hash is stored. The project comes from the capability; a folder path in a call never grants access, and a folder of another project is refused.
- **Sync status:** `GET /api/memory-bridge/projects/:projectId/sync`; `POST` with `{"action":"rebuild"}` re-renders from the current records, `{"action":"use_girru_version"}` resolves a conflict by keeping the outside file next to the brief and writing Girru's version.
- Lines removed from `brief.md`, or the whole file, are never read back: the file is regenerated and no memory is forgotten.

### Foundations (on by default)

`GIRRU_STORE_P3` (on by default; `GIRRU_STORE_P3=0` turns it off) turns on:

- **One list of departments** for agents and projects (`departments`). Renaming or merging a department follows into agents, boards, cards, specialty templates, hire items, meeting decisions and rule targets; a merge can be undone; deleting one lets its agents and rules go (a rule left without a department is paused). Owner routes: `GET/POST /api/departments`, `PATCH /api/departments/:id`, `POST /api/departments/:id/merge`, `POST /api/departments/merges/:mergeId/undo`, `POST /api/departments/questions/:id`.
- **Projects by id in memory:** at start-up every project key moves from the slug to the project's id; a key with no project becomes a real project. Deleting a project keeps its memory under its own id, so a new project with the same name starts empty. Links that name a project by its slug keep working for one release. With the switch off again, the keys move back.
- **Source, trust and replaced facts:** new memories record where they came from (owner, agent, coding app, import, channel) and how far to trust them (checked, unchecked, imported); a background job fills older rows. A new fact on a known topic replaces the old one, which stays in History and is never recalled. `PUT /api/memory/scopes/memories/:id/checked` marks a memory as checked or undoes it.
- **Start-up after an update:** Girru stops before writing anything when the data was written by a newer Girru, and a failed update step is named with an error id; the desktop start page explains both.

### One store per piece (on by default)

`GIRRU_STORE_P4` (on by default; `GIRRU_STORE_P4=0` turns it off) turns on:

- **One personality record:** an agent's personality text and its adjustments share one versioned history. Edits in Girru save at once (Undo restores the version before); `PERSONALITY.md` is written from the record; a change made to the file outside Girru, and every Evolution text suggestion, waits in Personality review. At start-up each agent's current file text is imported once.
- **The job from the specialty link:** `system_prompt` keeps only the owner's extra instructions. Chat, task runs, coding apps and the heartbeat use the one agent context, so a hired agent's job reaches chat. A public room gets its own prompt and then only the agent's personality text.
- **One handoff table** for agents' and coding tools' notes.
- **The old memory index file** `.data/memory/memory.db` is retired after a verified full backup, and the old skill marketplace routes answer `410`.

### Agent notes and agent packages (off by default)

`GIRRU_STORE_P5=1` turns on:

- **Agent notes in the database:** at start-up each agent's `MEMORY.md` is imported once into its own drawer, with the file's earlier versions as history. Prompts read the drawer; the owner saves with the hash of the text read; `MEMORY.md` is written from the drawer, and a file changed outside Girru is kept until the owner decides.
- **Agent packages:** one JSON document per agent with `schemaVersion` and a content hash. Import is untrusted: permissions, tool grants, credentials, hooks and private history are never imported, a secret refuses the package, specialties and skills are linked only when this computer has the same content, and nothing is downloaded. Each import is recorded with its hash.

### Ids in files and proven sync (off by default)

`GIRRU_STORE_P6=1` turns on:

- **A session for every project:** a coding app's memory calls open a project only with a session Girru issued for it (a folder path never grants anything). Girru issues one when it starts a coding app in a project folder and ends it when the run ends. Company facts reach a session only where the owner allowed them for that project.
- **Limits on what a session can read:** a search answer is capped, unusual read volume is refused with one notice, and every read is logged with its session (ids only).
- **Text from repository files is a proposal:** what Girru reads back from files in a project folder becomes a review item marked as coming from a repository file. No rule accepts it on its own.
- **Hidden ids in the task file:** each task in `.girru/tasks.md` carries a hidden line with its card id and version. A task renumbered or renamed in the file keeps its card. A duplicate, unknown or foreign id becomes a visible problem and nothing is written.
- **Who did it:** a coding-app session records the agent it works for, so proposals, handoffs and the task file name the app and the agent.
- **Debounced sync from the change log:** every project with its memory files on keeps a change log. The brief file is rewritten by the outbox worker once the project has been quiet for a moment, so a burst of changes gives one write. The file carries the change-log position and its version.
- **One memory contract:** coding apps get five verbs (recall, save, supersede, handoff, propose) from the same definition as the native tools. The server checks every argument, a write with a request id happens once, and a failed write says "not saved, try again".
- **Project files screen:** Memory › Coding apps › Project files lists each project's files with one state each (up to date, waiting, changed in both, folder not found, could not write). Girru never writes over a file changed in the folder until the owner picks. "Use Girru's version" keeps the folder's text as a review item marked as coming from a repository file; Undo puts the text back and withdraws it while the file is unchanged.
- **Task-number problems in Needs you:** a number used twice or a hidden id Girru does not know waits for the owner (new task, add as a task, or leave). Left items are remembered per owner (`task_number_dismissals`).
- **Places that stay on this computer:** the owner marks Memory places (owner, people, experience, tasks, company, each project) as staying on this computer (`memory_place_settings`; People by default). The switch is stored and shown; replies do not yet read it.

### One safe file writer (off by default)

`GIRRU_STORE_P7=1` turns on, for every file Girru writes into a project folder (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `DESIGN.md`, `.girru/` files and `.git/info/exclude`):

- **Inside the folder only:** no `..`, no absolute, drive or network paths, no `\` or `:`, no Windows device names, and no name ending in a dot or a space. The full path must fit the system's length limit.
- **Never through a link:** each folder on the way, and the file itself, must be a real folder or a plain file at its own path. Symbolic links, Windows junctions and hard links are refused.
- **No case collisions:** a name that differs from an existing one only by case (or by Unicode form) is refused.
- **Text only, with a size limit:** UTF-8 with no NUL bytes, 1 MB at most.
- **Atomic:** Girru writes a temp file next to the target, flushes it, checks again that the folder and the target are still the ones it checked, then renames it over the target. An interrupted write leaves the old file. A temp file left by a crash is removed on the next write.
- **Locked files:** a file held open by another program on Windows is retried a few times. If it is still locked, the write is reported and nothing changes.

Nothing is written when any check fails, and the error says why.

The same switch adds **the project folder layout in one step**: a dry run lists every file Girru would create or change, and the owner's confirm writes them all (or nothing, when one is a conflict). The task file comes on with the project's files, with no separate Rules step. An existing `.girru/tasks.md` is kept as it is. The routes are in the [API reference](../API.md).

Tasks that arrive from `.girru/tasks.md` are treated as untrusted. An agent may plan such a task, but until the owner approves the project once, every tool that changes something asks first, and a scheduled run of the task does not start. Rules never come from the file: the task's text reaches the agent as data only.

With the same switch:

- **The brief explains the work:** the task file's format and ids, when to read `project_brief` and `latest_handoff` again (a new session, after a break, taking over), and when to call `handoff_write`. It also lists the project's topics (its topic keys and the topics the memory graph finds) by title only, in a stable order and with a size limit; agents get the details with `memory_search`. This text is in the brief file and the MCP answer, never in a chat prompt.
- **Private memory stays out of files:** the brief is built only from pinned facts of the company, a department or this project, and from this project's memories. Anything from the owner's own drawer, People or another project stops the write.
- **Agent file for Claude Code (optional):** an agent can be copied to `~/.claude/agents/girru-<name>.md` in the user's home, never into a project. The owner sees a preview first. The file holds the agent's name, description, personality and instructions, never permissions, memory or keys. Girru replaces or removes only files that carry its own marker line. Routes: `GET`, `POST` and `DELETE /api/agents/:id/user-export`.
- **Antigravity:** first-run setup looks for the Antigravity CLI (`agy`) instead of the Gemini CLI.
- **Claude Code's own auto memory** is untrusted input: runs that Girru starts switch it off, and what Claude Code writes there reaches Girru only as review proposals.

### Task links and run notes (off by default)

`GIRRU_STORE_P8=1` turns on:

- **The task number links a task:** its task notes, its handoffs (newest first, with blockers, files touched, who wrote it with which app and from which chat), its chats and its line in `.girru/tasks.md` read in one call; a card shows how many handoffs it has and "Blocked" when the newest names a blocker. The owner edits blockers; files touched stay as written.
- **Handoffs between agents:** a lead can hand part of a task to a specialist with a structured note; it is stored as the specialist's handoff naming the lead, and the specialist's own note names the lead too.
- **Run notes:** a run's short working notes stay with the run, read only, and are cleared 14 days after its last note. At the run's end lines starting `Done:`, `Left:`, `Next:`, `Blocked:` and `File:` become its handoff when it wrote none, and `Lesson:` lines go to the owner as suggestions. No model is called for this.
- **Local models unchanged:** the new tool arguments and `run_note` are offered only to models that are not on this computer, so a local model's prompt and tool list stay the same size.

### Hardening, privacy and quality (off by default)

`GIRRU_STORE_P9=1` turns on:

- **Faster recall:** recall keeps its own index in memory: each memory's word counts and vector, checked against the stored text and model on every search and read again only when they changed. The full rows are loaded for the results alone. The scores and order are the same as before. Measured on generated data with 100,000 memories (46,731 in the open drawers): 1.06 s to 0.11 s with offline vectors and 3.8 s to 0.30 s with 1,024-dimension vectors (median), with less than half the memory. The index never goes to disk, is capped (256 MB by default, `GIRRU_RECALL_INDEX_MB`), drops a user's entries after 30 minutes without a search and drops them at once when a memory is forgotten. The drawer filter of every memory query has its own index (migration 179, used with the switch off too).
- **Backups that really restore:** before a backup is signed, its copy of the main database is unpacked into a scratch folder, opened, checked and counted against what was saved. A backup that fails this is not marked checked and cannot be restored. Backup files are owner-only (0600, folders 0700); the signing key and the forget ledger's key are never in a backup. On PostgreSQL the app still does not dump the database; it reports whether a pg_dump file newer than 26 hours is in the backups folder.
- **Stays on this computer, enforced:** a Memory place whose switch is on (People by default) reaches only a model on this computer. For any other model (a provider's API, a coding app, an MCP client) its memories, memory tools and pinned facts leave the turn: in chat, coding-app replies, task runs and the coding tools' memory search, recall and brief. A coding app asking about such a project is told its memory stays on this computer. Where a model runs comes from configuration only: Ollama on a loopback address and LM Studio are local; nothing else is. A reply's trace lists the places that stayed (ids only).
- **Personal data and special categories:** imported text and channel messages that hold other people's e-mail addresses, phone numbers, bank or card numbers, street addresses or identity numbers are flagged in the review (the kinds, never the values). Memories about health, religion, politics, sexuality, origin, union membership or genetic and biometric data are never saved by themselves, even where a scope rule saves everything else; the owner decides.
- **One person:** `GET /api/memory/people/:key/export` gives everything about one person in one file: their memory place (current and replaced facts), memories elsewhere that mention them (by the memory graph or their name), their graph entries and the handoff lines that name them; an agent's own notes appear as ids only. `POST /api/memory/people/:key/forget` (with the person's name to confirm) forgets their place with its history, the mentioning memories the owner picked from the export and their graph entries in one action; handoff notes stay (they are work records). Both are owner only and audited (ids and counts).
- **Old facts about people:** when memory retention runs, a fact about a person that was replaced more than 365 days ago is forgotten; the current fact stays.
- **Members' private memory:** the owner cannot read a member's private memory through any memory route (tested).
- **When memory fails:** a reply whose memory could not be read goes on without it and is told to say memory was unavailable when it matters, never to invent it. A coding app's `handoff_write` written while Girru is away waits in a small local queue (`handoff-queue.jsonl` in Girru's config folder, owner-only, at most 20 notes for 7 days) and is sent when Girru is back; read tools then say memory is offline and point to the project's brief file. Failed saves and recalls are counted (ids only, 30 days, migration 180), and the second failure of a kind in a day raises one notice.
- **Health:** `GET /api/memory/health` gives five rows (Remembering, Saving, Backups, Coding apps, Background jobs), each "ok" or "needs you" with its 7-day counts; `GET /api/memory/health/support` gives a support file with versions, counts, ids and timings, never memory text, names, keys or home-folder paths. The owner decides whether to share it. Nothing is sent anywhere by Girru.
- **The memory doctor at night:** a scheduled read-only check (02:40) records its counts for the health view. It never fixes anything by itself, never calls a model and never runs inside a reply.
- **Every provider, the same memory:** each provider's tool format (Claude API, Ollama and LM Studio, OpenAI API, Gemini API, MCP) must pass the same five-verb scenario (save, recall, supersede, handoff, propose, a refused wrong argument, and a last recall that returns the new fact and not the old one) on synthetic tool calls before it counts as supported; a provider that has not passed is "memory limited". No live provider is called for this.
- **The forget ledger:** each forget adds a line to `forget-ledger.jsonl` in the data folder (owner-only) with the memory and user ids and a keyed hash of the text, never the text. A backup carries a copy. A restore keeps the current ledger and adds the backup's lines, and the next start forgets every line again, including the same text saved under another id, so a restored backup never brings forgotten memory back.

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
| Facts about people | the local model only, unless the owner turns off "Stays on this computer" for People | With `GIRRU_STORE_P9`: enforced in chat, coding apps, task runs and the coding tools' memory |

### How long it is kept

| Data | Kept |
|---|---|
| Memory | Until it is deleted or forgotten. Automatic retention is off until the owner turns it on; it never touches the owner, project or people drawers. |
| Deleted memory | In the Trash, with its history, for the company's Trash period (7, 30 or 90 days, or never; 30 by default), then forgotten |
| Memory history | Until the memory is forgotten |
| Handoff notes | The newest 20 versions of each agent's note, and the newest 20 notes per project from coding tools |
| A run's working notes (`GIRRU_STORE_P8`) | 14 days after the run's last note, then cleared |
| A replaced fact about a person (`GIRRU_STORE_P9`) | 365 days after it was replaced, when memory retention runs; then forgotten |
| The forget ledger (`GIRRU_STORE_P9`) | Ids and keyed hashes, kept so a restored backup never brings forgotten memory back |

### Export and forget

- **Export:** each drawer can be exported as a Markdown file; with `GIRRU_STORE_P9` everything about one person in one file, and forgetting that person is one action.
- **Delete** moves a memory to the Trash and can be undone.
- **Forget** cannot be undone. It removes the memory, the text of all its versions (one tombstone without text remains), its index rows, its Markdown copies and exports, its text in proposals and its lines in stored summaries.
- **Forget ledger** (`GIRRU_STORE_P9`): every forget is recorded with ids and a keyed hash only, and applied again after a backup is restored, so forgotten data does not come back. Backups made before a forget still hold the memory until they expire (14 days, 4 Sundays, 30 days for before-update and before-restore backups).
- **Decided and tested:** in a workspace with members, the owner sees shared scopes only, never a member's private memory.

## Related pages

- [Database](../DATABASE.md)
