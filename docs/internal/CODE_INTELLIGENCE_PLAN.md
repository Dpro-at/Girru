# Girru Code Intelligence Memory — gap analysis, architecture, Memory page plan

Status: **proposal, waits for the owner's OK**. Nothing here is built yet.
Date: 2026-11-13. Branch of origin: `girru/memory-version-check`.

Goal: Girru knows the architecture of each project's code (languages, frameworks, modules, symbols,
APIs, database models, dependencies), searches it by meaning, links it to memories in both
directions with stable ids, keeps it current incrementally, learns at night, and shows it on the
Memory page. Local-first, no model call per search, low RAM.

---

## 1. Gap analysis (what exists vs. what the spec needs)

| # | Spec area | What exists today | Gap |
|---|---|---|---|
| 1 | Architecture discovery (languages, frameworks, modules) | `discovery/project-tech.ts` finds **design** (Tailwind, CSS tokens, logos) and **databases** (SQLite headers, `.env` DB keys, docker-compose services). Stored in `memory_project_design` / `memory_project_databases` (migration 122). | No language, framework or manifest detection (package.json, composer.json, pubspec.yaml, pyproject/requirements). No module map. |
| 2 | Symbols, APIs, DB models | Nothing. No parser at runtime (`typescript` is a devDependency only). | Everything: outline extraction, routes, ORM models, migrations. |
| 3 | Dependencies | Nothing. | Package deps (manifests) and internal imports between files/modules. |
| 4 | Code ↔ memory links, stable ids | Graph links connect **entities** extracted from memory text (`memory_graph_*`, migrations 100–102). Kinds are fixed by a CHECK constraint; links: works_on, prefers, decided, part_of, depends_on, replaces, contradicts. `handoff_write` accepts `files` (≤30 paths) but they are not linked. | No code entity, no memory→file/symbol link, none of `implemented_by`, `changed_by`, `caused_by`, `supersedes`, `related_to`. |
| 5 | Search code by meaning | Document index (`memory/docs/`) does hybrid BM25 + cosine over .md/.txt/.pdf only; `docKindOf` blocks code; 500-file cap; heading/paragraph chunking. Memory recall store (`recall-store.ts`) is fast to 10M. | No code chunks; tokenizer does not split identifiers (camelCase, snake_case). |
| 6 | Incremental indexing | Doc indexer: size+mtime skip → sha-256 → per-file transaction, resumable; deletes vanish. `devices/project-copy.ts` already calls `git ls-files` (gitignore-aware list). | Pattern is ready to reuse; code needs edge re-resolution for changed files only. |
| 7 | Nightly code intelligence | Jobs in `memory/jobs.ts` (doctor 02:40, retention 04:00, documents every 20 min, …). Nothing reads git history. | A `code` night job: refresh, link suggestions, "memory may be outdated" checks. |
| 8 | Memory page UI | `MemoryDesktop.tsx`: sidebar places, list + inspector; project view tabs **Memories · Design · Databases · Files**; **Map** (`MemoryMap.tsx`, hand-written SVG force layout, ≤150 nodes); **Needs you**; Settings › Memory › **Documents** (per-project switch, status, "Read again now"). | A Code tab, a code layer on the map, code suggestions in Needs you, a Code pane in Settings, a Code section in the memory inspector. |
| 9 | Storage | SQLite canonical; doc index already keeps chunks + embeddings in SQLite; memory recall index stays in RAM (S7). | New tables; the code index must be rebuildable from files at any time. |
| 10 | MCP exposure | Bridge tools: project_brief, pinned_facts, latest_handoff, memory_search, project_design, memory_propose, handoff_write (+ contract verbs). | `code_search`, `code_symbol`, `code_related`; a short architecture section in `project_brief`. |

Conclusion: about 40% can be reused (walker, hash/incremental pipeline, hybrid search, jobs, per-project
switches, Map, Needs you, bridge). The parser, the code tables, the links and the UI are new.

---

## 2. Architecture

### 2.1 Principles
- **Separate, rebuildable code index.** Deleting it loses nothing that cannot be rebuilt from the files.
  Only the **links** (memory ↔ code) are canonical data, because people approve them.
- **No model call per search, none per file.** Parsing is static; embeddings use the embedding model
  already in use (qwen3-embedding:0.6b) on short symbol cards, at index time only.
- **Opt-in per project, default OFF.** Unlike documents, code may hold secrets and is large. Turning a
  project on is the owner's explicit OK to store its code index on disk (in the spirit of S7);
  turning it off deletes that index.
- **Low RAM.** Symbols live in SQLite; the in-memory search part is loaded per open project and dropped
  when idle (same idea as the recall store, with a smaller cap).

### 2.2 Parsing: two steps
1. **Phase 1 — outline extractors without new packages.** One small extractor per language, line- and
   bracket-aware (it skips strings and comments), producing declarations, imports and framework facts:
   - **TS/JS**: import/export, class/interface/type/enum/function/const arrow, React components, Fastify/Express/Hono routes (`app.get('/x'`), Next.js `app/**/route.ts` and pages, Prisma `schema.prisma` models, Drizzle/Knex tables.
   - **PHP/Laravel**: namespace/use, class/trait/interface/function, `Route::get|post|resource` in `routes/*.php`, Eloquent models (`extends Model`, `$table`, relations `hasMany`…), migrations (`Schema::create('t'`), controllers.
   - **Python**: import, class/def (decorators), FastAPI/Flask/Django routes, SQLAlchemy/Django models, Alembic migrations.
   - **Dart/Flutter**: import/part, class/mixin/extension/enum, widgets (`extends StatelessWidget|StatefulWidget`), GoRouter/Navigator routes, pubspec dependencies, Drift/Floor tables.
   - **Manifests**: package.json, composer.json, pyproject.toml / requirements*.txt, pubspec.yaml → languages, frameworks (by known dependency names), scripts, versions.
   Expected quality: almost all top-level declarations, imports and routes; nested and dynamic code is weaker.
2. **Phase 6 — optional upgrade to tree-sitter (WASM)**, for exact ranges and call edges. This needs new
   packages (`web-tree-sitter` + grammars, MIT); **ask the owner first** (licence check).

### 2.3 Stable ids
- `file id` = hash(owner, project slug, relative path).
- `symbol id` = hash(owner, project slug, relative path, kind, qualified name). It does not depend on line
  numbers, so edits inside a function keep the id.
- **Moves/renames**: a symbol that vanished while one with the same `body_hash` appeared elsewhere is a
  move; its links follow it and get a "moved from …" note. A symbol that is really gone keeps its links,
  marked `missing`, and appears in Needs you (not silently deleted).

### 2.4 Tables (one migration)
```
code_index_sources  (id, owner_id, slug, enabled, state, revision, roots JSON, languages JSON,
                     frameworks JSON, file_count, symbol_count, bytes, last_full_at, last_run_at, error)
code_files          (id, source_id, rel_path, lang, size, mtime_ms, file_hash, status ok|skipped|unreadable,
                     skip_reason, module)
code_symbols        (id, source_id, file_id, kind, name, qualified, signature, start_line, end_line,
                     exported, doc, body_hash, lex, embedding_vec, embedding_model)
                     kind: module|class|interface|type|function|method|component|widget|route|model|table|migration|config
code_edges          (source_id, from_id, to_id NULL, to_name, kind)
                     kind: imports|extends|implements|calls|routes_to|uses_table|depends_on_package
memory_code_links   (id, owner_id, memory_id, target_kind file|symbol|module|package, target_id,
                     target_label, relation, status active|pending|rejected|missing,
                     origin manual|agent|handoff|git|night, confidence, note, created_at, decided_at)
                     relation: implemented_by|depends_on|related_to|changed_by|caused_by|supersedes
code_agent_access   (owner_id, slug, agent_id, level exists|outline|read)   -- like memory_project_db_access
```
Why a separate `memory_code_links` table instead of new graph entity kinds: the graph CHECK constraint, the
12-links-per-memory cap and the 150-node map cap are tuned for people/projects/topics; a repository has
thousands of symbols. The Map still shows code (2.8) by reading these tables.

### 2.5 Search by meaning
- A **symbol card** is embedded, not the whole body: path · kind · qualified name · signature · doc
  comment · first ~12 lines. Small vectors per symbol, cheap to re-embed.
- **Hybrid** like memory recall: BM25 over identifier-split words (`buildContextQuery` → `build context
  query`; `recall_store` → `recall store`) + cosine, the same 0.75/0.25 weighting, then boosts for exported
  symbols, routes/models and the project open in the chat.
- Exact path or name queries (`recall-store.ts`, `agentChange`) short-circuit to a name lookup.
- Results are scoped to the projects the asker may see, and to the agent's access level.

### 2.6 Incremental indexing
- File list: `git ls-files -co --exclude-standard` when the folder is a git repository (respects
  .gitignore), else the doc-index walker. Always skip: node_modules, vendor, build outputs, lockfiles,
  minified or generated files (very long lines, `.min.`, "generated" headers), binaries, `.env*`, key files,
  files over 512 KB.
- size+mtime → sha-256 → re-parse only changed files, in one transaction per file; then re-resolve edges
  that point **into** changed files. Deleted files mark their symbols gone (2.3).
- Triggers: the 60-second discovery watch tick, the end of a chat turn in which an agent edited files,
  "Index again now", and the night job. First full index runs in the background, resumable.

### 2.7 Night learning (job `code`, 02:10, rule-based)
1. Refresh stale sources.
2. **Link suggestions** (status `pending`, they wait in Needs you):
   - a memory names a file, symbol, route or table that exists → `related_to`;
   - a handoff lists `files` → `changed_by`;
   - git commits since the last run (only when the owner allows reading git history): a commit message
     that matches a memory about a bug or decision → `caused_by` / `changed_by` on the touched files.
3. **"May be outdated"**: a memory says the project uses X (a package, table, route), and the code no
   longer has X → a Needs you card "this memory may be outdated", with the evidence. It is never changed
   automatically.
4. A short report line for the Code tab: "Last night: 12 links suggested · 3 memories may be outdated ·
   41 files re-indexed".
An optional local-model module summary (one per module, capped) can come later; off by default.

### 2.8 MCP and agent tools
- `code_search(query, project?, kind?, limit)` → symbols with path:line, signature, why it matched.
- `code_symbol(id | path[:name])` → outline, edges in/out, linked memories.
- `code_related(memory_id | symbol_id)` → links both ways.
- `project_brief` gains a short **Architecture** section: languages, frameworks, main modules, entry
  points, routes/models count. It is capped so the brief stays small.
- Agents propose links with `memory_propose`-style calls → pending, never active without the owner
  (same rule as graph links).

### 2.9 Privacy and safety
- Opt-in per project; turning it off deletes the index and keeps the approved links as `missing`
  (so the owner does not lose decisions).
- The same redaction as documents runs on symbol cards; secrets never enter the index.
- Agent access per project: **exists** (only that a codebase is there) · **outline** (symbols, routes,
  models) · **read** (code lines, asks each time). Default: outline for the owner's own agents.

---

## 3. Memory page UI plan (fits the existing design)

The spec lists six tabs (Overview, Explorer, Related Memories, Graph, Night Learning, Index Management).
Proposal: **do not add a second app or six new top-level tabs.** Place each where the Memory page
already puts that kind of thing:

| Spec tab | Where it goes | Reuses |
|---|---|---|
| Overview | Project view › new **Code** tab, top part | the Databases tab layout (M33) |
| Explorer | Code tab › tree (modules → files → symbols) + inspector on the right | list + inspector pattern |
| Related Memories | Code tab › "Memories" side of the inspector; and a **Code** section in each memory's inspector (both directions) | memory inspector |
| Graph | **Map** (⋯ › Show the map) with a "Code" layer switch: modules first, open one to see its key symbols | `MemoryMap.tsx` force layout, 150-node cap |
| Night Learning | **Needs you** › group "Code" (link suggestions, may-be-outdated) + one report line in the Code tab | Needs you (M24 rule: new links wait there) |
| Index Management | **Settings › Memory › Code** (copy of the Documents pane) | `MemoryDocuments.tsx` |

### 3.1 Project view › Code tab
Tabs become **Memories · Design · Databases · Code · Files**. The Code tab shows only when the project
has a folder.
- **Not indexed yet**: one card — "Girru can learn this project's code: languages, modules, routes and
  models, so agents find the right file and memories link to code. Stored on this computer." Button
  **Turn on for this project** (the explicit OK) · link "What is stored".
- **Indexed** — header: languages as chips (TypeScript 72% · PHP 20% …), frameworks (Fastify, React,
  Laravel), counts (1,240 files · 9,800 symbols · 64 routes · 31 models), "Indexed 3 min ago", health
  dot. Report line from the night job.
- Search box **"Search code by meaning"** (Enter = search; results replace the tree; Esc returns).
- Left: tree. Module → file → symbol, with kind icons and counts; filters: All · Routes · Models · Components.
- Right inspector for the selected symbol/file: signature, path:line with **Open in editor**, edges
  ("used by 6 · imports 4"), **Memories** linked (relation chip, origin, approve/reject when pending),
  **Link a memory…**.
- Empty and error states: "Indexing… 420 / 1,240 files" with progress; "Some files were skipped (12)"
  → list with reasons.

### 3.2 Memory inspector › Code section
Below the memory text: "Code" with linked files/symbols (relation chip: implemented by, changed by…),
pending suggestions with ✓ / ✕, and **Link to code…** (a picker with code search). A missing target
shows "no longer in the code" in grey.

### 3.3 Map › Code layer
A switch in the map header: People · Projects · Topics · **Code**. Code nodes are modules (size =
symbols), edges = imports between modules and links to memories/people/projects. Clicking a module
opens its key symbols around it (still ≤150 nodes). The right panel is the same inspector as 3.1.

### 3.4 Needs you › Code
Cards grouped by project: "Link suggested: memory 'Recall store keeps itself in step by id' →
implemented by `recall-store.ts`" [Link] [Not related]; "May be outdated: 'Falcon uses MariaDB' — the
code now has ClickHouse (docker-compose.yml, src/db.ts)" [Open memory] [Still true].

### 3.5 Settings › Memory › Code
One row per project (like Documents): switch, status line, languages detected, folders read, files /
symbols / size on disk, **Index again now**, **Delete index**, excludes (extra patterns), "Read git
history at night" switch, agent access level per agent (exists / outline / read).

### 3.6 Design work before code
Boards for the shared canvas "Girru designs — all in one place", page Memory, following the house
workflow (control map, decisions, design check, status NEW → waits for OK → APPROVED):
- **MC1** Code tab — not indexed / indexing / indexed overview
- **MC2** Code tab — explorer tree + symbol inspector + search results
- **MC3** Memory inspector — Code section + link picker
- **MC4** Map — Code layer
- **MC5** Needs you — Code suggestions and may-be-outdated
- **MC6** Settings › Memory › Code
The Memory page is also being changed by the Mac session (MR1–MR9); boards and code are coordinated with
it so the two do not edit `MemoryDesktop.tsx` at the same time.

---

## 3b. Automatic Project Discovery & Memory Mapping

Goal: when Girru sees a folder with real code (and often AI-agent Markdown such as AGENTS.md / CLAUDE.md),
it recognises it as a **possible** project, works out whether it is a project, a part of a larger one, a
library or an experiment, and **suggests** it. Nothing is indexed before the owner confirms.

### What exists
`discovery/service.ts` already walks only the folders the owner works on or allowed (`known` + `allow`,
with excludes), finds CLAUDE / AGENTS / GEMINI / HANDOFF / DECISIONS … notes anywhere in a project,
assigns each to its git root (else the nearest known project), and offers them as import items; it also
finds design, databases, skills and MCP servers per root. Projects themselves come from `chat_projects`.
So discovery knows *roots* and *notes*, but it does not score a folder as a project, detect a monorepo,
or classify module / library / experiment.

### Score, not a single file
Signals per folder (weights are a starting point, tuned on the owner's real folders):

| Signal | Examples | Weight |
|---|---|---|
| Manifest | package.json (with name + scripts), composer.json, pubspec.yaml, pyproject.toml, requirements*.txt | +3 |
| Git root | `.git` here (not only above) | +3 |
| Code structure | src/, app/, lib/, routes/, ≥ 20 code files | +2 |
| AI-agent files | AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules, copilot-instructions | +2 |
| Design & decisions | docs/, ARCHITECTURE.md, decisions/, DESIGN.md | +1 |
| Recent activity | commits or edits in the last 90 days | +1 |
| Already used | a chat or coding app was opened here | +3 |
| Against | inside node_modules/vendor; a `examples/`, `samples/`, `tmp/`, `playground/` name; no manifest and < 5 code files | −3 |

Bands: ≥ 8 high (suggested at once), 5–7 medium (suggested, marked "check"), < 5 not suggested.

### Project, part, library or experiment
- **Monorepo / one system**: one git root holding several manifests — npm/pnpm/yarn workspaces, `pnpm-workspace.yaml`, turbo/nx, composer path repositories, `melos.yaml` (Flutter), or e.g. `backend/` (Laravel) + `app/` (Flutter) + `dashboard/` (React). Girru suggests **one project with parts**, not three projects. The parts are shown with their own language and framework, and how they connect (2.5 below).
- **Part (module)**: a folder with a manifest inside a git root that is already a project → a part of that project.
- **Library**: a manifest with `main`/`exports` or a published name and no app entry point (no routes, screens, `main.dart`) → "library", which can be linked to the projects that depend on it.
- **Experiment**: low score, an experiment-like name, or no activity for a long time → not suggested; the owner can still add it.

### AI files are sources, not facts
AGENTS.md / CLAUDE.md / GEMINI.md are read as **knowledge sources** with provenance. Instructions in them are not
followed, and claims in them ("we use PostgreSQL") are not saved as facts by themselves. They become
suggestions in Needs you, and the code is the check: a claim the code contradicts is shown as "file says X,
code shows Y".

### The card (Needs you › Projects, and the Discovery screen)
```
Project discovered                                         High confidence
Girru  ·  C:\MAMP\htdocs\dpro\agent_player
TypeScript · Node.js · SQLite · Ollama          parts: backend · core-ui · desktop
✓ Source code   ✓ Git   ✓ Agent instructions   ✓ Documentation
Girru can build an architecture map, index the important code, and suggest links to existing memories.
[Add as project]   [Part of …]   [Not a project]   Why this?
```
"Why this?" lists the signals and their weights. "Not a project" is remembered (like ignored discovery items).

### What we take from Floorplan (MIT, Claude Code / Codex plugin)
Floorplan finds repos, parses code with dependency-free Node scripts, matches frontend requests to backend
endpoints (also across repos), lays out a zoomable map (app → part → file group → file → endpoint), and
updates only what changed. It uses an LLM to name the parts and describe files and endpoints, and it writes a
static `floorplan/` HTML + `architecture.json`.

| Idea | In Girru |
|---|---|
| Zoom levels: system → part → file group → file → endpoint | The Map's Code layer (3.3) and the Code tab tree (3.1) use the same levels |
| Frontend request ↔ backend endpoint matching, across repos | New edge kind `calls_endpoint`: a `fetch('/api/x')` / Dio / axios / Http call matched to a route; this connects the parts of a monorepo |
| Screens traced to requests, server code and data | Code tab filter "Screens": a screen → its requests → routes → models/tables |
| Recent work view | "Recent changes" in the Code tab, from the incremental index and handoffs (`changed_by`) |
| Health check (exposed keys, open endpoints) | Night job findings in Needs you: a key in code, a route without auth middleware — reported, never changed |
| Blueprint from a spec | Later: planned parts from a plan/handoff shown dashed, linked to their memories |

What Girru does differently:
- **The map is linked to memory and history**: decisions, handoffs, fixes and replaced facts sit on the
  parts they are about, with when and why. Floorplan maps the code; Girru maps the code and what was learned about it.
- **No model call per file or per search.** Names come from manifests, folders and the code. A local model
  may write short part descriptions at night, capped and optional.
- **One map, in the app**: the existing Map and Code tab, not a second static page. Nothing is written into the
  project folder unless the owner turns on "Write project files".
- No code is copied from Floorplan; we take the ideas only.

---

## 4. Phases

| Phase | Content | Size |
|---|---|---|
| P0 | Languages, frameworks, manifests into project-tech (shown on the Code tab header) | small |
| P0b | Project discovery score, monorepo/part/library/experiment, the "Project discovered" card, AI files as sources | medium |
| P1 | Code tables + outline extractors (TS/JS, PHP/Laravel, Python, Dart/Flutter) + incremental indexer + Settings › Code + Code tab overview/explorer | large |
| P2 | Search by meaning (cards, identifier tokenizer, hybrid) + agent tool + MCP tools + brief section | medium |
| P3 | memory_code_links + both-way UI (Code tab, memory inspector, link picker) | medium |
| P4 | Night job: suggestions, may-be-outdated, report line, Needs you | medium |
| P5 | Map code layer | small–medium |
| P6 | (optional, needs package OK) tree-sitter WASM for exact ranges and call edges | medium |

## 5. Benchmarks and acceptance

Measured on this repository (agent_player) and one Laravel and one Flutter project of the owner:
- First full index of 5,000 files: outline < 60 s; embeddings in the background, resumable.
- One changed file → index current < 300 ms (without embedding), < 2 s with.
- `code_search` p50 < 50 ms, p95 < 150 ms at 200k symbols; extra RAM < 300 MB with the largest project open.
- **Code accuracy test** (like the memory accuracy test): 300 questions ("where is the recall store built",
  "which route saves a handoff", Arabic and English), Recall@5 ≥ 0.85, exact-symbol top-1 ≥ 0.9.
- Link suggestions: precision ≥ 0.8 on owner-reviewed samples; zero links active without approval.
- Privacy tests: off → index deleted; `.env`/keys never indexed; agent with `exists` level gets no symbols.

## 6. Decisions for the owner

1. Placement: Code tab + Map layer + Needs you + Settings (this plan) **or** six separate tabs as in the spec?
2. Default **off** per project (turning it on = OK to store the code index on disk)?
3. Phase 1 without new packages (outline extractors); tree-sitter later only after a package OK?
4. May the night job read **git history** (commit messages + touched files), per project switch?
5. First test project: agent_player itself, then which Laravel and Flutter projects?
6. Design boards MC1–MC6 on the shared canvas first, coordinated with the Mac session — OK?
7. Project discovery: suggest high-confidence projects at once and medium ones marked "check" — or always ask for both?
8. A monorepo becomes one project with parts (default), with "split into separate projects" as an option?
9. Which parts of the Floorplan ideas first: request ↔ endpoint matching and zoom levels (proposed), then screens and the health check?
