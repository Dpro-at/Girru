# Girru features

This is the full list of what Girru can do. The [README](README.md) gives the overview; this page goes into detail.

**Status** in the tables below:

| Status | Meaning |
|---|---|
| ✅ **Built** | In the source code on `main`. |
| 🟡 **Partly built** | Some of it is in the source, and the rest is in progress. |
| 🧭 **Planned** | On the roadmap. |

Being in the source does not always mean it is in an installer. The [changelog](https://girru.dev/changelog/) lists what each published version includes.

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

### Access and privacy

| Feature | What it does | Status |
|---|---|---|
| **Per-agent permissions** | Read and write access is set for each kind of drawer and passed down from company to department to project. | ✅ Built |
| **Time-limited exceptions** | An agent can get extra access that ends on a date you set. | ✅ Built |
| **Secret redaction** | Imports and shared files are scanned, and keys, tokens and passwords are hidden before anything is saved or written. | ✅ Built |
| **Local first** | Memory stays on your computer. Background memory work uses a local model when one is available. | ✅ Built |

### One memory for your coding tools

| Feature | What it does | Status |
|---|---|---|
| **One brief, every tool** | Girru writes one project brief into `AGENTS.md`. `CLAUDE.md` and `GEMINI.md` point to it, and Antigravity reads `AGENTS.md` directly, so a single update reaches Claude Code, Codex and Antigravity together. | ✅ Built |
| **Memory server (MCP)** | Coding tools can read the brief, pinned facts and the latest handoff, search project memory, suggest new memories and leave handoff notes. | ✅ Built |
| **Automatic connection** | Supported coding tools found on your computer are connected to the memory server. You can preview and undo this. | ✅ Built |
| **Your text stays yours** | Girru writes only inside its own marked section and never changes your own text around it. | ✅ Built |
| **Kept out of Git** | Generated files can be hidden from Git automatically. | ✅ Built |
| **Learn back from tools** | Notes you write in your coding tools' own memory files come back as suggestions for you to review. | ✅ Built |
| **More tool files** | Writing to Cursor and GitHub Copilot instruction files. | 🧭 Planned |

### Bring in what you already have

| Feature | What it does | Status |
|---|---|---|
| **Import past coding chats** | Reads conversations saved on this computer by Claude Code, Codex and Antigravity (and older Gemini CLI chats). They are redacted and you review them first. | ✅ Built |
| **Project documents** | You choose project documents to learn from. The originals are never changed. | ✅ Built |
| **Scheduled project import** | An opt-in schedule that keeps a project's facts up to date. | ✅ Built |
| **Project databases** | Girru finds a project's local databases (names and tables only, never data or passwords). You decide how much each agent can see. | ✅ Built |

---

## 👥 Agents and teams

| Feature | What it does | Status |
|---|---|---|
| **Departments and roles** | Agents are organised in departments, each with a lead and a reporting line. | ✅ Built |
| **Personalities** | Nine adjustable traits, presets, a dialect and locks, with a shared personality library and versions. | ✅ Built |
| **Specialties** | Job descriptions that bring their own skills, tools and memory access, up to ten per agent. | ✅ Built |
| **Skills library** | One central library of skills. It can import skills from your coding tools. | ✅ Built |
| **Owner rules** | Rules for every agent, a department or chosen agents, per project, with versions. Safety rules are locked. | ✅ Built |
| **Per-agent files** | Each agent has a personality file, a memory file and a knowledge folder. | ✅ Built |
| **Hiring** | New agents are hired from specialties. Agents can propose a hire, and you approve it. | 🟡 Partly built |
| **Avatars and voices** | 3D characters and distinct voices, including custom voices through supported speech engines. | 🟡 Partly built |

## 📋 Work and tasks

| Feature | What it does | Status |
|---|---|---|
| **Task board** | Boards per department, with cards, agents, priorities and columns. | ✅ Built |
| **One task file per project** | `.girru/tasks.md` is read and written by every agent and coding tool and shown on the board in both directions. Finished tasks move to their own file. | ✅ Built |
| **Rules in the project** | Owner rules are written into the project folder so coding tools follow them too. | ✅ Built |
| **Design file** | A project's design notes are kept in `DESIGN.md` for every agent. | ✅ Built |
| **Scheduling and approvals** | Recurring work, and owner approval for protected actions. | ✅ Built |
| **Meetings** | Meet with several agents, with spoken turns. | 🟡 Partly built |

## 🔌 Connections

| Feature | What it does | Status |
|---|---|---|
| **Use your subscriptions** | Work through Claude Code and Codex with your existing plan, or use API keys or local models. | ✅ Built |
| **Channels** | Talk to your agents from messaging apps through one channel connector. | ✅ Built |
| **Store** | One Store for apps, MCP servers, skills and specialties. You can also add your own private apps. | ✅ Built |
| **Extensions and MCP** | Add tools and apps. Agents can use what you allow through MCP. | ✅ Built |

## 🌍 Worlds and beyond

| Feature | What it does | Status |
|---|---|---|
| **GenVR worlds** | 3D worlds where agents can work, plus film production with your own characters. | 🟡 Partly built |
| **Robotics and electronics** | Moving memory and skills to robots, and PCB and IoT design. | 🧭 Planned |
