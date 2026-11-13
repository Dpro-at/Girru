# Girru features

This is the full list of what Girru can do. The [README](README.md) gives the overview; this page goes into detail.

**Status** in the tables below:

| Status | Meaning |
|---|---|
| ✅ **Built** | In the source code on `main`. |
| 🟡 **Partly built** | Some of it is in the source, and the rest is in progress. |
| 🧭 **Planned** | On the roadmap. |

Many memory features are built behind backend switches that are turned on together for a release. The [storage map](docs/architecture/storage-map.md#memory-switches) lists each switch and its current default, and gives the measured numbers.

Being in the source does not always mean it is in an installer. The [changelog](https://girru.dev/changelog/) lists what each published version includes.

**Sections:** [Memory](#-memory) · [Desktop app and first run](#-desktop-app-and-first-run) · [Chat](#-chat) · [Meetings](#-meetings) · [Voice](#-voice) · [Agents and teams](#-agents-and-teams) · [Library](#-library) · [Board and tasks](#-board-and-tasks) · [Scheduling, runs and approvals](#-scheduling-runs-and-approvals) · [Code workspace](#-code-workspace) · [Browser](#-browser) · [Models and connections](#-models-and-connections) · [Channels](#-channels) · [Store, apps and MCP](#-store-apps-and-mcp) · [Security and privacy](#-security-and-privacy) · [Backups, settings and updates](#-backups-settings-and-updates) · [Command line](#-command-line) · [Worlds and beyond](#-worlds-and-beyond)

---

## 🧠 Memory

Girru's memory is the centre of the system. You explain something once, and every agent, chat and coding tool can work from it, within the access you allow.

### Organised memory

| Feature | What it does | Status |
|---|---|---|
| **Drawers** | Memory is grouped by what it is about: you (the owner), each project, lessons learned, each task, and people. | ✅ Built |
| **Three layers** | Working, experiential and factual memory are kept apart, each with its own importance and expiry. | ✅ Built |
| **Pinned facts** | Facts that always apply, set at company, department or project level and loaded first in every reply. | ✅ Built |
| **Project groups** | Several projects for one client or team can share what they learned with each other. | ✅ Built |
| **Topic keys** | One memory per topic is updated in place, so the same fact does not pile up. | ✅ Built |
| **Readable copies** | Memory is kept in the database and also written out as readable Markdown files. | ✅ Built |

### Finding the right memory

| Feature | What it does | Status |
|---|---|---|
| **Hybrid search** | Combines keyword ranking (BM25) with meaning-based search (embeddings). | ✅ Built |
| **Arabic-aware search** | Arabic text is normalised, Iraqi dialect is matched to standard Arabic, and words are lightly stemmed. | ✅ Built |
| **Knowledge graph** | People, projects and things named in memories are linked to each other. Groups that keep appearing together become suggested topics. | ✅ Built |
| **Context budget and cache** | Each reply loads memory in a fixed order and within a set budget, so local models stay fast and reuse their cache. | ✅ Built |
| **Why this answer** | Each reply records which facts, memories and notes it used and why, and you can open that record. | ✅ Built |
| **Re-embedding** | When the embedding model changes, stored memories are updated so search stays correct. | ✅ Built |
| **Careful recall** | Recall is routed by what you ask, re-ranked on your computer, and says "no reliable memory" instead of guessing. | ✅ Built |
| **How sure** | Each memory shows how sure Girru is, from how many sources agree and whether you verified it. You can mark a memory as verified. | ✅ Built |
| **The newest fact wins** | A new fact on the same topic replaces the old one, which stays in History and is no longer recalled. | ✅ Built |
| **Fast at scale** | Recall keeps its index in this computer's memory only, never on disk, and keeps it in step as memories change. Large drawers use a compact index. Measured locally on generated data (Windows i9): about 90 ms for 1 million memories and 270 ms for 10 million, before 32 s at 1 million. | ✅ Built |
| **Understands the conversation** | A short follow-up such as "and where is it hosted?" is searched with the project or person the conversation is about, including the other names they go by. | ✅ Built |
| **Questions with several parts** | "Who is the contact of the client whose deadline is in March?" is searched part by part, so each fact is found. | ✅ Built |
| **Stays on the project** | Memories about another project or person count less than memories about the one the conversation is about. | ✅ Built |
| **Questions about the past** | "What was our plan in February?" or "which database did we use before the switch?" finds the older fact as well. The reply is told that it was replaced and is no longer current. A question about now never gets a replaced fact. | ✅ Built |
| **Memory as evidence** | Each recalled memory reaches the reply with its project, the day it was saved, whether it is current or replaced, and how sure Girru is, with short rules on answering for the time asked. Measured with a local model on 100,000 memories: more correct answers, especially about the past. | ✅ Built |
| **More languages for word search** | Word search also works for Chinese, Japanese, Thai and Hindi, not only for languages that put spaces between words. | ✅ Built |
| **Safe edits by agents** | An agent sees the version of each memory it reads. If the memory changed since, its edit is refused with the newer text instead of overwriting it. | ✅ Built |

### Learning, with you in control

| Feature | What it does | Status |
|---|---|---|
| **Mixed approval** | Routine facts are saved automatically. Important ones wait for your approval. | ✅ Built |
| **Review inbox** | Waiting items grouped by project, department or agent, with "accept all routine" after a preview. | ✅ Built |
| **Conflict check** | A new memory that contradicts an existing one is flagged. It catches a "not" on one side or opposite words (like and dislike, always and never), in English, German and Arabic. | ✅ Built |
| **Full history** | Every add, edit and delete is versioned with who made it and why, and can be restored. | ✅ Built |
| **Trash** | Deleted memories can be restored until the day they are finally forgotten. | ✅ Built |
| **Retention rules** | When a task is over, its details are summed up as one lesson. Memories about you, your projects and people are never forgotten automatically. | ✅ Built |
| **Weekly summary** | A short "what I learned this week" for each drawer, built without paid calls. | ✅ Built |
| **Memory doctor** | A health check that finds duplicates and other problems. A fix runs only after you confirm it. | ✅ Built |
| **Handoff notes** | When a chat goes quiet or a task run ends, a short note (done, left, next) is written so the next agent can continue. | ✅ Built |
| **Corrected after use and open questions** | Memories that were corrected after a reply used them, and questions memory could not answer, wait in Needs you. Answer a question in place and it becomes a verified fact. | ✅ Built |
| **Memory health** | Remembering, saving, backups, coding apps and background jobs, each "ok" or "needs you". A read-only check runs at night and never fixes anything by itself. | ✅ Built |

### Access and privacy

| Feature | What it does | Status |
|---|---|---|
| **Per-agent permissions** | Read and write access is set for each kind of drawer and passed down from company to department to project. | ✅ Built |
| **Time-limited exceptions** | An agent can get extra access that ends on a date you set. | ✅ Built |
| **Secret redaction** | Imports and shared files are scanned, and keys, tokens and passwords are hidden before anything is saved or written. | ✅ Built |
| **Local first** | Memory stays on your computer. Background memory work uses a local model when one is available. | ✅ Built |
| **Stays on this computer** | Mark a memory place (People by default) so that it reaches only a model on your computer, never a provider or a coding tool. | ✅ Built |
| **One person: export and forget** | Everything about one person in one file, and forget it in one action. | ✅ Built |
| **Forgotten stays forgotten** | Forgetting removes the text and its copies; restoring an older backup does not bring it back. | ✅ Built |
| **Sensitive facts wait for you** | Facts about health, religion, politics and other special categories are never saved by an agent on its own. Other people's contact or bank details in imports are flagged. | ✅ Built |
| **Memory helper** | A small local model, used only for memory search, that gets ready by itself in the background. Until then memory uses an offline search that is weaker across languages. Installing the local runtime for you is still to come. | 🟡 Partly built |

### One memory for your coding tools

| Feature | What it does | Status |
|---|---|---|
| **One brief, every tool** | Girru writes one project brief into `AGENTS.md`. `CLAUDE.md` and `GEMINI.md` point to it, and Antigravity reads `AGENTS.md` directly, so a single update reaches Claude Code, Codex and Antigravity together. | ✅ Built |
| **Memory server (MCP)** | Coding tools can read the brief, pinned facts and the latest handoff, search project memory, suggest new memories and leave handoff notes. | ✅ Built |
| **Automatic connection** | Supported coding tools found on your computer are connected to the memory server. You can preview and undo this. | ✅ Built |
| **Your text stays yours** | Girru writes only inside its own marked section and never changes your own text around it. | ✅ Built |
| **Kept out of Git** | Generated files can be hidden from Git automatically. | ✅ Built |
| **Learn back from tools** | Notes you write in your coding tools' own memory files come back as suggestions for you to review. | ✅ Built |
| **More tool files** | Cursor and GitHub Copilot get Girru's instructions and the memory server too. | ✅ Built |
| **One memory contract** | Every model and coding tool uses the same five memory verbs (recall, save, supersede, handoff, propose), checked by the server. | ✅ Built |
| **A session per project** | A coding tool reads memory only for the project Girru opened it in. A folder path never grants anything, and every read is logged. | ✅ Built |

### Bring in what you already have

| Feature | What it does | Status |
|---|---|---|
| **Import past coding chats** | Reads conversations saved on this computer by Claude Code, Codex and Antigravity (and older Gemini CLI chats). They are redacted and you review them first. | ✅ Built |
| **Project documents** | You choose project documents to learn from. The originals are never changed. | ✅ Built |
| **Scheduled project import** | An opt-in schedule that keeps a project's facts up to date. | ✅ Built |
| **Project databases** | Girru finds a project's local databases (names and tables only, never data or passwords). You decide how much each agent can see. | ✅ Built |

---

## 🪟 Desktop app and first run

| Feature | What it does | Status |
|---|---|---|
| **Desktop app** | Girru runs as a desktop app on macOS and Windows, with a Linux build, and keeps its data on your computer. | ✅ Built |
| **Run here or connect** | Run Girru on this computer, or connect the app to a Girru you already run elsewhere. | ✅ Built |
| **Owner account** | The first person creates the owner account with a one-time setup code shown on this computer. | ✅ Built |
| **Find what you already have** | First run looks for your projects, notes and AI tools, and you tick which folders and drives Girru may read. | ✅ Built |
| **Your AI tools** | First run finds the coding tools installed on your computer and lets you sign in to them in a built-in terminal. | ✅ Built |
| **Local model check** | First run recommends a free local model that fits this computer. | ✅ Built |
| **Your team** | Pick a company size and departments, and Girru proposes a team you hire in one step. | ✅ Built |
| **Earlier workspace** | Pick up a workspace you used before, or start a separate new one. | ✅ Built |
| **System permissions** | One screen asks for microphone, folder, disk and notification access. | ✅ Built |
| **Menus, tray and windows** | Native menus, a tray menu with quick actions, and chats in their own windows. | ✅ Built |
| **Bottom bar** | Choose which sections appear in the bottom bar, drag them into order, and show Approvals only when something is waiting. | ✅ Built |
| **Command palette** | Press ⌘K to jump to any section, setting or recent chat, or to search inside chats. | ✅ Built |
| **Light and dark themes** | Follow the system, or choose light or dark. | ✅ Built |
| **More interface languages** | The app is in English today. Other languages come later. | 🧭 Planned |
| **Guided first chat** | The main agent asks a few setup questions in its first conversation and shows what it can do. | 🧭 Planned |
| **Signed installers** | Installers that open without operating-system warnings. | 🧭 Planned |

## 💬 Chat

| Feature | What it does | Status |
|---|---|---|
| **Chat list** | Chats are grouped as scheduled, running, pinned, by project and archived, and you can rename, move and search them. | ✅ Built |
| **Choose who answers** | Pick the agent, the model and how deeply it thinks for each message. | ✅ Built |
| **Modes** | Let the agent ask first, accept edits, plan first, or work on its own. | ✅ Built |
| **Several agents in one chat** | Address agents by name. Group replies come one agent at a time, and the main agent can hand parts of the work to its team. | ✅ Built |
| **Steer, stop and undo** | Change direction while an agent works, stop it, and undo the files it changed. | ✅ Built |
| **Queue, edit and retry** | Queue messages while an agent is busy, edit and resend, or ask again. | ✅ Built |
| **Files and images** | Attach files and images to a message. | ✅ Built |
| **Details panel** | See how full the chat is, tokens by model, who is working, the files changed, the memory used and the connected tools. | ✅ Built |
| **Memory in replies** | See which memories a reply used, and correct, move or trash one from there. Ask Girru to remember something. | ✅ Built |
| **Secrets kept safe** | A key or password you type in chat is moved into the encrypted key store and hidden in the chat. | ✅ Built |
| **Warnings about hidden orders** | Text that tries to give your agent orders is flagged in the chat. | ✅ Built |
| **Scheduled chats** | Send a saved message to an agent on a schedule. | ✅ Built |
| **Chat and board** | Add a chat to a board, see the cards the agent suggests, and get board updates in the chat. | ✅ Built |
| **Export** | Save a chat as Markdown, with secrets removed. | ✅ Built |
| **Talking avatar beside the chat** | An agent face that shows when it is thinking or speaking. It needs the optional GenVR package. | 🟡 Partly built |
| **More chat tools** | Branch a reply to compare models, side chats, and sources under research answers. | 🧭 Planned |

## 🤝 Meetings

| Feature | What it does | Status |
|---|---|---|
| **Meetings in chat** | Invite departments, chosen agents or only department heads into one shared chat. | ✅ Built |
| **Turns** | Agents take turns one by one, or the meeting runs on its own. | ✅ Built |
| **Live attendance** | Invite, dismiss, keep or replace attendees while the meeting runs. | ✅ Built |
| **Call screen** | A call stage with a side chat, camera on or off, screen or window sharing, and the current frame added to your next message. | ✅ Built |
| **Spoken turns** | Speak, and a pause ends your turn. Speech is turned into text on your computer. | ✅ Built |
| **Decisions become tasks** | You review the meeting summary, and the decisions you approve become board cards. | ✅ Built |
| **Live two-way voice and video** | Continuous voice and video with agents, beyond turn-by-turn speech. | 🧭 Planned |

## 🔊 Voice

| Feature | What it does | Status |
|---|---|---|
| **Dictation** | Speak into the microphone, and your words become text on your computer. | ✅ Built |
| **Read replies aloud** | The main agent can read its replies aloud with the voice you choose, or by default. | ✅ Built |
| **Voice library** | Choose from local voices and hear a sample first. | ✅ Built |
| **Create and clone voices** | Design a voice, or clone one from recordings you own or have permission to use. | ✅ Built |
| **Local speech engines** | Speech runs on your computer through local engines you install from Settings. | 🟡 Partly built |
| **A voice for every agent** | Give each agent its own voice, not only the main agent. | 🟡 Partly built |
| **Streaming speech** | Fast spoken replies that stop when you start talking. | 🧭 Planned |

## 👥 Agents and teams

| Feature | What it does | Status |
|---|---|---|
| **Departments and roles** | Agents are organised in departments, each with a lead and a reporting line. | ✅ Built |
| **Org chart** | See your company as a list or a chart, and drag an agent to change who it reports to. | ✅ Built |
| **Agent page** | Set an agent's name, role, department, model, responsibilities, projects and sub-agents. | ✅ Built |
| **Personalities** | Nine adjustable traits, presets, a dialect and locks, with a shared personality library and versions. Changes an agent suggests wait for your approval. | ✅ Built |
| **Specialties** | Job descriptions that bring their own skills, tools and memory access, up to ten per agent. | ✅ Built |
| **Hiring** | Hire one agent from a specialty, or plan a bigger company and hire a whole team at once. | ✅ Built |
| **Per-agent files** | Each agent has a personality file, a memory file and a knowledge folder, with versions you can restore. | ✅ Built |
| **One personality record** | An agent's personality text and traits share one history in the database; `PERSONALITY.md` is written from it, and an outside edit of the file waits for your review. | ✅ Built |
| **One context everywhere** | Chat, task runs and coding apps give an agent the same rules, job, personality and memory. Skills load by name, full text only when needed. | ✅ Built |
| **Agent packages** | Export one agent as one file and import it on another computer. Permissions, keys and private history never travel. | ✅ Built |
| **Tool permissions** | Each kind of tool is off, ask first or allowed, per agent. | ✅ Built |
| **Scheduled check-ins** | An agent can pick up its assigned tasks on a schedule. | ✅ Built |
| **Specialty exams** | Score an agent on standard tasks for its specialty, before and after a change. | 🧭 Planned |
| **Agents on your other computers** | Your main agent gives work to agents on your other paired Girru installations. | 🧭 Planned |

## 📚 Library

| Feature | What it does | Status |
|---|---|---|
| **Personality library** | Saved personalities with a face for each, ready to give to any agent. | ✅ Built |
| **Skills** | One central library of skills: installed, in use, found on this computer, from your coding tools, or from the Girru catalogue. | ✅ Built |
| **Owner rules** | Rules for every agent, a department or chosen agents, per project, with versions, pause and undo. Safety rules are locked. Preview the exact rules one agent gets in one project. | ✅ Built |
| **Specialty templates** | Templates grouped by department. Some are ready, others are marked "coming soon" until their instructions are written. | 🟡 Partly built |

## 📋 Board and tasks

| Feature | What it does | Status |
|---|---|---|
| **Boards** | Boards for the whole company, per department, or shared between departments. | ✅ Built |
| **Four views** | Board, table, calendar and workload. | ✅ Built |
| **Task page** | Description, checklist with owners and dates, sub-tasks, comments, links and an activity log with file changes. | ✅ Built |
| **Repeating tasks** | A card that comes back on a schedule. | ✅ Built |
| **One task file per project** | `.girru/tasks.md` is read and written by every agent and coding tool and shown on the board in both directions. Finished tasks move to their own file. | ✅ Built |
| **Task numbers link everything** | A task number brings its notes, handoffs, chats and its line in the task file together. A card shows when it is blocked. | ✅ Built |
| **Rules in the project** | Owner rules are written into the project folder so coding tools follow them too. | ✅ Built |
| **Design file** | A project's design notes are kept in `DESIGN.md` for every agent. | ✅ Built |
| **Your own record types** | Define your own records and fields, and get forms and agent tools for them. | 🧭 Planned |

## ⏰ Scheduling, runs and approvals

| Feature | What it does | Status |
|---|---|---|
| **Scheduled tasks** | Recurring jobs you can run now, pause, and check recent runs for. | ✅ Built |
| **Task runs that survive restarts** | A task run is saved as it goes, picks up again after a restart, and has a clear "done" definition. | ✅ Built |
| **Approvals** | Protected actions wait for your approval. See what is waiting and the history. | ✅ Built |
| **Several reviewers** | An approval rule can require several people to agree. | ✅ Built |
| **What agents may do** | A permissions grid per agent, plus a list of the tools that no switch covers yet. | ✅ Built |
| **Spending cap** | A daily limit for paid calls that agents make on their own. | ✅ Built |
| **Runs** | Everything that runs (replies, task runs, schedules and background jobs) in one place, and why each one stopped. | ✅ Built |

## 💻 Code workspace

| Feature | What it does | Status |
|---|---|---|
| **Project chat** | Point a chat at a project folder and see its files, Git changes and diffs. | ✅ Built |
| **Terminal** | A terminal with tabs inside the project chat. | ✅ Built |
| **Reviewed file edits** | An agent's file change is shown as a proposal, and it is applied only when you approve it. | ✅ Built |
| **Undo a reply's changes** | Every reply's file changes can be undone or redone. | ✅ Built |
| **Hand work to coding tools** | An agent can pass a coding job to Claude Code, Codex or Antigravity, with your approval. | ✅ Built |
| **Coding sessions and add-ons** | See your coding sessions, and the plugins, hooks, skills and MCP servers each one uses. | ✅ Built |
| **Pull request status** | See a project's pull request state and checks. | ✅ Built |
| **Project variables** | Keep a project's settings and keys in encrypted variables. | ✅ Built |
| **Code editor** | A full project editor next to the chat, with review of agent edits. It is an app you install from the Store, not part of the Girru download; the download is checked before it is used. | ✅ Built |
| **Open in Code** | Open project files, task lines, rule files and changed files in Code at the right line. An agent asks first. | ✅ Built |

## 🌐 Browser

| Feature | What it does | Status |
|---|---|---|
| **Agent browsing** | Agents can open pages, click, type, fill forms, read pages and take screenshots, within their permissions. | ✅ Built |
| **Built-in browser** | A browser tab inside Girru with an address bar, device sizes, extensions and import from Chrome. It needs a browser runtime that is not yet in every installer. | 🟡 Partly built |
| **Visual page editor** | Select parts of a page and change layout, styles and text, linked to reviewed source changes. | 🧭 Planned |

## 🔑 Models and connections

| Feature | What it does | Status |
|---|---|---|
| **Use your subscriptions** | Sign in to Claude Code, Codex and Antigravity and work through the plans you already have. No separate API billing is needed. | ✅ Built |
| **Local models** | Run local models through Ollama, LM Studio or another OpenAI-compatible server on your computer. A model that stops answering is noticed. | ✅ Built |
| **Local models only** | Work with no subscription at all: tools load on demand and each turn fits the model's real window (an 8k turn measured about 2,600 tokens locally). A model that misses part of the memory check is marked "memory limited". The first-run choice and the mark on screen are still to come. | 🟡 Partly built |
| **Small local helper** | Your coding tools can hand light jobs to a small local model. | ✅ Built |
| **Model per agent** | Choose the model each agent uses, including the main agent. | ✅ Built |
| **Optional API keys** | Your own provider keys can be added as an extra choice. They are stored encrypted. | ✅ Built |
| **Subscription replies on Windows** | Subscription sign-in replies on Windows as well as macOS. | 🧭 Planned |
| **Reach your agent from anywhere** | Connect to your own Girru from another device through a paired, encrypted relay, without opening router ports. | 🧭 Planned |

## 📡 Channels

| Feature | What it does | Status |
|---|---|---|
| **One channel connector** | Talk to your agents from messaging apps through one connector, with trusted senders and automatic replies off by default. | ✅ Built |
| **Telegram and Discord** | Built into the connector. | ✅ Built |
| **More messaging apps** | WhatsApp, Slack, Signal, Microsoft Teams, Matrix, email, SMS and more through the same connector. Most are not yet tested live. | 🟡 Partly built |
| **Outsiders stay outside** | People who write through a channel never see your private memory. | ✅ Built |
| **Channel setup from chat** | Set up a channel by talking to the main agent. | 🧭 Planned |

## 🧩 Store, apps and MCP

| Feature | What it does | Status |
|---|---|---|
| **Store** | One Store for apps, MCP servers, skills and specialties. Every installed file is checked first, and unreviewed apps show a warning. | ✅ Built |
| **My apps** | Installed apps as a launcher, with updates, removal (with a saved copy) and pinning to the bottom bar. | ✅ Built |
| **Private apps** | Add your own app from a folder on your computer. | ✅ Built |
| **MCP connections** | Add MCP servers, choose which agents can use them, and import the ones your coding tools already use. | ✅ Built |
| **Calendar** | A Store app for Google and iCal calendars, rebuilt from the start. | 🧭 Planned |
| **Email** | A Store app for email accounts, rebuilt from the start. | 🧭 Planned |
| **Team invitations** | Invite other people to your workspace, as a Store app. | 🧭 Planned |
| **Public chat rooms** | A chat room for a website, as a Store app. | 🧭 Planned |
| **Lighter core** | Apps are downloaded from the Store when you install them, so the core program gets smaller. Code already comes this way. | 🟡 Partly built |
| **Marketing app** | SEO tools and social posting: connect accounts, schedule and publish. | 🧭 Planned |

## 🔐 Security and privacy

| Feature | What it does | Status |
|---|---|---|
| **Two-step sign-in** | Sign in with an authenticator app, keep recovery codes, and see or sign out signed-in devices. | ✅ Built |
| **Protected local server** | Girru listens only on your computer and checks every request, so other websites cannot reach it. | ✅ Built |
| **Encrypted key store** | Keys and passwords are stored encrypted and can be rotated. | ✅ Built |
| **Audit log** | Important actions are logged, with alerts and export. | ✅ Built |
| **Risky tools gated** | Tools that run commands or control the computer are off unless you allow them, and ask for approval. | ✅ Built |
| **Sandbox** | Commands can run inside a container. | ✅ Built |
| **Memory encryption** | Optionally encrypt all memory on disk and keep a log of every read. | 🧭 Planned |
| **System keychain** | Keep Girru's secrets in the operating system's keychain. | 🧭 Planned |

## 💾 Backups, settings and updates

| Feature | What it does | Status |
|---|---|---|
| **Daily backups** | A backup every night and before every update, with restore and a warning if one failed. | ✅ Built |
| **Move your settings** | Export your settings to a file and import them on another computer. | ✅ Built |
| **Searchable settings** | One Settings window for the app, security, connections and workspace, with search. | ✅ Built |
| **Notifications** | In-app notices, and a desktop notice when long work ends while Girru is in the background. | ✅ Built |
| **App updates** | Girru checks for new versions, backs up and updates itself on macOS. On other systems it opens the download page. | 🟡 Partly built |
| **Your backup plan** | Choose what, how often and how many to keep, and back up to drives, network storage or the cloud, always encrypted off-site. | 🧭 Planned |

## 🔧 Command line

| Feature | What it does | Status |
|---|---|---|
| **`girru` command** | Set up, start, stop, check status, chat, import files as memory suggestions, and update with backup and rollback. | ✅ Built |
| **Health check** | `girru doctor` finds common problems and can fix some of them. | ✅ Built |
| **Skills, channels and jobs** | List and manage skills, channels and scheduled jobs from the terminal. | ✅ Built |
| **Changing settings** | Changing settings from the terminal. Showing them works today. | 🟡 Partly built |

## 🌍 Worlds and beyond

| Feature | What it does | Status |
|---|---|---|
| **GenVR spaces** | Create, search and open your 3D spaces, and see the ones you published. It needs the optional GenVR package. | 🟡 Partly built |
| **GenVR account** | Link your GenVR account and publish a world only after you confirm it. | ✅ Built |
| **3D avatars** | Give agents 3D characters. | 🟡 Partly built |
| **Film studio** | Scenes, camera, editing, sound and titles, with agents that help make films and series with your own characters. | 🧭 Planned |
| **Simulation** | Repeatable 3D environments for testing and learning. | 🟡 Partly built |
| **Phone calls** | Inbound and outbound calls through the Call Center app and a supported telephony provider. | 🟡 Partly built |
| **Paper trading** | Practice trading with a virtual balance and limited-risk bots, inside the Trading app. Market views use sample data for now. | 🟡 Partly built |
| **Phone control** | Pair your phone so agents can use it, only with your approval. | 🧭 Planned |
| **Mobile companion** | Chat, tasks, schedules and approvals from your phone. | 🧭 Planned |
| **Circuit and PCB editor** | Design circuits and boards with your agents, check them, and export manufacturing files after your approval. | 🧭 Planned |
| **Robotics and electronics** | Moving memory and skills to robots, firmware for Arduino and Raspberry Pi, and IoT devices. | 🧭 Planned |
