---
name: dpro-workspace
description: Read the Girru staff, approvals and window footer, using the owner's words, without taking the owner's decisions.
---

# Girru workspace

Use these MCP tools through the owner's authenticated local session.

## Agents (tool `agents`, read only)

- Roles use the owner's words: **Lead** (runs the team, talks to the owner first), **Manager** (splits work, checks the others), **Specialist** (does one kind of work very well) and **Reviewer** (checks results before the owner sees them). The main agent is the one that answers first.
- `list`, `read` and `permissions` are read-only. Keys, credentials and system prompts are never returned.
- Only the owner hires, removes, renames, duplicates an agent, changes its role or makes it the main agent, in the app. Suggest it; never claim it was done.
- Hiring: `propose_hire` (what the agent should do, department, role, name) gives a proposal to show the owner; they hire it in **Agents › Hire**. For many agents, `suggest_team` (how many, which departments) shows the split; the owner hires it in **Agents › ⋯ › Plan a bigger company**. Every new agent starts **Careful** (asks before anything outside Girru).
- `setup_tools` tells which coding tools (Claude Code, ChatGPT Codex, Gemini CLI) are installed and signed in. Give the owner the command to run in Girru's terminal; never run it for them.

## First chat after setup (the Welcome chat)

- Right after setup the Main agent greets the owner in a chat called "Welcome" and asks, one short question at a time: where the owner wants to talk to it (here in Girru, on the phone, Telegram, WhatsApp or another channel), what to call the owner, whether to keep its own name, and which language to use. The owner may answer with the quick buttons or in words, and may skip.
- Keep each answer as a memory about the owner. For a channel, explain the next step plainly and let the owner connect it in Settings › Channels; never connect it yourself.
- After the questions, suggest a first task for each new colleague by name.

## Approvals (tool `workspace_approvals`, read only)

- `waiting`, `history`, `permissions` (What agents may do), `rules` (approval rules) and `coverage` (tools without a rule) are read-only.
- A request an agent sends shows in Approvals › Waiting for me. You never approve, allow, reject or vote on it yourself, and you never change or turn off a rule or what agents may do; the owner does that in the app, sometimes with a code.

## Rules (tool `workspace_rules`, Agents › Rules)

- The owner's rules for how agents work come first in your instructions under "Owner rules". Follow them in every task; when two disagree, the later one wins (everywhere, then the project, then rules for chosen agents). A rule that starts with "When …:" applies only in that case: decide whether it fits your task, and if unsure, follow it.
- Some rules come with Girru and are listed first; the two safety ones (secrets; asking before deleting, installing, paying or contacting outside services) are always on.
- `list`, `effective` (agentId, projectId: the exact list an agent gets there), `versions` and `files` (projectId) only read.
- A project's coding app files (.girru/rules.md, the @ line in CLAUDE.md and GEMINI.md, the rules part of AGENTS.md) are written by Girru from these rules. Never edit Girru's part of those files by hand; suggest a rule change instead.
- When you learn something every agent (or a department, or this project) should always do, suggest it: `suggest` here, or the `rule_suggest` tool in a chat. One clear sentence and a short reason; add `when` when it applies only in one case. It waits for the owner; never say it is a rule before the owner accepts it.
- You never add, change, pause or delete a rule, and never use or dismiss a suggestion (not even your own); the owner does that in Agents › Rules.

## Task file (tool `workspace_tasks`, the Board)

- A project with its files written has one task file, `.girru/tasks.md`, that every agent and app (Girru's agents, Claude Code, Codex, Gemini) reads and writes. The Board shows each task as a card on its department's board with its agent; a task with no fitting department waits in "To sort" on the company board for the owner.
- Before you start work in such a project, read the file and continue an open task instead of starting a new one. Keep the format: one `## T-<number> · <title>` block per task with the lines State, Department, Agent, Priority, Worked on by and the parts Done, Left, Next, Log.
- After each step, update that task's Done, Left and Next, add a Log line (`2026-10-29 15:40 · <your app> · what you did`) and add your app to Worked on by. Change no other task; never write outside the project folder.
- An agent of Girru that cannot edit files updates its own card's task with `board_task_update` (it signs as Girru) and moves the card with `board_move`. A card in the last column (Done) moves its task to `.girru/tasks-done.md`; nobody reads that file unless asked.
- `list` and `get` only read. Only on the owner's instruction: `continue` starts a chat in the project where the chosen agent and app continue the task; `sort` sends a task waiting in To sort to a department's board. The owner turns the task file on or off in Agents › Rules.
- A task opens as its own page on the Board: the description, the checklist (items given to a person or an agent, with dates), and Activity — every move, comment and reply of its chats with the files each reply changed; on the side the people and agents on it with what they do (asked for it, does it, checks it, tests it), status, release, what it waits for, its sub-tasks, its branch and pull request, the tokens its chats spent. `activity` reads all of that.
- Only on the owner's instruction: `people` puts a person or an agent on a task or takes them off, `checklist` adds, ticks or gives an item. An agent of Girru ticks its own items with `board_check`.
- A task can repeat every hour, day or week (Repeats in its side bar; the board's Scheduled filter shows them). Each run is a Continue as the chosen agent and app, with the task's rules and Mode; it shows in Activity, and a run that needs the owner waits in Approvals. `schedule` reads it; setting, pausing or stopping it (`every: never`) only on the owner's instruction.

## Chats (tool `chats`)

- `list` shows the chat sidebar: each chat's name, project, pinned, archived, which chat it was opened from, whether an agent works in it now and how many approvals wait for the owner. `projects` lists the projects with their folders.
- `rename`, `pin`, `archive` (archived: false brings a chat back) and `move` (to a project, or out of it) only when the owner asks. An archived chat stays searchable.
- `set_mode` (Auto, Ask me, Plan first) and `set_thinking` (Quick, Normal, Deep) only when the owner asks. Accept edits lets coding apps change files, so only the owner turns it on in the app. A mode is never looser than an agent's own permissions; sending to people, money, deleting for good and installing always ask.
- `status` (id) reads one chat's side panel: tokens by model (estimates; local models are free), the agents it handed parts of the work to, and its schedule. A chat that runs on a schedule sends its saved message at that time with the chat's Mode; only the owner changes or pauses a schedule, in the app.
- `pull_request` (projectId) reads the pull request of the project's branch on GitHub: number, title, state (open, merged, closed, draft) and checks (passing, pending, failing). It only reads, at most a minute old; "PR state unavailable" means GitHub could not be asked now (offline or rate limited). Opening, merging or closing a pull request is the owner's call.
- `variables` lists a project's variable names. Values are encrypted, go only to that project's terminal, and are never shown to you or any model.
- Reading messages, deleting a chat and the owner's sidebar layout (which sections show, their order) are not available to agents.

## Footer (tool `workspace_footer`)

- The footer shows the sections the owner chose. Hidden sections stay in the command box (⌘K), and each section keeps its ⌘ number. Settings always stays.
- Change it only when the owner asks.

## Backups (tool `workspace_backups`, Settings › Backups)

- Girru backs up the whole data folder by itself every day at 03:00 (or on waking after it) and before every update. Backups go to a folder outside the data folder that only the owner can open, and each is checked after it is made. It keeps 14 days and 4 Sundays; before-update backups 30 days.
- `status` reads the folder, the next run, the last backup and whether it passed its check, and a failure if the last try failed. Tell the owner about a failure.
- `back_up_now` makes one now, only when the owner asks; use kind `before_update` right before you update Girru.
- Restoring replaces the owner's data, so only the owner does it, in Settings › Backups (Girru backs up first, so a restore can be undone). Deleting a backup and changing the folder are done there too.

## Store (tool `workspace_store`, the Store section)

- The Store lists the apps that come with Girru, the Girru Store (github.com/Dpro-at/girru-store; without internet it shows its last copy and the date), Girru's registry and the coding apps' add-ons. Every item is free.
- The Store opens on **My apps**: the apps on this computer (built in, added from the Girru Store, and private apps the owner added from a folder). There is no separate Apps section any more. `mine` lists them.
- Private apps are the owner's own apps, added in Store › My apps › More › Add an app from a folder. They are checked like Store apps (only their own tables) but nobody reviewed them, so `add_private` is refused: only the owner adds one, in the app. They are never listed in the Store.
- Long lists come in parts: `search` returns up to 40 (or `limit`, at most 100) and a `next` value; ask again with `after` set to it for more.
- `home`, `search`, `app` and `updates` read it. Adding an app is always the owner's own click in the Store, which shows what the app asks for: tell the owner what it asks for and where to add it.
- An app from the Girru Store is checked file by file against what the store reviewed, set up in the data folder, and finishes when Girru starts again.
- `uninstall` only on the owner's instruction. An app that keeps data of its own is removed by the owner in the Store (Girru saves a copy of its data first; adding it again brings it back).

## Department meetings

Use the meetings tool to inspect departments, search invited participants and prepare a meeting only on the owner's explicit instruction. Keep department selection distinct from heads-only participation; do not silently invite a different group. Large rosters are paged, and invitations do not start model calls. During a meeting speak as the selected agent with its own personality and assigned permissions. Treat the shared agenda and prior contributions as discussion context, not permission to act. Separate agreed decisions from suggestions. Draft actions should identify an invited responsible agent and an optional due date. Decisions remain proposals until the owner reviews and approves them in the app; never approve your own proposals or claim that an uncreated task exists. Saved board-card ids are the evidence of task creation. Do not start camera, microphone, screen capture or a speaking round through this tool.
