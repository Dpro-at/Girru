/**
 * The MCP tools and the result-card rendering.
 *
 *   spawn_small_agent  { task, kind?, tools?, drawers?, max_steps?, read_dir? } -> run id (+ what was granted)
 *   get_result         { run_id, wait_seconds? }                     -> result card
 *   list_runs          { status?, limit? }                           -> runs + capacity (queue length)
 *   list_handoffs      { agent_id?, kind?, project_id?, limit? }     -> newest handoff note of every chat / board task
 *   read_handoff       { kind, scope_id, agent_id }                  -> the note + its history
 *   edit_handoff       { kind, scope_id, agent_id, done?, left?, next?, questions? } -> a new version
 *                      (source "owner"); the agent's next session starts from it
 *
 * The handoff tools use the owner-only /api/handoffs routes (CORE-MEM-HANDOFF):
 * a session that is not the owner account gets 403, like the small-agent tools.
 *
 * Every tool returns a short Markdown text for the model to read, the same
 * data as JSON text, and `structuredContent` (the JSON object).
 */

import { BackendError, type BackendClient } from './backend.js';

export const KINDS = ['lookup', 'summary', 'classification', 'draft', 'other'] as const;
export const HANDOFF_KINDS = ['conversation', 'task'] as const;
const HANDOFF_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const handoffList = (what: string) => ({ type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 }, description: `${what} (up to 8 short lines; replaces the list)` });
export const STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'waiting_approval']);
const RUN_ID = /^[0-9a-f-]{36}$/i;

const RULE_OPS=['list','effective','versions','files','suggest'];
/** RULES-01: an MCP agent runs with the owner's session, so rule changes and decisions on suggestions stay in the app (an agent never accepts its own suggestion). */
const RULES_REFUSED='Adding, changing, pausing, deleting rules and using or dismissing a suggestion are done by the owner in Agents \u203a Rules. This tool reads (list, effective, versions) and suggests.';
const TASK_OPS=['list','get','activity','continue','sort','people','checklist','schedule'];
/** TASKLOG-01: turning a project's task file on or off, and moving or editing cards, stay with the owner in the app. */
const TASKS_REFUSED='Turning a project\u2019s task file on or off is done by the owner in Agents \u203a Rules (the files sheet); moving, editing and archiving cards is done on the Board. This tool reads tasks (list, get, activity) and, on the owner\u2019s instruction, continues one, sends one waiting in To sort to a department, puts people or agents on it, adds, ticks or gives checklist items, and sets how it repeats.';
const FOOTER_IDS=['chat','agents','library','board','memory','approvals','store','genvr','terminal','code','skills','personalities','specialties'];

export const TOOL_DEFINITIONS = [
  {
    name:'meetings',title:'Department meetings',
    description:'Owner-session only. Read meetings, departments and paged participants. On the owner’s explicit instruction create a meeting with selected departments, all departments, heads only or exact agents; invitations do not start any model call. Edit draft decisions only while the owner is reviewing the meeting. Starting speaking rounds, media capture, approving decisions and creating their tasks are performed by the owner in the app and are not offered by this tool. Never claim a task exists until a saved card id is returned by the meeting.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','read','departments','participants','create','draft']},id:{type:'string',maxLength:64},query:{type:'string',maxLength:100},offset:{type:'integer',minimum:0,maximum:1000000},body:{type:'object'}},required:['operation'],additionalProperties:false},
  },
  {
    name:'workspace_settings',title:'Portable workspace settings',
    description:'Owner-session only. Export selected agents, personalities, specialties and Markdown skills, or preview a supplied JSON pack. Keys, accounts, conversations and memories are excluded. Import requires the owner’s explicit instruction after reviewing the preview, its fingerprint and confirmed=true. Imports copies with safe permissions; retry the same file after an uncertain result. Never automatically import or share a file externally.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['export','preview','import']},body:{type:'object'}},required:['operation','body'],additionalProperties:false},
  },
  {
    name:'trading_practice',title:'Local paper trading practice',
    description:'Owner-session only. Read/start/end an isolated in-memory practice session, place a fictional buy/sell, run one manual practice bot step, or stop that bot. Fixed fictional prices and virtual money only; no provider, saved account or background trading. A write requires the owner’s explicit instruction. Reuse requestId when retrying an uncertain order or step.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['read','start','order','step','stop','end']},sessionId:{type:'string',maxLength:36},requestId:{type:'string',maxLength:36},symbol:{type:'string',enum:['DEMO-ALPHA','DEMO-BETA','DEMO-GAMMA']},side:{type:'string',enum:['buy','sell']},quantity:{type:'integer',minimum:1,maximum:100}},required:['operation'],additionalProperties:false},
  },

  {
    name:'workspace_apps',title:'Workspace applications',
    description:'Owner-session only. The Store section of the Girru window has My apps first (installed apps only: Terminal, Trading, Code, GenVR, apps added from the Girru Store and private apps added from a folder) and then Find more (Girru\u2019s catalogue \u2014 the apps that come with Girru, then its registry \u2014 and the add-ons in coding apps). To browse the Store, open an app\u2019s page, add or remove one, use workspace_store. MCP connections, Channels and Accounts are places in Settings, not in Apps. list: My apps, with the MCP connections listed apart (Settings \u203a MCP connections). store: the older catalogue view (catalogue and add-ons, read only); catalogue reads the catalogue; addons reads the Claude Code and Codex plugins (in the window: Settings \u203a Models and replies \u203a N plugins; read only). MCP connections (Settings \u203a MCP connections): read one (its tools and which agents may use them), add one disabled, or turn one off; found lists MCP servers the folder scan found on this computer (names, place and state only; read only); look finds connections set up in coding apps on this computer (Claude, Codex; nothing there changes), preview reads one found there (scanId, sourceId) and gives its hash, import adds it with that hash. Writes (add, import, disable) require the owner\u2019s explicit instruction. A new or imported connection is always off: adding does not execute a program or grant tools. A coding-app connection with secrets (env or headers) is not imported here; the owner adds it in the app. Adding what the folder scan found is done by the owner in the app (it asks where its key goes). Tell the owner to turn it on and choose agents in Settings \u203a MCP connections; turning on (program startup approval), choosing agents, secrets and permanent removal are done by the owner in the app. Also read only: channels (Settings \u203a Channels: chat channels and who may write), accounts (Settings \u203a Accounts: linked accounts such as GenVR); keys, tokens and codes are never returned. Turning a channel on or off, its keys, who may write, GenVR connect, disconnect and publish stay with the owner in the app; this tool refuses them.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','store','read','add','disable','found','look','preview','import','channels','accounts','addons','catalogue']},id:{type:'string',maxLength:36},scanId:{type:'string',maxLength:36},sourceId:{type:'string',maxLength:36},hash:{type:'string',maxLength:64},connection:{type:'object',properties:{name:{type:'string',maxLength:24},description:{type:'string',maxLength:500},transport:{type:'string',enum:['http','sse','stdio']},url:{type:'string',maxLength:2000},command:{type:'string',maxLength:500},args:{type:'array',maxItems:50,items:{type:'string',maxLength:1000}},allowRemote:{type:'boolean'}},additionalProperties:false}},required:['operation'],additionalProperties:false},
  },

  {
    name:'workspace_store',title:'Store',
    description:'Owner-session only. The Store section, the same as the owner sees it. mine: My apps, the apps on this computer (built in, added from the Girru Store, private = added by the owner from a folder; private apps are never listed in the Store). Find more: one list of the apps that come with Girru, the Girru Store (github.com/Dpro-at/girru-store, shown from its last copy when there is no internet), Girru\u2019s registry and the Claude Code and Codex add-ons copied on this computer. home: the featured app, the collections and the categories. search (optional query, kind app/mcp/skill/specialty, category, source girru/claude-code/codex, limit 1–100 (default 40) and after (the next value of the previous page) to page through long lists; the same kinds as the Store sidebar and the same category row): present true = only what is on this computer, e.g. source claude-code + present true lists the Claude Code add-ons turned on here, the Store\u2019s \u201cOn this computer\u201d place; matching items in one line each with where they come from and their state (included = comes with Girru, installed, available, elsewhere = added in that coding app itself). app (id): one item\u2019s page: what it does, what it asks for, maker, version. updates: installed apps with a newer version. Adding an app is always done by the owner in the app (Store \u203a the app \u203a Get, which shows what it asks for); install is refused here, and so is add_private (adding a private app from a folder runs code nobody reviewed, so only the owner does it: Store \u203a My apps \u203a More \u203a Add an app from a folder): tell the owner what the app asks for and where to add it. uninstall (id) removes an app added from the Girru Store, Girru\u2019s registry or a folder (private:<id> from mine), only on the owner\u2019s explicit instruction; it can be added again from the Store. An app that keeps data of its own is refused here: removing it (Girru saves a copy of its data first) is done by the owner in the Store. A removed or added Store app finishes when Girru starts again. Apps that come with Girru are already in My apps; coding-app add-ons are added in that app itself. There are no ratings, install counts or prices: every item is free.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['mine','home','search','app','updates','install','add_private','uninstall']},id:{type:'string',maxLength:320},query:{type:'string',maxLength:120},kind:{type:'string',enum:['app','mcp','skill','specialty']},category:{type:'string',maxLength:40},source:{type:'string',enum:['girru','claude-code','codex']},present:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:100},after:{type:'integer',minimum:0}},required:['operation'],additionalProperties:false},
  },
  {
    name:'agents',title:'Agents (read only)',
    description:'Owner-session only. Read: list (every agent: name, role, department, specialty, model and provider name, main agent, description), read (one agent, id), permissions (what one agent may do: memory and action modes), departments (each department with its agents; the same as Settings › Departments). Departments, only on the owner\u2019s explicit instruction: rename_department (from, to: every agent in it moves) and set_department (id, department; null for none: moves one agent). A department is lowercase letters, digits, spaces, - or _, at most 64. Org chart: org (who reports to whom: each agent with its manager, how it got there — main, set by the owner, placed by Girru, or a sub-agent — and its sub-agents), sub_agents (id: the sub-agents of one agent), sub_agent_work (id: work it gave its sub-agents and quick helpers). Only on the owner\u2019s explicit instruction: set_reports_to (id, reportsTo: an agent id, or null to let Girru place it; the main agent stays on top, a sub-agent stays with its agent, no circles) and add_sub_agent (id of its agent, name, startsAs copy | empty, description, tools: only tools its agent has and none that needs approval; others are added by the owner in the app). Files (agent page \u203a Files): files (id: its files — Who it is, What it keeps in mind, Knowledge — with which ones it reads) and file (id, name: What it keeps in mind or a Knowledge file; secrets hidden; Who it is stays in the app). Only on the owner\u2019s explicit instruction: write_file (id, name, content) creates or replaces a Knowledge file (.md .txt .csv .json, up to 1 MB); it is not read into answers until the owner turns it on in the app. Who it is and What it keeps in mind are changed by the owner in the app. How the owner sees the team: chart (read: List or Chart, arranged by who reports to whom or by department, line style, zoom) and set_chart (view, mode, lines, zoom) on the owner\u2019s instruction. Keys, credential ids and system prompts are never returned. Hiring (FIRSTRUN-01): setup_tools (which coding tools — Claude Code, Codex, Gemini CLI — are installed and signed in on this computer, with the command the owner would run; nothing is run), suggest_team (total, departments: how Girru would split that many agents over those departments; nothing is saved) and propose_hire (name?, department, role?, description: a proposal to show the owner in your reply). An agent only proposes; the owner hires in the app (Agents › Hire, or ⋯ › Plan a bigger company). Renaming an agent, role, main agent, duplicate, hire and remove are done by the owner in the app (so are removing a sub-agent or a file, stopping work and the quick helper switch); this tool refuses them.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','read','permissions','departments','rename_department','set_department','org','sub_agents','sub_agent_work','set_reports_to','add_sub_agent','files','file','write_file','chart','set_chart','setup_tools','suggest_team','propose_hire']},total:{type:'integer',minimum:1,maximum:1000},departments:{type:'array',maxItems:72,items:{type:'string',maxLength:64}},role:{type:'string',enum:['manager','specialist','evaluator']},id:{type:'string',maxLength:128,description:'agent id'},from:{type:'string',maxLength:64},to:{type:'string',maxLength:64},department:{type:['string','null'],maxLength:64},reportsTo:{type:['string','null'],maxLength:128},name:{type:'string',maxLength:60},startsAs:{type:'string',enum:['copy','empty']},description:{type:'string',maxLength:1000},tools:{type:'array',maxItems:100,items:{type:'string',maxLength:64}},content:{type:'string',maxLength:1048576},view:{type:'string',enum:['list','chart']},mode:{type:'string',enum:['reports','departments']},lines:{type:'string',enum:['elbow','curved','straight']},zoom:{type:'number',minimum:0.3,maximum:1.6}},required:['operation'],additionalProperties:false},
  },
  {
    name:'chats',title:'Chats (the chat sidebar)',
    description:'Owner-session only. The chat sidebar: list (every chat: id, name, project, pinned, archived, opened from another chat, working now, approvals waiting for the owner), projects (each project with its folder). Only on the owner\u2019s explicit instruction: rename (id, title), pin (id, pinned), archive (id, archived: false brings it back), move (id, projectId; null = no project), set_mode (id, mode: auto, ask or plan \u2014 Accept edits is looser and only the owner sets it in the app), set_thinking (id, thinking: quick, normal or deep). Project variables show by name only (variables, projectId). Read one chat\u2019s side panel: status (id: tokens by model, the agents it handed work to, its schedule). Read a project\u2019s pull request on GitHub: pull_request (projectId: number, title, state open/merged/closed/draft, checks passing/pending/failing; read-only, a minute old at most). The side panel\u2019s layout for the owner (the same in every chat): panel (read: order of its parts, folded parts, diff one column or side by side) and, only on the owner\u2019s explicit instruction, set_panel (order, folded: lists of place, team, results, memory, mcp, each once; diff: unified = One column, split = Side by side; give only what changes). Schedules are changed by the owner in the app. Messages, deleting chats, variable values and the owner\u2019s sidebar layout are not available here.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','projects','rename','pin','archive','move','set_mode','set_thinking','variables','status','pull_request','panel','set_panel']},id:{type:'string',maxLength:64,description:'chat id'},title:{type:'string',maxLength:120},pinned:{type:'boolean'},archived:{type:'boolean'},projectId:{type:['string','null'],maxLength:64},mode:{type:'string',enum:['auto','ask','plan']},thinking:{type:'string',enum:['quick','normal','deep']},order:{type:'array',maxItems:5,uniqueItems:true,items:{type:'string',enum:['place','team','results','memory','mcp']},description:'side panel parts, top first (set_panel)'},folded:{type:'array',maxItems:5,uniqueItems:true,items:{type:'string',enum:['place','team','results','memory','mcp']},description:'side panel parts shown folded (set_panel)'},diff:{type:'string',enum:['unified','split'],description:'Changes pane: unified = One column, split = Side by side (set_panel)'}},required:['operation'],additionalProperties:false},
  },
  {
    name:'workspace_approvals',title:'Approvals (read only)',
    description:'Owner-session only, read only. waiting: requests waiting for the owner. history: past requests (optional status or agentId). permissions: What agents may do (all agents, or one with agentId). rules: approval rules (reviewer policies; optional cursor). coverage: tools and whether a rule or approval covers them. Codes, hashes and secrets are never returned. Approving, allowing, rejecting, voting, changing a waiting hand-off\u2019s task (Change the task\u2026), changing or turning off rules and changing permissions are done by the owner in the app; this tool refuses them.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['waiting','history','permissions','rules','coverage']},status:{type:'string',enum:['pending','approved','denied','executed','failed','expired']},agentId:{type:'string',maxLength:100},cursor:{type:'string',maxLength:36}},required:['operation'],additionalProperties:false},
  },

  {
    name:'workspace_rules',title:'Rules agents follow',
    description:'Owner-session only. The owner\u2019s rules for how agents work (Agents \u203a Rules). Read: list (every rule in the order agents get them — the ones that come with Girru first, safety ones always on — paused ones marked, and suggestions waiting), files (projectId: whether the project\u2019s coding app files — .girru/rules.md, the @ line in CLAUDE.md and GEMINI.md, the rules part of AGENTS.md — are up to date), effective (agentId, projectId?: the exact list that agent gets there, the later one wins), versions (id). suggest (text, when?, reason?, projectId?, who?, targets?): propose a rule (when = the one case it applies in; leave out for always); it waits for the owner. Adding, changing, pausing, deleting rules, deciding suggestions and writing the files stay with the owner in the app. who is all, departments (targets = department names) or agents (targets = agent ids); projectId null = everywhere.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:RULE_OPS},id:{type:'string',maxLength:36},text:{type:'string',maxLength:2000},when:{type:['string','null'],maxLength:300},reason:{type:'string',maxLength:500},projectId:{type:['string','null'],maxLength:64},who:{type:'string',enum:['all','departments','agents']},targets:{type:'array',maxItems:50,items:{type:'string',maxLength:120}},agentId:{type:'string',maxLength:120}},required:['operation'],additionalProperties:false},
  },
  {
    name:'workspace_tasks',title:'Project task files',
    description:'Owner-session only. The tasks of each project\u2019s task file (.girru/tasks.md): one file per project that every agent and coding app (Claude Code, Codex, Gemini) reads and writes, shown on the Board on the right department board with its agent. list (projectId?: every open and finished task with its number, title, state, department, agent, the apps that worked on it, its board and card, and a line to fix if its block breaks the format; plus lines of the file that belong to no task), get (boardId, cardId: one task\u2019s Done, Left, Next, who worked on it and its last log lines). Only on the owner\u2019s explicit instruction: continue (boardId, cardId, agentId?, model?: a new chat in the project where that agent \u2014 and app, e.g. subscription:codex \u2014 continues the task from the file), sort (boardId, cardId, department: a task waiting in To sort goes to that department\u2019s board with its lead, written back to the file), people (boardId, cardId, kind user|agent, id, role asked|does|checks|tests, or null to take them off), checklist (boardId, cardId and text to add an item; or itemId with done to tick it, or with ownerKind+ownerId to give it to a person or agent), schedule (boardId, cardId alone reads how the task repeats; with every hourly|daily|weekly|never, at HH:MM, weekday 0-6 for weekly, agentId, model, paused it sets it \u2014 each run continues the task as that agent and app). activity (boardId, cardId) reads the task page: people and agents, sub-tasks, links, release, chats, tokens spent, files changed, and the story \u2014 moves, comments, replies of its chats with the files each changed, the task file log. Work on a task by editing its block in the file (keep the format; add a Log line with your app name and your app to Worked on by). '+TASKS_REFUSED,
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:TASK_OPS},projectId:{type:'string',maxLength:64},boardId:{type:'string',maxLength:64},cardId:{type:'string',maxLength:64},agentId:{type:'string',maxLength:128},model:{type:'string',maxLength:100},department:{type:'string',maxLength:64},kind:{type:'string',enum:['user','agent']},id:{type:'string',maxLength:128},role:{type:['string','null'],enum:['asked','does','checks','tests',null]},text:{type:'string',maxLength:300},itemId:{type:'string',maxLength:64},done:{type:'boolean'},ownerKind:{type:'string',enum:['user','agent']},ownerId:{type:'string',maxLength:128},every:{type:'string',enum:['hourly','daily','weekly','never']},at:{type:'string',maxLength:5},weekday:{type:'integer',minimum:0,maximum:6},paused:{type:'boolean'}},required:['operation'],additionalProperties:false},
  },
  {
    name:'workspace_footer',title:'Footer sections',
    description:'Owner-session only. Read or change which sections the Girru window footer shows, their order, icons only, and whether Approvals comes back when something waits. Sections: chat, agents, library (Personalities, Specialties and Skills), board, memory, approvals, apps, store, genvr, terminal, code, skills, personalities, specialties. MCP connections, channels, accounts and departments are places in Settings, not footer sections. Settings always stays and cannot be hidden; hidden sections stay in the command box (⌘K). Change only when the owner asks. The open window picks the change up when it is next focused.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['read','set']},order:{type:'array',maxItems:13,items:{type:'string',enum:FOOTER_IDS}},hidden:{type:'array',maxItems:13,items:{type:'string',enum:FOOTER_IDS}},iconsOnly:{type:'boolean'},approvalsWhenWaiting:{type:'boolean'}},required:['operation'],additionalProperties:false},
  },
  {
    name:'account_settings',title:'Account security and updates',
    description:'Owner-session only. Read: two_step (is two-step sign-in on, how many recovery codes are left), devices (every device signed in to this account, newest first, with an id), updates (version, branch and how many updates wait, from what was last downloaded; reading never goes online). Write only on the owner\u2019s explicit instruction: sign_out_device (id from devices; that device must sign in again, agents keep working) and check_updates (looks online once with git fetch; at most every 30 seconds). Installing an update stays the `agent-player update --stop` command the owner runs in a terminal. Turning two-step sign-in on or off and making new recovery codes need the owner\u2019s password and authenticator code, so the owner does them in Settings › Account; never ask for them.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['two_step','devices','sign_out_device','updates','check_updates']},id:{type:'string',maxLength:24}},required:['operation'],additionalProperties:false},
  },
  {
    name:'workspace_backups',title:'Backups',
    description:'Owner-session only. Girru backs up the whole data folder by itself every day at 03:00 (or on waking after it) and before every update, to a folder outside the data folder that only the owner can open; it keeps 14 days and 4 Sundays. status reads it: the folder, when the next one runs, the last one and whether it passed its check, a failure if the last try failed, and the list. Only on the owner\u2019s explicit instruction: back_up_now (one backup now; kind before_update before you update Girru). Restoring a backup replaces the owner\u2019s data, so the owner does it in Settings \u203a Backups; this tool never restores, deletes or moves backups.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['status','back_up_now']},kind:{type:'string',enum:['manual','before_update']}},required:['operation'],additionalProperties:false},
  },
  {
    name:'skill_library',title:'Skill library',
    description:'Owner-session only. Skills are written guidance (Markdown); they never grant tools, connections or memory. Read: list (with which agents use each skill), read (a skill\u2019s files), agent (one agent\u2019s skills), catalogue (Girru\u2019s official catalogue, read only), found (skills the folder scan found on this computer: names, place and state only), look + look_status (find skill packages from coding apps on this computer; nothing there changes), preview (read a found package before adding). Write only on the owner\u2019s explicit instruction: add (a new package from look, after preview, with its hash; it stays unassigned and changes no agent). Giving a skill to an agent, taking it back and updating an installed copy change what agents follow, so the owner does them in the app after its review; this tool refuses them. Adding from Girru\u2019s catalogue needs the owner\u2019s authenticator code, so it is done by the owner in the app only. Adding what the folder scan found is done by the owner in the app. Removing a skill from Girru is not available.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','read','agent','catalogue','found','look','look_status','preview','add']},id:{type:'string',maxLength:36,description:'skill id'},agentId:{type:'string',maxLength:128},scanId:{type:'string',maxLength:36},sourceId:{type:'string',maxLength:36},hash:{type:'string',maxLength:64}},required:['operation'],additionalProperties:false},
  },
  {
    name:'personality_library', title:'Personality library',
    description:'Owner-session only. Read profiles, team balance, versions and manual exams; create or edit, preview linked changes, assign, archive or mix personalities. A write requires the owner’s explicit instruction. A linked change (one that updates other agents) can only be previewed here; the owner confirms it in the app. Approving drift, approving or declining (Yes/No) an agent\u2019s suggestion and unlocking are owner-only in the app; proposals/proposal read the suggestions. Personality grants no tools or permissions. Use operation read/list/team/versions/exams/save/preview/assign/archive/blend/assess/try. list marks shipped personalities (starter) and names the agents that have each; team gives each agent’s personality, follow setting, lock and version (use that version as expectedVersion to give/assign). For save supply revision and profile in body; a personality agents follow needs the owner’s review in the app.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','read','team','versions','exams','save','preview','assign','archive','blend','assess','try','assignment','tune','mode','agentCurrent','agentVersions','lock','unlock','restore','proposals','proposal']},id:{type:'string',maxLength:128},proposalId:{type:'string',maxLength:36},body:{type:'object'}},required:['operation'],additionalProperties:false},
  },

  {
    name:'specialty_library', title:'Specialty library',
    description:'Owner-session only. Source updates: update_prepare_review (body: sourceKey, resourceId: a bundled skill id or bindings) previews skill preparation; only the owner confirms skill writes inside the app, never through this tool. updates lists known installed updates; update_review (body: sourceKey) returns the exact changes and affected agents. Only after the owner explicitly approves those changes, update_apply (body: sourceKey, reviewToken, confirmed=true) saves that single content revision with the same owner gates as the app. Never confirm on behalf of the owner or automatically retry a lost apply response; read Versions instead. Configuration, tool grants and agent links are preserved. The jobs (specialties) agents can have. Read: list, read, catalogue (skills and tools a job may ask for), agents (who has it and their real access), assigned (one agent\'s specialties), impact, versions (the live version and earlier ones), version (one earlier version in full: id + revision; to restore it, save its text over the live revision). draft (body = description, departments?: your local model writes a first draft of a new specialty from a few lines; local model only, nothing is saved — check it, then save it with revision 0 and a new uuid id). Write only on the owner\'s explicit instruction: save a draft (body = name, department, description, instructions, config, revision; revision 0 with a new uuid id makes a new specialty; a coming-soon (planned) specialty is filled the same way, with its own id and revision 0, once it has instructions — then it is a normal, ready specialty), preview the change, hire a new agent linked to it (body: templateId, revision, requestId, name?, libraryPersonality?, confirmed=true after the owner checked the job; reuse requestId when retrying so only one agent is made). Giving a specialty to existing agents or taking it back, an ordinary save that updates agents who already have the job ("Update N agents"), and consent to sensitive actions are done by the owner in the app. The sole source-update exception is update_apply: it may update linked agents only after the owner sees update_review’s exact changes and affected-agent list and explicitly approves them. Specialties never grant tools or permissions.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['list','read','catalogue','agents','assigned','impact','versions','version','draft','preview','save','hire','updates','update_review','update_apply','update_prepare_review']},id:{type:'string',maxLength:36},revision:{type:'integer',minimum:1},agentId:{type:'string',maxLength:128},body:{type:'object'}},required:['operation'],additionalProperties:false},
  },

  {
    name: 'spawn_small_agent',
    title: 'Delegate a light task to the small local agent',
    description: [
      'Hand ONE light, self-contained task to the Girru small local agent (local Qwen model; free, private, slower and less capable than you).',
      'Good for: lookups in Girru memory/storage, summaries of text you pass in, classification/tagging, first drafts.',
      'Not for: code changes, security decisions, anything that sends, pays, deletes, installs or runs commands (the small agent has no such tools), or tasks needing deep reasoning.',
      'Returns a run id at once; fetch the result card with get_result. Outputs marked needs_review must be checked by you before use.',
      'The small agent only gets read-only tools (memory_search, storage_search, read, memory_graph) and only the memory drawers you name; delegation never adds permissions.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 8000, description: 'The complete task, with all text the agent needs (it cannot see your context).' },
        kind: { type: 'string', enum: [...KINDS], description: 'lookup | summary | classification are informational; draft and other always need review. Default other.' },
        tools: {
          type: 'array', maxItems: 20, items: { type: 'string' },
          description: 'Tools the agent may use; only memory_search, storage_search, read and memory_graph (people/projects/links in memory) can be granted. Default: memory_search + storage_search.',
        },
        drawers: {
          type: 'array', maxItems: 14, items: { type: 'string' },
          description: 'Memory drawers to open, e.g. "owner", "experience", "project:alpha", "task:<id>", "people:<id>". Default: none (no memory).',
        },
        max_steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Step budget (model + tool calls). Default and upper limit 15.' },
        read_dir: {
          type: 'string', maxLength: 1024,
          description: 'Absolute directory the "read" tool may read (only with tools including "read"; must be inside a folder the owner allowed with SMALL_AGENT_READ_ROOTS on the backend, otherwise refused; never the Girru backend, data, config or credential folders; .env, keys, tokens and databases stay blocked). Default: the small agent\'s own workspace.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_result',
    title: 'Result card of a small-agent run',
    description: 'Get the result card of a small-agent run: status, summary, outputs, steps used, duration, model, needs_review and warnings. Optionally wait up to 60 s for it to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id returned by spawn_small_agent.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 60, description: 'Wait up to this many seconds for the run to finish (default 0).' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_runs',
    title: 'List small-agent runs and capacity',
    description: 'List recent small-agent runs and the current capacity (active, running, queued, waiting, limit, free slots). New spawns are refused while all slots are busy.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_handoffs',
    title: 'List agent handoff notes',
    description: 'Owner only. The newest done / left / next note of every chat and board task, per agent, newest first. Read one in full with read_handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', maxLength: 128, description: 'Only this agent\'s notes.' },
        kind: { type: 'string', enum: [...HANDOFF_KINDS], description: 'conversation (a saved chat) or task (a board task).' },
        project_id: { type: 'string', maxLength: 128, description: 'Only notes of chats in this chat project.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_handoff',
    title: 'Read one handoff note and its history',
    description: 'Owner only. The current handoff note of one agent for one chat or board task, with every earlier version.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...HANDOFF_KINDS] },
        scope_id: { type: 'string', maxLength: 128, description: 'The conversation id or the board task id.' },
        agent_id: { type: 'string', maxLength: 128 },
      },
      required: ['kind', 'scope_id', 'agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_handoff',
    title: 'Edit a handoff note (as the owner)',
    description: 'Owner only. Save a corrected done / left / next note for one agent in one chat or board task. It is kept as a new version (the old one stays in the history) and the agent\'s next session starts from it. Lists you leave out stay as they are; never put keys, passwords or tokens in a note.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...HANDOFF_KINDS] },
        scope_id: { type: 'string', maxLength: 128 },
        agent_id: { type: 'string', maxLength: 128 },
        done: handoffList('What is finished'),
        left: handoffList('What is still open'),
        next: handoffList('The next steps'),
        questions: handoffList('Open questions for the owner'),
      },
      required: ['kind', 'scope_id', 'agent_id'],
      additionalProperties: false,
    },
  },
] as const;

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class InputError extends Error {}

function ok(markdown: string, data: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: markdown }, { type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string, data?: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: message }], ...(data ? { structuredContent: data } : {}), isError: true };
}

function obj(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new InputError('arguments must be an object');
  return args as Record<string, unknown>;
}

function only(args: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new InputError(`unknown argument "${k}"`);
}

function intIn(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InputError(`${name} must be an integer from ${min} to ${max}`);
  return v;
}

function strList(v: unknown, name: string, max: number): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
    throw new InputError(`${name} must be a list of at most ${max} names`);
  }
  return v as string[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ms = (n: unknown) => (typeof n === 'number' ? (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`) : '?');

export function renderCard(card: any): string {
  const lines = [
    `### Small agent: ${card.status}${card.needs_review ? ' (needs review)' : ''}`,
    '',
    `**Summary:** ${card.summary || '(none)'}`,
    '',
    `- run: \`${card.run_id}\` (${card.kind})`,
    `- model: ${card.model}`,
    `- steps: ${card.steps_used}/${card.max_steps}, time: ${ms(card.duration_ms)} of ${ms(card.max_duration_ms)}`,
    `- tools granted: ${card.tools_granted?.length ? card.tools_granted.join(', ') : 'none'}; used: ${card.tools_used?.length ? card.tools_used.join(', ') : 'none'}`,
    `- memory drawers: ${card.drawers?.length ? card.drawers.join(', ') : 'none'}`,
    ...(card.read_dir ? [`- read directory: ${card.read_dir}`] : []),
    `- needs_review: ${card.needs_review}${card.review_reason ? ` (${card.review_reason})` : ''}`,
  ];
  if (card.warnings?.length) {
    lines.push('', '**Warnings:**', ...card.warnings.map((w: string) => `- ${w}`));
  }
  if (card.outputs?.length) {
    lines.push('', '**Output:**', '', ...card.outputs.map((o: any) => String(o.text ?? '')));
  }
  if (card.needs_review) {
    lines.push('', '_Check this output before you rely on it or pass it on._');
  }
  return lines.join('\n');
}

function capacityLine(c: any): string {
  return `capacity: ${c.active}/${c.limit} active (running ${c.running}, queued ${c.queued}, waiting ${c.waiting}), ${c.available} free`;
}

function renderList(runs: any[], capacity: any): string {
  const lines = [`### Small-agent runs`, '', capacityLine(capacity), ''];
  if (!runs.length) lines.push('No runs.');
  for (const r of runs) {
    lines.push(`- \`${r.run_id}\` ${r.status} (${r.kind}), steps ${r.steps_used}/${r.max_steps}, created ${r.created_at}${r.summary ? `: ${r.summary}` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

export interface HandlerDeps { backend: BackendClient; pollMs?: number }

export async function callTool(name: string, rawArgs: unknown, deps: HandlerDeps): Promise<ToolCallResult> {
  try {
    const args = obj(rawArgs);
    switch (name) {
      case 'workspace_settings': return await workspaceSettingsTool(args,deps);
      case 'trading_practice': return await tradingPracticeTool(args,deps);
      case 'workspace_apps': return await workspaceAppsTool(args,deps);
      case 'workspace_store': return await workspaceStoreTool(args,deps);
      case 'agents': return await agentsTool(args,deps);
      case 'workspace_approvals': return await workspaceApprovalsTool(args,deps);
      case 'workspace_rules': return await workspaceRulesTool(args,deps);
      case 'workspace_tasks': return await workspaceTasksTool(args,deps);
      case 'chats': return await chatsTool(args,deps);
      case 'meetings': return await meetingsTool(args,deps);
      case 'workspace_footer': return await workspaceFooterTool(args,deps);
      case 'account_settings': return await accountSettingsTool(args,deps);
      case 'workspace_backups': return await workspaceBackupsTool(args,deps);
      case 'skill_library': return await skillLibraryTool(args,deps);
      case 'personality_library': return await personalityLibraryTool(args,deps);
      case 'specialty_library': return await specialtyLibraryTool(args,deps);
      case 'spawn_small_agent': return await spawn(args, deps);
      case 'get_result': return await getResult(args, deps);
      case 'list_runs': return await list(args, deps);
      case 'list_handoffs': return await listHandoffs(args, deps);
      case 'read_handoff': return await readHandoff(args, deps);
      case 'edit_handoff': return await editHandoff(args, deps);
      default: return fail(`Unknown tool "${name}"`);
    }
  } catch (err) {
    if (err instanceof InputError) return fail(`Invalid arguments: ${err.message}`);
    if (err instanceof BackendError) {
      if (err.status === 429 && err.data?.capacity) {
        return fail(`The small agent is busy (${capacityLine(err.data.capacity)}). Do the task yourself or try again after a run finishes.`, { refused: 'capacity', capacity: err.data.capacity });
      }
      return fail(err.message);
    }
    return fail('Unexpected error in the Girru MCP server.');
  }
}

async function spawn(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['task', 'kind', 'tools', 'drawers', 'max_steps', 'read_dir']);
  if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 8000) throw new InputError('task must be a non-empty string of at most 8000 characters');
  if (args.kind !== undefined && !(KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${KINDS.join(', ')}`);
  const body: Record<string, unknown> = { task: args.task };
  if (args.kind !== undefined) body.kind = args.kind;
  const tools = strList(args.tools, 'tools', 20);
  if (tools) body.tools = tools;
  const drawers = strList(args.drawers, 'drawers', 14);
  if (drawers) body.drawers = drawers;
  const maxSteps = intIn(args.max_steps, 'max_steps', 1, 100);
  if (maxSteps !== undefined) body.max_steps = maxSteps;
  if (args.read_dir !== undefined) {
    if (typeof args.read_dir !== 'string' || !args.read_dir.trim() || args.read_dir.length > 1024) throw new InputError('read_dir must be an absolute directory path');
    body.read_dir = args.read_dir;
  }

  const res = await backend.request('POST', '/api/small-agent/runs', body);
  const data = {
    run_id: res.run_id,
    status: res.status,
    kind: res.kind,
    granted_tools: res.granted_tools ?? [],
    drawers: res.drawers ?? [],
    read_dir: res.read_dir ?? null,
    budget: res.budget,
    model: res.model,
    warnings: res.warnings ?? [],
    capacity: res.capacity,
  };
  const md = [
    `Small agent started: run \`${data.run_id}\` (${data.kind}, model ${data.model}).`,
    `Tools: ${data.granted_tools.length ? data.granted_tools.join(', ') : 'none'}; drawers: ${data.drawers.length ? data.drawers.join(', ') : 'none'}; budget ${data.budget?.max_steps} steps / ${ms(data.budget?.max_duration_ms)}.`,
    ...(data.warnings.length ? ['Warnings:', ...data.warnings.map((w: string) => `- ${w}`)] : []),
    `Call get_result with run_id "${data.run_id}" (wait_seconds up to 60) for the result card.`,
  ].join('\n');
  return ok(md, data);
}

async function getResult(args: Record<string, unknown>, { backend, pollMs = 1000 }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['run_id', 'wait_seconds']);
  if (typeof args.run_id !== 'string' || !RUN_ID.test(args.run_id)) throw new InputError('run_id must be a run id from spawn_small_agent');
  const wait = intIn(args.wait_seconds, 'wait_seconds', 0, 60) ?? 0;
  const end = Date.now() + wait * 1000;
  let card: any;
  for (;;) {
    card = (await backend.request('GET', `/api/small-agent/runs/${encodeURIComponent(args.run_id)}`)).card;
    if (FINAL.has(card?.status) || Date.now() >= end) break;
    await sleep(Math.min(pollMs, Math.max(0, end - Date.now())));
  }
  return ok(renderCard(card), card);
}

async function list(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['status', 'limit']);
  if (args.status !== undefined && !(STATUSES as readonly unknown[]).includes(args.status)) throw new InputError(`status must be one of ${STATUSES.join(', ')}`);
  const limit = intIn(args.limit, 'limit', 1, 100);
  const q = new URLSearchParams();
  if (args.status) q.set('status', String(args.status));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  const res = await backend.request('GET', `/api/small-agent/runs${qs ? `?${qs}` : ''}`);
  const capacity = { ...res.capacity, queue_length: (res.capacity?.queued ?? 0) + (res.capacity?.waiting ?? 0) };
  const data = { runs: res.runs ?? [], capacity };
  return ok(renderList(data.runs, capacity), data);
}

// ---------------------------------------------------------------------------
// Handoff notes (owner only)
// ---------------------------------------------------------------------------

function handoffTarget(args: Record<string, unknown>): { kind: string; scopeId: string; agentId: string } {
  if (!(HANDOFF_KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${HANDOFF_KINDS.join(', ')}`);
  if (typeof args.scope_id !== 'string' || !HANDOFF_SCOPE.test(args.scope_id)) throw new InputError('scope_id must be a conversation or board task id');
  if (typeof args.agent_id !== 'string' || !AGENT_ID.test(args.agent_id)) throw new InputError('agent_id must be an agent id');
  return { kind: args.kind as string, scopeId: args.scope_id, agentId: args.agent_id };
}

const handoffPath = (t: { kind: string; scopeId: string }) => `/api/handoffs/${encodeURIComponent(t.kind)}/${encodeURIComponent(t.scopeId)}`;

function renderHandoff(h: any): string {
  if (!h) return 'No handoff note yet.';
  const section = (title: string, items: unknown) => (Array.isArray(items) && items.length ? [`**${title}:**`, ...items.map((i) => `- ${String(i)}`)] : []);
  return [
    `### Handoff: ${h.agentName ?? h.agentId} — ${h.kind} \`${h.scopeId}\` (version ${h.version}, ${h.source}, ${h.createdAt})`,
    ...section('Done', h.done), ...section('Left', h.left), ...section('Next', h.next), ...section('Open questions', h.questions),
  ].join('\n');
}

async function listHandoffs(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['agent_id', 'kind', 'project_id', 'limit']);
  if (args.agent_id !== undefined && (typeof args.agent_id !== 'string' || !AGENT_ID.test(args.agent_id))) throw new InputError('agent_id must be an agent id');
  if (args.project_id !== undefined && (typeof args.project_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args.project_id))) throw new InputError('project_id must be a chat project id');
  if (args.kind !== undefined && !(HANDOFF_KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${HANDOFF_KINDS.join(', ')}`);
  const limit = intIn(args.limit, 'limit', 1, 200);
  const q = new URLSearchParams();
  if (args.agent_id) q.set('agentId', String(args.agent_id));
  if (args.kind) q.set('kind', String(args.kind));
  if (args.project_id) q.set('projectId', String(args.project_id));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  const res = await backend.request('GET', `/api/handoffs${qs ? `?${qs}` : ''}`);
  const handoffs = Array.isArray(res?.handoffs) ? res.handoffs : [];
  const md = handoffs.length
    ? ['### Handoff notes', '', ...handoffs.map((h: any) => `- ${h.agentName ?? h.agentId} — ${h.kind} ${h.title ? `"${h.title}" ` : ''}\`${h.scopeId}\` v${h.version} (${h.createdAt}): ${Array.isArray(h.next) && h.next.length ? `next: ${h.next[0]}` : `${(h.done ?? []).length} done, ${(h.left ?? []).length} left`}`)].join('\n')
    : 'No handoff notes yet.';
  return ok(md, { handoffs });
}

async function readHandoff(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['kind', 'scope_id', 'agent_id']);
  const t = handoffTarget(args);
  const res = await backend.request('GET', `${handoffPath(t)}?agentId=${encodeURIComponent(t.agentId)}`);
  const history = Array.isArray(res?.history) ? res.history : [];
  return ok([renderHandoff(res?.handoff ?? null), ...(history.length > 1 ? ['', `${history.length - 1} earlier version(s).`] : [])].join('\n'), { handoff: res?.handoff ?? null, history });
}

async function editHandoff(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['kind', 'scope_id', 'agent_id', 'done', 'left', 'next', 'questions']);
  const t = handoffTarget(args);
  const body: Record<string, unknown> = { agentId: t.agentId };
  for (const k of ['done', 'left', 'next', 'questions'] as const) {
    if (args[k] === undefined) continue;
    const v = args[k];
    if (!Array.isArray(v) || v.length > 8 || !v.every((x) => typeof x === 'string' && x.length <= 300)) throw new InputError(`${k} must be a list of at most 8 short lines`);
    body[k] = v;
  }
  if (Object.keys(body).length === 1) throw new InputError('give at least one of done, left, next, questions');
  // Lists left out keep their current text.
  const current = (await backend.request('GET', `${handoffPath(t)}?agentId=${encodeURIComponent(t.agentId)}`))?.handoff;
  for (const k of ['done', 'left', 'next', 'questions'] as const) if (body[k] === undefined && Array.isArray(current?.[k])) body[k] = current[k];
  const res = await backend.request('PUT', handoffPath(t), body);
  return ok(`Saved as version ${res?.handoff?.version ?? '?'}. The agent's next session starts from it.\n\n${renderHandoff(res?.handoff)}`, { handoff: res?.handoff ?? null });
}

/** "Found on this computer" (the same folder scan as Memory), read only: names, place and state.
 *  File paths, file text and secret values are left out; adding what was found stays with the owner in the app. */
const FOUND_STATE:Record<string,string>={new:'new',changed:'changed since it was added',decision:'needs the owner\u2019s decision',imported:'in Girru',gone:'gone from this computer'};
const FOUND_REFUSED='Adding what the folder scan found is done by the owner in the app (Found on this computer / This computer); it may ask where a key goes. This tool only lists it (operation found).';
async function foundOnComputer(backend:BackendClient,kind:'skill'|'mcp'){
 const view=obj(await backend.request('GET','/api/memory/import/discovery'));
 const roots=(Array.isArray(view.roots)?view.roots:[]).filter(record);
 const place=(id:unknown)=>{const r=roots.find(x=>x.id===id);return typeof r?.name==='string'&&r.name?r.name.slice(0,120):'This computer';};
 const items=(Array.isArray(view.items)?view.items:[]).filter(record).filter(i=>i.kind===kind&&i.state!=='ignored'&&Object.hasOwn(FOUND_STATE,String(i.state))).slice(0,500).map(i=>({name:String(i.name??'').slice(0,200),place:place(i.rootId),state:FOUND_STATE[String(i.state)]}));
 return {items,scannedAt:typeof view.scannedAt==='string'?view.scannedAt:null};
}
const SKILL_ID=/^[a-f0-9-]{36}$/,SKILL_HASH=/^[a-f0-9]{64}$/,SKILL_AGENT=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
async function skillLibraryTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const base='/api/skill-library',operation=args.operation;
 const need=(key:string,pattern:RegExp,what:string)=>{const v=args[key];if(typeof v!=='string'||!pattern.test(v)||v.includes('..'))throw new InputError(`A valid ${what} is required`);return v;};
 const agentId=()=>{const v=need('agentId',SKILL_AGENT,'agentId');if(v==='small-local-agent')throw new InputError('The small local agent has no skills');return v;};
 const note='A skill is guidance only; it never grants tools, connections or memory.';
 switch(operation){
  case 'list':{only(args,['operation']);const list=await backend.request('GET',base);let usage:unknown=null;try{usage=(await backend.request('GET',base+'/usage'))?.usage??null;}catch{usage=null;}return ok(`Skills in Girru. ${note}`,{skills:list?.skills??[],usage});}
  case 'read':{only(args,['operation','id']);return ok(`Skill files (Markdown only). ${note}`,await backend.request('GET',`${base}/items/${need('id',SKILL_ID,'skill id')}`));}
  case 'agent':{only(args,['operation','agentId']);return ok('Skills this agent has.',await backend.request('GET',`${base}/agents/${agentId()}`));}
  case 'found':{only(args,['operation']);return ok('Skills the folder scan found on this computer (read only; names, place and state). The owner adds them in the app.',await foundOnComputer(backend,'skill'));}
  case 'add_found':case 'import_found':throw new InputError(FOUND_REFUSED);
  case 'catalogue':{only(args,['operation']);return ok('Girru\u2019s official catalogue (read only). Adding from it needs the owner\u2019s authenticator code in the app.',await backend.request('GET','/api/skills/reviewed-installs/catalogue'));}
  case 'look':{only(args,['operation']);return ok('Looking for skill packages from coding apps on this computer. Nothing there changes. Call look_status with the scan id.',await backend.request('POST',base+'/scan',{}));}
  case 'look_status':{only(args,['operation','scanId']);return ok('Skill packages found so far.',await backend.request('GET',`${base}/scans/${need('scanId',SKILL_ID,'scanId')}`));}
  case 'preview':{only(args,['operation','scanId','sourceId']);return ok('The package files as they would be added (secrets hidden; scripts and links left out). existing shows whether Girru has a copy.',await backend.request('POST',base+'/preview',{scanId:need('scanId',SKILL_ID,'scanId'),sourceId:need('sourceId',SKILL_ID,'sourceId')}));}
  // Changes to what agents follow stay with the owner in the app (same as specialties): MCP can only add an unassigned skill.
  case 'give':case 'take_back':case 'update':throw new InputError('Giving, taking back and updating a skill change what agents follow; the owner does them in the app after its review');
  case 'add':{only(args,['operation','scanId','sourceId','hash']);return ok('Added to Girru. It stays unassigned until the owner gives it to an agent.',await backend.request('POST',base+'/import',{scanId:need('scanId',SKILL_ID,'scanId'),sourceId:need('sourceId',SKILL_ID,'sourceId'),hash:need('hash',SKILL_HASH,'hash')}));}
  default:throw new InputError('Unknown operation. Adding from Girru\u2019s catalogue is done by the owner in the app (it needs the authenticator code)');
 }
}

async function personalityLibraryTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','id','proposalId','body']);
 const operation=args.operation;
 if(typeof operation!=='string')throw new InputError('operation is required');
 const base='/api/personality-library';
 const routes:Record<string,{method:'GET'|'POST'|'PUT';suffix:string;id?:boolean}>={list:{method:'GET',suffix:''},team:{method:'GET',suffix:'/team'},read:{method:'GET',suffix:'',id:true},versions:{method:'GET',suffix:'/versions',id:true},exams:{method:'GET',suffix:'/exams',id:true},save:{method:'PUT',suffix:'',id:true},preview:{method:'POST',suffix:'/preview',id:true},archive:{method:'POST',suffix:'/archive',id:true},blend:{method:'POST',suffix:'/blend'},assess:{method:'POST',suffix:'/exams',id:true},assignment:{method:'GET',suffix:'',id:true},mode:{method:'POST',suffix:'/mode',id:true},tune:{method:'POST',suffix:'/tune',id:true},agentCurrent:{method:'GET',suffix:'/personality/current',id:true},agentVersions:{method:'GET',suffix:'/personality/versions',id:true},lock:{method:'POST',suffix:'/personality/lock',id:true},unlock:{method:'POST',suffix:'/personality/unlock',id:true},proposals:{method:'GET',suffix:'/personality/proposals',id:true},proposal:{method:'GET',suffix:'/personality/proposals',id:true},approve:{method:'POST',suffix:'/personality/proposals',id:true},reject:{method:'POST',suffix:'/personality/proposals',id:true},restore:{method:'POST',suffix:'/personality/rollback',id:true},assign:{method:'POST',suffix:'',id:true},try:{method:'POST',suffix:'/try',id:true}};
 const route=routes[operation];if(!Object.hasOwn(routes,operation)||!route)throw new InputError('Unknown operation');
 if(route.id&&(typeof args.id!=='string'||!(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/).test(args.id)))throw new InputError('Valid id required');
 if(route.method==='GET'&&args.body!==undefined)throw new InputError('Read operations do not accept a body');
 // Owner review stays in the app: an MCP caller may preview a linked change but never confirm it, approve drift or lift a lock.
 if(operation==='approve'||operation==='reject')throw new InputError('Approving or declining a suggestion is done by the owner in the app');
 if(operation==='unlock')throw new InputError('Approving drift and unlocking are done by the owner in the app');
 if(args.body&&typeof args.body==='object'&&Object.hasOwn(args.body,'confirmation'))throw new InputError('Linked changes are confirmed by the owner in the app; use preview to show the impact');
 const agentOperation=['agentCurrent','agentVersions','lock','unlock','restore','proposals','proposal','approve','reject'].includes(operation);
 const proposalOperation=['proposal','approve','reject'].includes(operation);
 if(proposalOperation&&(typeof args.proposalId!=='string'||!(/^[a-f0-9-]{36}$/).test(args.proposalId)))throw new InputError('A valid proposalId is required');
 const url=(agentOperation?'/api/agents':base)+(['assign','assignment','tune','mode'].includes(operation)?'/assigned/':'/')+(route.id?args.id:'')+route.suffix+(proposalOperation?'/'+args.proposalId+(operation==='proposal'?'':'/'+operation):'');
 const data=await backend.request(route.method,route.id?url:base+route.suffix,route.method==='GET'||['lock','unlock'].includes(operation)?undefined:obj(args.body));
 return ok('Personality library result. Preferences never grant access.',data);
}

async function specialtyLibraryTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','id','agentId','body','revision']);
 const operation=args.operation,base='/api/specialty-templates',uuid=/^[a-f0-9-]{36}$/;
 if(['updates','update_review','update_apply','update_prepare_review'].includes(String(operation))){
  if(args.id!==undefined||args.agentId!==undefined||args.revision!==undefined)throw new InputError('Source updates take only operation and body');
  const route='/api/workspace-pack/specialty-upgrade-';
  if(operation==='updates'){if(args.body!==undefined)throw new InputError('updates takes no body');return ok('Available specialty updates. Nothing changed.',await backend.request('GET',route+'preview'));}
  const b=obj(args.body),fields=operation==='update_review'?['sourceKey']:operation==='update_prepare_review'?['sourceKey','resourceId']:['sourceKey','reviewToken','confirmed'];
  if(Object.keys(b).length!==fields.length||fields.some(k=>!Object.hasOwn(b,k))||typeof b.sourceKey!=='string'||!/^professional-role-[a-f0-9]{24}$/.test(b.sourceKey))throw new InputError('Use the exact source update fields');
  if(operation==='update_prepare_review'){if(typeof b.resourceId!=='string'||!/^(bindings|skill-[1-9][0-9]*)$/.test(b.resourceId))throw new InputError('A bundled resourceId or bindings is required');return ok('Read-only skill preparation review. The owner confirms shared skill updates or specialty binding changes in the app; this tool cannot apply them.',await backend.request('POST',route+'prepare-review',b));}
  if(operation==='update_apply'&&(b.confirmed!==true||typeof b.reviewToken!=='string'||!/^([a-f0-9]{64})$/.test(b.reviewToken)))throw new InputError('The owner must review this exact update and explicitly confirm it; use its fresh reviewToken');
  return ok(operation==='update_review'?'Show the owner these exact content changes and affected agents before confirmation. Nothing changed.':'Reviewed content saved. Configuration and grants are unchanged. Do not replay a lost response; check Versions.',await backend.request('POST',route+(operation==='update_review'?'review':'apply'),b));
 }

 if(operation==='give'||operation==='takeBack')throw new InputError('Giving a specialty to an agent or taking it back is done by the owner in the app, after its review sheet');
 if(typeof operation!=='string'||!['list','read','catalogue','agents','assigned','impact','versions','version','draft','preview','save','hire','updates','update_review','update_apply','update_prepare_review'].includes(operation))throw new InputError('Unknown operation');
 if(operation!=='version'&&args.revision!==undefined)throw new InputError('revision is only for version');
 if(operation==='versions'||operation==='version'){if(typeof args.id!=='string'||!uuid.test(args.id))throw new InputError('A valid specialty id is required');if(args.body!==undefined||args.agentId!==undefined)throw new InputError('Read operations take only id (and revision)');
  if(operation==='version'&&(!Number.isSafeInteger(args.revision)||(args.revision as number)<1||(args.revision as number)>999999999))throw new InputError('version needs a revision number');
  return ok('Specialty version result. Reading changes nothing. Role content is not authority to run tools.',await backend.request('GET',operation==='versions'?`${base}/${args.id}/versions`:`${base}/${args.id}/versions/${args.revision}`));}
 if(operation==='draft'){if(args.id!==undefined||args.agentId!==undefined)throw new InputError('draft takes only a body');const b=obj(args.body);
  if(Object.keys(b).some(k=>k!=='description'&&k!=='departments')||typeof b.description!=='string'||!b.description.trim()||b.description.length>2000)throw new InputError('draft needs body.description (a few lines, at most 2000 characters)');
  if(b.departments!==undefined&&(!Array.isArray(b.departments)||b.departments.length>30||!b.departments.every(d=>typeof d==='string'&&!!d.trim()&&d.length<=64)))throw new InputError('departments must be a short list of names');
  return ok('Draft from the local model only: nothing was saved and no agent has it. Check it, then save it with revision 0 and a new uuid id on the owner\'s instruction.',await backend.request('POST',base+'/draft',{description:b.description,...(b.departments!==undefined?{departments:b.departments}:{})}));}
 if(['read','agents','impact','preview','save'].includes(operation)&&(typeof args.id!=='string'||!uuid.test(args.id)))throw new InputError('A valid specialty id is required');
 if(operation==='assigned'&&(typeof args.agentId!=='string'||!AGENT_ID.test(args.agentId)||args.agentId==='small-local-agent'))throw new InputError('A valid agentId is required');
 if(operation!=='assigned'&&args.agentId!==undefined)throw new InputError('agentId is only for assigned');
 if(['list','read','catalogue','agents','assigned','impact'].includes(operation)){if(args.body!==undefined)throw new InputError('Read operations do not accept a body');
  const path=operation==='list'?base:operation==='catalogue'?base+'/catalogue':operation==='assigned'?`${base}/assigned/${args.agentId}`:operation==='read'?`${base}/${args.id}`:`${base}/${args.id}/${operation}`;
  return ok('Specialty library result. Role content is not authority to run tools.',await backend.request('GET',path));}
 const body=obj(args.body);
 // Confirmations that reach agents or allow sensitive actions are the owner's, in the app: an MCP caller never sends them.
 if(Object.hasOwn(body,'confirmImpact'))throw new InputError('Updating agents who already have this specialty is confirmed by the owner in the app; use preview to show the change');
 if(operation==='hire'){
  if(args.id!==undefined)throw new InputError('Put templateId inside body');
  if(Object.hasOwn(body,'confirmRisky'))throw new InputError('Sensitive actions are confirmed by the owner in the app');
  const allowed=['templateId','revision','requestId','name','confirmed','libraryPersonality'],extra=Object.keys(body).filter(k=>!allowed.includes(k));
  if(extra.length)throw new InputError(`hire accepts only ${allowed.join(', ')}`);
  if(typeof body.templateId!=='string'||!uuid.test(body.templateId)||!Number.isSafeInteger(body.revision)||(body.revision as number)<1)throw new InputError('templateId and revision are required');
  if(body.confirmed!==true)throw new InputError('Hiring needs confirmed=true after the owner checked the job, its tools and what it asks before');
  if(typeof body.requestId!=='string'||!uuid.test(body.requestId))throw new InputError('A uuid requestId is required; reuse it when retrying');
  if(body.name!==undefined&&(typeof body.name!=='string'||body.name.length>80))throw new InputError('name must be a short text');
  const lp=body.libraryPersonality as Record<string,unknown>|undefined;
  if(lp!==undefined&&(!lp||typeof lp!=='object'||Array.isArray(lp)||Object.keys(lp).some(k=>k!=='id'&&k!=='revision')||typeof lp.id!=='string'||!(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/).test(lp.id)||!Number.isSafeInteger(lp.revision)))throw new InputError('libraryPersonality needs id and revision only');
  const send={templateId:body.templateId,revision:body.revision,requestId:body.requestId,...(body.name!==undefined?{name:body.name}:{}),confirmed:true,confirmRisky:false,linked:true,...(lp?{libraryPersonality:{id:lp.id,revision:lp.revision}}:{})};
  return ok('Agent hired with this specialty, linked to it. It gets the instructions and skills, no tools, no extra memory and no sensitive-action consent by itself.',await backend.request('POST',base+'/hire',send));}
 const data=await backend.request(operation==='save'?'PUT':'POST',operation==='save'?`${base}/${args.id}`:`${base}/${args.id}/preview`,body);
 return ok(operation==='save'?'Specialty saved. No tool or memory permission changed.':'Preview only: nothing changed. The owner confirms an update for agents in the app.',data);
}

async function workspaceFooterTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','order','hidden','iconsOnly','approvalsWhenWaiting']);
 if(args.operation==='read'){only(args,['operation']);return ok('Footer sections. Settings always stays.',await backend.request('GET','/api/me/footer'));}
 if(args.operation!=='set')throw new InputError('operation must be read or set');
 const change:Record<string,unknown>={};
 for(const k of ['order','hidden'] as const)if(k in args){const v=args[k];if(!Array.isArray(v)||v.length>FOOTER_IDS.length||!v.every(x=>typeof x==='string'&&FOOTER_IDS.includes(x))||new Set(v).size!==v.length)throw new InputError(`${k} must list known sections once each`);change[k]=v;}
 for(const k of ['iconsOnly','approvalsWhenWaiting'] as const)if(k in args){if(typeof args[k]!=='boolean')throw new InputError(`${k} must be true or false`);change[k]=args[k];}
 if(!Object.keys(change).length)throw new InputError('Nothing to change');
 return ok('Footer changed. Settings always stays; hidden sections stay in ⌘K.',await backend.request('PUT','/api/me/footer',change));
}

async function accountSettingsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','id']);
 const op=args.operation;
 if(op!=='sign_out_device')only(args,['operation']);
 if(op==='two_step')return ok('Two-step sign-in. Turning it on or off and new recovery codes are done by the owner in Settings › Account.',await backend.request('GET','/api/auth/verification'));
 if(op==='devices')return ok('Devices signed in to this account (current = this session).',await backend.request('GET','/api/auth/sessions'));
 if(op==='updates')return ok('Updates, from what was last downloaded. Installing is the agent-player update --stop command in a terminal.',await backend.request('GET','/api/system/updates'));
 if(op==='check_updates')return ok('Looked online once (git fetch).',await backend.request('POST','/api/system/updates/check'));
 if(op==='sign_out_device'){
  if(typeof args.id!=='string'||!/^[a-f0-9]{24}$/.test(args.id))throw new InputError('id must be a device id from devices');
  return ok('That device is signed out; it must sign in again.',await backend.request('POST','/api/auth/sessions/'+args.id+'/sign-out'));
 }
 throw new InputError('operation must be two_step, devices, sign_out_device, updates or check_updates');
}

const BACKUPS_REFUSED='Restoring, deleting or moving backups is done by the owner in Settings \u203a Backups. This tool reads the backups (status) and, on the owner\u2019s instruction, makes one now (back_up_now).';
async function workspaceBackupsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 if(args.operation==='status'){only(args,['operation']);return ok('Backups: every day at 03:00 and before every update, kept outside the data folder.',await backend.request('GET','/api/backups'));}
 if(args.operation==='back_up_now'){
  only(args,['operation','kind']);
  if(args.kind!==undefined&&args.kind!=='manual'&&args.kind!=='before_update')throw new InputError('kind must be manual or before_update');
  const r=obj(await backend.request('POST','/api/backups',{kind:args.kind==='before_update'?'before-update':'manual'}));
  return ok(obj(r.backup).checked===false?'Backed up, but a part did not pass its check: tell the owner.':'Backed up and checked.',r);
 }
 throw new InputError(BACKUPS_REFUSED);
}

const record=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const MCP_SCAN=/^[a-f0-9-]{36}$/,MCP_HASH=/^[a-f0-9]{64}$/;
/** My apps and the MCP connections apart, as the window shows them (Apps › My apps, Settings › MCP connections). */
function splitApps(r:unknown){const items=Array.isArray(obj(r).items)?obj(r).items as unknown[]:[],mcp=(x:unknown)=>record(x)&&x.kind==='mcp';return {apps:items.filter(x=>!mcp(x)),mcpConnections:items.filter(mcp)};}
const STORE_ID=/^[a-z0-9][a-z0-9._@:-]{0,319}$/i;
const STORE_ADD_REFUSED='Adding an app is done by the owner in the app: Apps \u203a Store \u203a the app \u203a Get. Tell the owner what it asks for (from app).';
type StoreItem={id:string;kind:string;name:string;summary:string;description:string;source:string;category:string;state:string;maker:string;verified:boolean;version:string|null;updated:string|null;permissions:string[];worksWith:string[];languages:string[];update:string|null;hash:string};
/** The Store (STORE-UI-01): the window's one read, and Add / Remove behind the same hash the Add sheet shows. */
async function workspaceStoreTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const op=args.operation;
 const id=()=>{if(typeof args.id!=='string'||!STORE_ID.test(args.id))throw new InputError('A valid id (from search) is required');return args.id;};
 const read=async():Promise<Record<string,any>&{items:StoreItem[]}>=>{const r=obj(await backend.request('GET','/api/store'));return {...r,items:(Array.isArray(r.items)?r.items:[]).filter(record) as unknown as StoreItem[]};};
 const line=(x:StoreItem)=>({id:x.id,kind:x.kind,name:x.name,summary:x.summary,source:x.source,category:x.category,state:x.state});
 if(op==='mine'){
  // SA6: My apps, the first place of the Store: what is on this computer (MCP connections live in Settings).
  only(args,['operation']);const r=obj(await backend.request('GET','/api/apps'));
  const items=(Array.isArray(r.items)?r.items:[]).filter(record).filter((x:Record<string,any>)=>x.kind!=='mcp').map((x:Record<string,any>)=>({id:x.kind==='added'?`${x.origin==='private'?'private':'store'}:${x.sourceId}`:x.id,name:x.name,kind:x.kind==='added'?(x.origin==='private'?'private app':'added from the Girru Store'):x.kind==='builtin'?'comes with Girru':'account connection',summary:x.summary,removable:x.kind==='added'}));
  return ok(items.length?'My apps: the apps on this computer. Remove an added one with uninstall (id), only on the owner\u2019s explicit instruction.':'No apps yet.',{items});
 }
 if(op==='add_private')throw new InputError('Adding a private app from a folder runs code nobody reviewed, so only the owner does it in the app: Store \u203a My apps \u203a More \u203a Add an app from a folder.');
 if(op==='home'){
  only(args,['operation']);const s=await read(),named=(ids:unknown)=>(Array.isArray(ids)?ids:[]).map(i=>s.items.find(x=>x.id===i)).filter(Boolean).map(x=>line(x!));
  return ok('The Store\u2019s home: the featured app, then collections. Every item is free; there are no ratings or install counts.',{featured:named([s.featured])[0]??null,collections:(Array.isArray(s.collections)?s.collections:[]).filter(record).map((c:Record<string,any>)=>({id:c.id,title:c.title,items:named(c.items)})),categories:s.categories??[],limited:s.limited??[]});
 }
 if(op==='search'){
  only(args,['operation','query','kind','category','source','present','limit','after']);
  const limit=args.limit===undefined?40:Number(args.limit),after=args.after===undefined?0:Number(args.after);
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(after)||after<0)throw new InputError('limit is 1 to 100 and after is a whole number from the previous page');
  if(args.present!==undefined&&typeof args.present!=='boolean')throw new InputError('present must be true or false');
  for(const k of ['query','kind','category','source'] as const)if(args[k]!==undefined&&typeof args[k]!=='string')throw new InputError(`${k} must be text`);
  if(args.kind!==undefined&&!['app','mcp','skill','specialty'].includes(args.kind as string))throw new InputError('kind must be app, mcp, skill or specialty');
  const q=String(args.query??'').trim().toLowerCase(),s=await read();
  const items=s.items.filter(x=>(!args.kind||x.kind===args.kind)&&(!args.category||x.category===args.category)&&(!args.source||x.source===args.source)&&(args.present===undefined||(x as {present?:boolean}).present===args.present)&&(!q||`${x.name} ${x.summary} ${x.maker}`.toLowerCase().includes(q)));
  const page=items.slice(after,after+limit),next=after+limit<items.length?after+limit:null;
  return ok(items.length?`${items.length} in the Store${next!==null?`; showing ${after+1}\u2013${after+page.length}, ask again with after ${next} for more`:''}. Open one with app (id).`:'Nothing in the Store matches.',{items:page.map(line),total:items.length,next});
 }
 if(op==='app'){
  only(args,['operation','id']);const want=id(),x=(await read()).items.find(i=>i.id===want);
  if(!x)throw new InputError('Not in the Store');
  const how=x.state==='included'?'It comes with Girru and is already in My apps.':x.state==='elsewhere'?'Add it in that coding app itself; Girru does not copy its keys.':x.state==='installed'?'Installed. Remove it only on the owner\u2019s explicit instruction.':'The owner adds it in the app: Apps \u203a Store \u203a this app \u203a Get. Tell them what it asks for.';
  const {hash:_,...page}=x;return ok(how,page);
 }
 if(op==='updates'){
  only(args,['operation']);const items=(await read()).items.filter(x=>x.update);
  return ok(items.length?'Installed apps with a newer version.':'Everything is up to date.',{items:items.map(x=>({...line(x),version:x.version,update:x.update}))});
 }
 if(op==='install'){
  // Same gate as the window: only the owner's own click on Add (in the sheet that shows what it asks for) adds an app.
  throw new InputError(STORE_ADD_REFUSED);
 }
 if(op==='uninstall'){
  only(args,['operation','id']);const want=id();
  const r=obj(await backend.request('POST','/api/store/uninstall',{id:want}));
  return ok('Removed. Add it again from the Store at any time.',{id:want,state:r.state??'available'});
 }
 throw new InputError('operation must be mine, home, search, app, updates, install, add_private or uninstall');
}

async function workspaceAppsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','id','connection','scanId','sourceId','hash']);
 const need=(key:string,pattern:RegExp,what:string)=>{const v=args[key];if(typeof v!=='string'||!pattern.test(v))throw new InputError(`A valid ${what} is required`);return v;};
 if(args.operation==='add_found'||args.operation==='import_found')throw new InputError(FOUND_REFUSED);
 if(args.operation==='found'){
  only(args,['operation']);
  return ok('MCP servers the folder scan found on this computer (read only; names, place and state). The owner adds them in the app, where it asks where a key goes.',await foundOnComputer(backend,'mcp'));
 }
 // "My coding apps": look, preview, import. Import is bound to the previewed hash and always lands off.
 if(args.operation==='look'){
  only(args,['operation']);
  const scan=obj(await backend.request('POST','/api/mcp-import/scan',{}));
  const sources=(Array.isArray(scan.sources)?scan.sources:[]).filter(record).map(x=>({id:String(x.id),name:String(x.name??''),origin:String(x.origin??''),supported:x.supported===true,issue:typeof x.issue==='string'?x.issue:null}));
  return ok('Connections set up in coding apps on this computer. Nothing there changes. Call preview with scanId and sourceId.',{id:scan.id??null,skipped:typeof scan.skipped==='number'?scan.skipped:0,sources});
 }
 if(args.operation==='preview'){
  only(args,['operation','scanId','sourceId']);
  const p=obj(await backend.request('POST','/api/mcp-import/preview',{scanId:need('scanId',MCP_SCAN,'scanId'),sourceId:need('sourceId',MCP_SCAN,'sourceId')}));
  const names=(x:unknown)=>Array.isArray(x)?x.filter(v=>typeof v==='string'):[];
  const secretNames=[...names(p.envNames),...names(p.headerNames)];
  return ok(secretNames.length?'It has secrets, so the owner adds it in the app (Settings › MCP connections › My coding apps). Secret values are never shown.':'The connection as it would be added (off). Import it with this hash only on the owner\u2019s explicit instruction.',{name:p.name??null,kind:p.transport==='stdio'?'program':'web',command:p.command??null,args:names(p.args),url:p.url??null,secretNames,hash:p.hash??null,existingId:p.existingId??null,ownerOnly:secretNames.length>0});
 }
 if(args.operation==='import'){
  only(args,['operation','scanId','sourceId','hash']);
  const body={scanId:need('scanId',MCP_SCAN,'scanId'),sourceId:need('sourceId',MCP_SCAN,'sourceId')},hash=need('hash',MCP_HASH,'hash (from preview)');
  // Read it again first: the hash must still match, and a connection with secrets stays with the owner in the app.
  const p=obj(await backend.request('POST','/api/mcp-import/preview',body));
  if(p.hash!==hash)throw new InputError('It changed in that app since the preview. Look and preview it again');
  if((Array.isArray(p.envNames)&&p.envNames.length)||(Array.isArray(p.headerNames)&&p.headerNames.length))throw new InputError('This connection has secrets; the owner adds it in the app (Settings › MCP connections › My coding apps)');
  const r=obj(await backend.request('POST','/api/mcp-import/import',{...body,hash}));
  return ok(r.duplicate===true?'Already in Girru. Nothing was added twice.':'Added off. The owner turns it on and chooses agents in Settings › MCP connections.',{id:r.id??null,duplicate:r.duplicate===true,enabled:false});
 }
 if(typeof args.operation==='string'&&APPS_OWNER_ONLY.has(args.operation))throw new InputError(APPS_REFUSED);
 if(typeof args.operation==='string'&&Object.hasOwn(APPS_READS,args.operation)){
  only(args,['operation']);
  const r=APPS_READS[args.operation as keyof typeof APPS_READS],data:Record<string,unknown>={};
  // included: the apps that come with Girru only, never the MCP connections in the same list.
 for(const [field,path] of r.paths)data[field]=field==='included'?splitApps(scrub(await backend.request('GET',path))).apps:scrub(await backend.request('GET',path));
  return ok(r.note,data);
 }
 if(args.operation==='list'){
  only(args,['operation']);
  return ok('My apps (installed apps). MCP connections are listed apart: they live in Settings \u203a MCP connections. Reading this list does not connect or grant access.',splitApps(await backend.request('GET','/api/apps')));
 }
 if(args.operation==='disable'){
  only(args,['operation','id']);
  if(typeof args.id!=='string'||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(args.id))throw new InputError('A valid connection id is required');
  await backend.request('POST','/api/mcp/servers/'+args.id+'/disable');
  return ok('Connection turned off.',splitApps(await backend.request('GET','/api/apps')));
 }
 if(args.operation==='read'){
  only(args,['operation','id']);
  if(typeof args.id!=='string'||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(args.id))throw new InputError('A valid connection id is required');
  const server=obj(await backend.request('GET','/api/mcp/servers/'+args.id)),name=String(server.name??''),prefix=`mcp__${name}__`;
  const names=(x:unknown)=>record(x)?Object.keys(x):[];
  const tools=(Array.isArray(server.tools)?server.tools:[]).filter(record).map(t=>({name:String(t.name),title:typeof t.title==='string'?t.title:null,description:typeof t.description==='string'?t.description.slice(0,500):null,asksFirst:t.requiresApproval===true}));
  const list=obj(await backend.request('GET','/api/agents')).agents,agents:{id:string;name:string;tools:string[]}[]=[];
  for(const a of (Array.isArray(list)?list:[]).filter(record).filter(a=>typeof a.id==='string'&&a.id!=='small-local-agent').slice(0,200)){
   const g=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(String(a.id))+'/tool-grants')),granted=(Array.isArray(g.grants)?g.grants:[]).filter(record).map(x=>String(x.tool)).filter(t=>t.startsWith(prefix));
   if(granted.length)agents.push({id:String(a.id),name:typeof a.name==='string'?a.name:String(a.id),tools:granted});
  }
  return ok('MCP connection, its tools and the agents that may use them. Reading never connects, starts a program or grants access. Secret values are never returned.',{id:server.id,name,description:server.description??null,kind:server.transport==='stdio'?'program':'web',enabled:server.enabled===true,active:server.active!==false,connectionState:server.connectionState??null,problem:typeof server.lastError==='string'&&server.enabled===true,lastDiscoveredAt:server.lastDiscoveredAt??null,secretNames:[...names(server.env),...names(server.headers)],tools,agents});
 }
 if(args.operation==='add'){
  only(args,['operation','connection']);
  const input=obj(args.connection);only(input,['name','description','transport','url','command','args','allowRemote']);
  if(typeof input.name!=='string'||!(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/).test(input.name)||!['http','sse','stdio'].includes(String(input.transport)))throw new InputError('A valid name and transport are required');
  if(input.description!==undefined&&(typeof input.description!=='string'||input.description.length>500)||input.allowRemote!==undefined&&typeof input.allowRemote!=='boolean')throw new InputError('Invalid connection');
  if(input.transport==='stdio'){
   if(typeof input.command!=='string'||!input.command.trim()||input.command.length>500||input.url!==undefined||input.allowRemote!==undefined)throw new InputError('Invalid program connection');
   if(input.args!==undefined&&(!Array.isArray(input.args)||input.args.length>50||!input.args.every(v=>typeof v==='string'&&v.length<=1000)))throw new InputError('Invalid arguments');
  }else if(typeof input.url!=='string'||!input.url||input.url.length>2000||input.command!==undefined||input.args!==undefined)throw new InputError('Invalid web connection');
  const saved=await backend.request('POST','/api/mcp/servers',input);
  return ok('Connection added disabled. The owner reviews startup and agent access in the app.',{id:saved.id});
 }
 throw new InputError('Unknown application operation');
}

async function workspaceSettingsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 only(args,['operation','body']);
 const operation=args.operation,body=obj(args.body);
 if(!['export','preview','import'].includes(String(operation)))throw new InputError('Unknown settings operation');
 if(operation==='export'){
  only(body,['agents','personalities','specialties','skills']);
  if(Object.keys(body).length!==4||!Object.values(body).every(v=>typeof v==='boolean')||!Object.values(body).some(Boolean))throw new InputError('Choose settings to export');
 }else{
  only(body,operation==='preview'?['pack']:['pack','fingerprint','confirmed']);
  const pack=obj(body.pack);
  if(pack.format!=='dpro-workspace-pack'||pack.version!==1||JSON.stringify(body).length>2_100_000)throw new InputError('A supported settings pack is required');
  if(operation==='import'&&(body.confirmed!==true||typeof body.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(body.fingerprint)))throw new InputError('Review the preview and explicitly confirm its fingerprint');
 }
 return ok('Workspace settings result. Import preserves existing settings and does not grant tools.',await backend.request('POST','/api/workspace-pack/'+operation,body));
}

async function tradingPracticeTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const operation=args.operation,base='/api/trading-paper/practice';
 if(operation==='read'||operation==='start'){
  only(args,['operation']);return ok('Local fictional practice.',await backend.request(operation==='read'?'GET':'POST',base,operation==='start'?{}:undefined));
 }
 if(!['order','step','stop','end'].includes(String(operation)))throw new InputError('Unknown practice operation');
 const fields=operation==='order'?['sessionId','requestId','symbol','side','quantity']:operation==='step'?['sessionId','requestId']:['sessionId'];
 only(args,['operation',...fields]);
 const uuid=(v:unknown)=>typeof v==='string'&&(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/).test(v);
 if(!uuid(args.sessionId)||['order','step'].includes(String(operation))&&!uuid(args.requestId))throw new InputError('Valid session and request identifiers are required');
 if(operation==='order'&&(!['DEMO-ALPHA','DEMO-BETA','DEMO-GAMMA'].includes(String(args.symbol))||!['buy','sell'].includes(String(args.side))||!Number.isSafeInteger(args.quantity)||Number(args.quantity)<1||Number(args.quantity)>100))throw new InputError('Invalid fictional order');
 const suffix=operation==='order'?'/orders':operation==='step'?'/step':operation==='stop'?'/stop-bot':'/end';
 return ok('Fictional practice result. Saved paper accounts and live trading are separate.',await backend.request('POST',base+suffix,Object.fromEntries(fields.map(k=>[k,args[k]]))));
}

// ---------------------------------------------------------------------------
// Read-only views of pages (agents, approvals, apps). Writes stay with the owner in the app.
// ---------------------------------------------------------------------------

/** Field names that may carry a secret, a code or a fingerprint; dropped at any depth (yes/no flags such as hasSecrets stay). */
const KEY_LIKE=/key|secret|token|password|passwd|credential|code|fingerprint|hash|cookie|authorization|signature|receipt|challenge|system_?prompt|^env$|environment|headers|private/i;
export function scrub(v:unknown,depth=0):unknown{
 if(depth>24)return null;
 if(Array.isArray(v))return v.slice(0,2000).map(x=>scrub(x,depth+1));
 if(record(v))return Object.fromEntries(Object.entries(v).filter(([k,x])=>!(KEY_LIKE.test(k)&&typeof x!=='boolean')).map(([k,x])=>[k,scrub(x,depth+1)]));
 return v;
}

const AGENTS_REFUSED='Renaming an agent, role, main agent, duplicate, hire and remove are done by the owner in the app. This tool reads (list, read, permissions, departments, org, sub_agents, sub_agent_work) and, on the owner\u2019s instruction, renames a department, moves an agent to one, changes who an agent reports to or adds a sub-agent.';
const DEPARTMENT=/^[a-z0-9][a-z0-9 _-]{0,63}$/;
function departmentArg(v:unknown,name:string){if(typeof v!=='string'||!DEPARTMENT.test(v.trim().toLowerCase().replace(/\s+/g,' ')))throw new InputError(`A valid ${name} is required (lowercase letters, digits, spaces, - or _, at most 64)`);return v.trim().toLowerCase().replace(/\s+/g,' ');}
const AGENT_WRITES=new Set(['rename','update','edit','save','role','set_role','main','set_main','set_primary','primary','duplicate','hire','create','add','remove','delete','set_permissions']);
const text=(v:unknown,n:number)=>typeof v==='string'?v.slice(0,n):null;
function agentView(a:unknown){
 if(!record(a))return null;
 return {id:text(a.id,128),name:text(a.name,200),emoji:text(a.emoji,16),role:text(a.role,40),department:text(a.department,64),specialty:text(a.specialty,200)??text(a.specialtyName,200),model:text(a.model,200),provider:text(a.provider,100),isMainAgent:a.isPrimary===true||a.is_primary===1,description:text(a.description,1000)};
}
function agentIdArg(v:unknown,name:string){if(typeof v!=='string'||!AGENT_ID.test(v)||v.includes('..'))throw new InputError(`A valid ${name} is required`);return v;}
async function agentsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const operation=args.operation;
 if(typeof operation==='string'&&AGENT_WRITES.has(operation))throw new InputError(AGENTS_REFUSED);
 if(operation==='list'){
  only(args,['operation']);
  const res=obj(await backend.request('GET','/api/agents'));
  const agents=(Array.isArray(res.agents)?res.agents:[]).map(agentView).filter(Boolean);
  return ok(`${agents.length} agent(s). ${AGENTS_REFUSED}`,{agents});
 }
 if(operation==='read'){
  only(args,['operation','id']);
  const id=agentIdArg(args.id,'agent id');
  const res=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)));
  return ok(`Agent. ${AGENTS_REFUSED}`,{agent:agentView(res.agent)});
 }
 if(operation==='permissions'){
  only(args,['operation','id']);
  const id=agentIdArg(args.id,'agent id');
  return ok('What this agent may do. Changing it is done by the owner in the app (What agents may do).',{permissions:scrub(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/permissions'))});
 }
 // Settings › Departments: a department is the agents' own department value.
 if(operation==='departments'){
  only(args,['operation']);
  const list=obj(await backend.request('GET','/api/agents')).agents,agents=(Array.isArray(list)?list:[]).map(agentView).filter((a):a is NonNullable<ReturnType<typeof agentView>>=>!!a);
  const groups=new Map<string,{id:string|null;name:string|null}[]>();for(const a of agents)groups.set(a.department??'',[...(groups.get(a.department??'')??[]),{id:a.id,name:a.name}]);
  return ok('Departments and their agents (the same as Settings \u203a Departments). Rename one or move an agent only on the owner\u2019s explicit instruction.',{departments:[...groups].filter(([d])=>d).sort(([a],[b])=>a.localeCompare(b)).map(([department,list])=>({department,agents:list})),noDepartment:groups.get('')??[]});
 }
 if(operation==='rename_department'){
  only(args,['operation','from','to']);
  const from=departmentArg(args.from,'from'),to=departmentArg(args.to,'to');
  return ok('Department renamed: every agent in it moved.',await backend.request('POST','/api/agents/departments/rename',{from,to}));
 }
 if(operation==='set_department'){
  only(args,['operation','id','department']);
  const id=agentIdArg(args.id,'agent id'),department=args.department===null?null:departmentArg(args.department,'department');
  const current=obj(obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id))).agent);
  const saved=obj(await backend.request('PUT','/api/agents/'+encodeURIComponent(id),{expectedVersion:current.version,department}));
  return ok(department?`Moved to ${department}.`:'Moved out of its department.',{agent:agentView(saved.agent)});
 }
 // Org chart (AGENTS-ORG-01): the backend places every agent; this reads its answer.
 // FIRSTRUN-01: read what the setup steps read, and propose hires; never hire.
 if(operation==='setup_tools'){
  only(args,['operation']);
  const tools=obj(await backend.request('GET','/api/first-run/tools')).tools;
  return ok('The coding tools on this computer. Installing or signing in is done by the owner in Girru\u2019s terminal; tell the owner the command, never run it for them.',{tools:Array.isArray(tools)?tools.map((t:any)=>({id:t?.id,name:t?.name,installed:t?.installed===true,signedIn:t?.signedIn===true,install:typeof t?.install==='string'?t.install:null,signIn:typeof t?.signIn==='string'?t.signIn:null})):[]});
 }
 if(operation==='suggest_team'){
  only(args,['operation','total','departments']);
  if(!Number.isSafeInteger(args.total)||(args.total as number)<1||(args.total as number)>1000)throw new InputError('total must be a whole number from 1 to 1000');
  if(!Array.isArray(args.departments)||!args.departments.length||args.departments.length>72)throw new InputError('departments must list 1 to 72 departments');
  const departments=[...new Set((args.departments as unknown[]).map(d=>departmentArg(d,'department')))];
  return ok('A suggested split; nothing was saved or hired. The owner hires it in Agents \u203a \u22ef \u203a Plan a bigger company.',obj(await backend.request('POST','/api/onboarding/team-distribution',{departments,total:args.total})));
 }
 if(operation==='propose_hire'){
  only(args,['operation','name','department','role','description']);
  const description=typeof args.description==='string'?args.description.trim():'';
  if(!description||description.length>500)throw new InputError('description is required (what the agent should do, at most 500 characters)');
  const department=args.department===undefined?null:departmentArg(args.department,'department');
  const role=args.role===undefined?'specialist':args.role;
  if(!['manager','specialist','evaluator'].includes(role as string))throw new InputError('role must be manager, specialist or evaluator');
  const name=args.name===undefined?null:typeof args.name==='string'&&args.name.trim()&&args.name.trim().length<=60?args.name.trim():(()=>{throw new InputError('name must be text of at most 60 characters');})();
  return ok('Proposal only: nothing was hired. Show it to the owner; they hire in Agents \u203a Hire (it starts Careful).',{proposal:{name,role,department,description,startsAs:'careful'}});
 }
 if(operation==='org'){
  only(args,['operation']);
  const list=obj(await backend.request('GET','/api/agents')).agents,rows=(Array.isArray(list)?list:[]).filter(record).filter(a=>a.placed!=='none');
  const node=(a:Record<string,unknown>)=>({...agentView(a),manager:text(a.manager,128),placed:text(a.placed,8),subAgentOf:text(a.subAgentOf,128)});
  return ok('Who reports to whom. placed: main (on top), set (the owner chose), auto (Girru placed it: under its department\u2019s manager, else the main agent), sub (a sub-agent of its agent). Change it only on the owner\u2019s explicit instruction (set_reports_to).',{agents:rows.map(node)});
 }
 if(operation==='sub_agents'){
  only(args,['operation','id']);
  const id=agentIdArg(args.id,'agent id');
  const list=obj(await backend.request('GET','/api/agents')).agents;
  return ok('Its sub-agents: they work only for it and never get more than it may do.',{subAgents:(Array.isArray(list)?list:[]).filter(record).filter(a=>a.subAgentOf===id).map(agentView)});
 }
 if(operation==='sub_agent_work'){
  only(args,['operation','id']);
  const id=agentIdArg(args.id,'agent id');
  return ok('Work it gave its sub-agents and quick helpers (newest first). A finished answer is a report, not proof. Stopping work is done by the owner in the app.',{work:scrub(obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/sub-agent-work')).work??[])});
 }
 if(operation==='set_reports_to'){
  only(args,['operation','id','reportsTo']);
  const id=agentIdArg(args.id,'agent id');
  if(!('reportsTo' in args))throw new InputError('reportsTo is required (an agent id, or null to let Girru place it)');
  const reportsTo=args.reportsTo===null?null:agentIdArg(args.reportsTo,'reportsTo');
  const res=obj(await backend.request('PUT','/api/agents/'+encodeURIComponent(id)+'/reports-to',{reportsTo}));
  return ok(reportsTo?'Changed: it now reports to that agent.':'Girru places it again.',{id:text(res.id,128),reportsTo:text(res.reportsTo,128)});
 }
 if(operation==='add_sub_agent'){
  only(args,['operation','id','name','startsAs','description','tools']);
  const id=agentIdArg(args.id,'agent id');
  const tools=Array.isArray(args.tools)?args.tools:[];
  if(!Array.isArray(args.tools)||tools.some(t=>typeof t!=='string'||!/^[A-Za-z0-9_:.-]{1,64}$/.test(t)))throw new InputError('tools must be a list of tool names (it may also be empty)');
  if(args.startsAs!==undefined&&args.startsAs!=='copy'&&args.startsAs!=='empty')throw new InputError('startsAs must be copy or empty');
  if(args.name!==undefined&&(typeof args.name!=='string'||!args.name.trim()))throw new InputError('name must be text');
  if(args.description!==undefined&&typeof args.description!=='string')throw new InputError('description must be text');
  // Same gate as the app: tools that need approval or run commands are given by the owner there.
  const grants=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/tool-grants'));
  const known=new Map((Array.isArray(grants.available)?grants.available:[]).filter(record).map(t=>[String(t.name),t]));
  const risky=tools.find(t=>{const k=known.get(t as string);return !k||k.execClass===true||k.requiresApproval===true;});
  if(risky)throw new InputError(`"${risky}" is unknown or needs approval; the owner gives it to a sub-agent in the app (Agents \u203a the agent \u203a Sub-agents).`);
  const body:Record<string,unknown>={startsAs:args.startsAs??'copy',tools};
  if(typeof args.name==='string')body.name=args.name.trim();
  if(typeof args.description==='string')body.description=args.description;
  const res=obj(await backend.request('POST','/api/agents/'+encodeURIComponent(id)+'/sub-agents',body));
  return ok('Sub-agent added. It works only for its agent and never gets more than its agent may do. Removing it is done by the owner in the app.',{agent:agentView(res.agent)});
 }
 // Agent page › Files (AGENT-FILES-01).
 const FILE_NAME=/^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,78}\.(md|txt|csv|json)$/i;
 if(operation==='files'){
  only(args,['operation','id']);
  const id=agentIdArg(args.id,'agent id');
  const res=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/library'));
  const files=(Array.isArray(res.files)?res.files:[]).filter(record).map(f=>({name:text(f.name,90),kind:f.kind==='who'?'who it is':f.kind==='mind'?'what it keeps in mind':'knowledge',size:typeof f.size==='number'?f.size:null,read:f.read===true}));
  return ok('Its files. Knowledge files marked read are part of its answers (as reference data). Writing a Knowledge file only on the owner\u2019s explicit instruction.',{files});
 }
 if(operation==='file'){
  only(args,['operation','id','name']);
  const id=agentIdArg(args.id,'agent id');
  // Who it is works like instructions: it stays in the app (system prompts are never returned).
  if(typeof args.name!=='string'||!(args.name==='MEMORY.md'||(FILE_NAME.test(args.name)&&!/^personality\.md$/i.test(args.name))))throw new InputError('name must be MEMORY.md or a Knowledge file name; Who it is is read in the app');
  const res=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/library/file?name='+encodeURIComponent(args.name)));
  return ok('One file (secrets hidden).',{name:text(res.name,90),content:text(res.content,1048576)});
 }
 if(operation==='write_file'){
  only(args,['operation','id','name','content']);
  const id=agentIdArg(args.id,'agent id');
  if(typeof args.name!=='string'||!FILE_NAME.test(args.name)||/^(personality|memory)\.md$/i.test(args.name))throw new InputError('Only Knowledge files (.md .txt .csv .json) can be written here; Who it is and What it keeps in mind are changed by the owner in the app');
  if(typeof args.content!=='string')throw new InputError('content is required');
  const list=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/library'));
  const exists=(Array.isArray(list.files)?list.files:[]).filter(record).some(f=>f.kind==='knowledge'&&f.name===args.name);
  // What an agent writes is not read into answers until the owner turns it on in the app.
  const off=' It is not read into answers until the owner turns it on in the app (Agents \u203a the agent \u203a Files).';
  if(!exists){const res=obj(await backend.request('POST','/api/agents/'+encodeURIComponent(id)+'/library/file',{name:args.name,content:args.content,read:false}));return ok((res.redacted?'Knowledge file added; values that looked like secrets were hidden.':'Knowledge file added.')+off,{name:args.name,read:false});}
  const cur=obj(await backend.request('GET','/api/agents/'+encodeURIComponent(id)+'/library/file?name='+encodeURIComponent(args.name)));
  await backend.request('POST','/api/agents/'+encodeURIComponent(id)+'/library/read',{name:args.name,read:false});
  const res=obj(await backend.request('PUT','/api/agents/'+encodeURIComponent(id)+'/library/file',{name:args.name,content:args.content,expectedHash:cur.hash??null}));
  return ok((res.redacted?'Knowledge file replaced; values that looked like secrets were hidden.':'Knowledge file replaced.')+' The owner can bring back the earlier version in the app.'+off,{name:args.name,read:false});
 }
 if(operation==='chart'){
  only(args,['operation']);
  const res=obj(await backend.request('GET','/api/me/agents-chart'));const c=obj(res.chart);
  return ok('How the owner sees Agents (List or Chart, arrangement, line style, zoom).',{view:text(c.view,8),mode:text(c.mode,12),lines:text(c.lines,10),zoom:typeof c.zoom==='number'?c.zoom:1});
 }
 if(operation==='set_chart'){
  only(args,['operation','view','mode','lines','zoom']);
  const body:Record<string,unknown>={};
  if(args.view!==undefined){if(args.view!=='list'&&args.view!=='chart')throw new InputError('view must be list or chart');body.view=args.view;}
  if(args.mode!==undefined){if(args.mode!=='reports'&&args.mode!=='departments')throw new InputError('mode must be reports or departments');body.mode=args.mode;}
  if(args.lines!==undefined){if(!['elbow','curved','straight'].includes(args.lines as string))throw new InputError('lines must be elbow, curved or straight');body.lines=args.lines;}
  if(args.zoom!==undefined){if(typeof args.zoom!=='number'||!(args.zoom>=0.3&&args.zoom<=1.6))throw new InputError('zoom is between 0.3 and 1.6');body.zoom=args.zoom;}
  if(!Object.keys(body).length)throw new InputError('Give view, mode, lines or zoom');
  const res=obj(await backend.request('PUT','/api/me/agents-chart',body));
  return ok('Saved for the owner: Agents shows it this way next time.',{chart:scrub(res.chart)});
 }
 throw new InputError('operation must be list, read, permissions, departments, rename_department, set_department, org, sub_agents, sub_agent_work, set_reports_to, add_sub_agent, files, file, write_file, chart or set_chart. '+AGENTS_REFUSED);
}

const APPROVALS_REFUSED='Approving, allowing, rejecting, voting, changing a waiting task, changing or turning off a rule and changing what agents may do are done by the owner in the app. This tool only reads (waiting, history, permissions, rules, coverage).';
const APPROVAL_WRITES=new Set(['approve','allow','allow_always','deny','reject','decline','vote','cast','verify','rule_save','save_rule','add_rule','rule_add','rule_change','edit_rule','activate','revoke','rule_off','turn_off','disable_rule','delete_rule','set_permissions','change_permissions','permissions_set','set','change_task','edit_task','edit','change','edit_request','change_request','request']);
const APPROVAL_STATUSES=['pending','approved','denied','executed','failed','expired'];
const CHAT_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
/** CH4/CH8: the chat side panel's parts and diff views (the same lists the backend checks on PUT /api/chat/panel). */
const PANEL_PARTS=['place','team','results','memory','mcp'],DIFF_VIEWS=['unified','split'];
const panelView=(p:any)=>{const v=obj(p);const parts=(l:unknown)=>Array.isArray(l)?l.filter((x):x is string=>PANEL_PARTS.includes(x as string)):[];return {order:parts(v.order),folded:parts(v.folded),diff:v.diff==='split'?'split':'unified'};};
const chatId=(v:unknown,name:string)=>{if(typeof v!=='string'||!CHAT_ID.test(v))throw new InputError(`${name} must be a chat id from list`);return v;};
/** CHAT-BUILD-01 stage 2: the chat sidebar for agents, with the same owner gates as the window (the owner's own session). */
async function chatsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const chat=(c:any)=>({id:c.id,name:c.title||c.preview||'New chat',projectId:c.projectId??null,pinned:!!c.pinned,mode:c.mode??'auto',thinking:c.thinking??'normal',...(c.archived?{archived:true}:{}),...(c.parentId?{openedFrom:c.parentId}:{}),...(c.running?{workingNow:true}:{}),...(c.waiting?{waitingForOwner:c.waiting}:{}),updatedAt:c.updatedAt});
 const put=async(id:string,body:Record<string,unknown>,done:string)=>{const r=obj(await backend.request('PUT',`/api/chat/conversations/${id}`,body));return ok(done,{chat:chat(obj(r.conversation))});};
 switch(args.operation){
  case 'list':{only(args,['operation']);const list=(obj(await backend.request('GET','/api/chat/conversations')).conversations as any[]??[]).map(chat);return ok(`${list.length} chats (pinned first, then newest).`,{chats:list});}
  case 'projects':{only(args,['operation']);const list=(obj(await backend.request('GET','/api/chat/projects')).projects as any[]??[]).map((p:any)=>({id:p.id,name:p.name,folder:p.folder??null,folders:Array.isArray(p.folders)?p.folders.map((f:any)=>({path:f.path,write:f.write===true})):[]}));return ok(`${list.length} projects.`,{projects:list});}
  case 'rename':{only(args,['operation','id','title']);if(typeof args.title!=='string'||!args.title.trim()||args.title.length>120)throw new InputError('title must be 1-120 characters');return put(chatId(args.id,'id'),{title:args.title.trim()},'Renamed.');}
  case 'pin':{only(args,['operation','id','pinned']);if(typeof args.pinned!=='boolean')throw new InputError('pinned must be true or false');return put(chatId(args.id,'id'),{pinned:args.pinned},args.pinned?'Pinned.':'Unpinned.');}
  case 'archive':{only(args,['operation','id','archived']);if(typeof args.archived!=='boolean')throw new InputError('archived must be true or false');return put(chatId(args.id,'id'),{archived:args.archived},args.archived?'Archived (still searchable).':'Brought back from the archive.');}
  case 'move':{only(args,['operation','id','projectId']);if(args.projectId!==null&&(typeof args.projectId!=='string'||!CHAT_ID.test(args.projectId)))throw new InputError('projectId must be a project id from projects, or null');return put(chatId(args.id,'id'),{projectId:args.projectId},args.projectId?'Moved to the project.':'Moved out of the project.');}
  case 'set_mode':{only(args,['operation','id','mode']);if(!['auto','ask','plan'].includes(String(args.mode)))throw new InputError('mode must be auto, ask or plan (Accept edits is set by the owner in the app)');return put(chatId(args.id,'id'),{mode:args.mode},`Mode: ${args.mode}.`);}
  case 'set_thinking':{only(args,['operation','id','thinking']);if(!['quick','normal','deep'].includes(String(args.thinking)))throw new InputError('thinking must be quick, normal or deep');return put(chatId(args.id,'id'),{thinking:args.thinking},`Thinking: ${args.thinking}.`);}
  case 'variables':{only(args,['operation','projectId']);if(typeof args.projectId!=='string'||!CHAT_ID.test(args.projectId))throw new InputError('projectId must be a project id from projects');const names=(obj(await backend.request('GET',`/api/chat/projects/${args.projectId}/variables`)).variables as unknown[]??[]).filter((n):n is string=>typeof n==='string'&&/^[A-Z_][A-Z0-9_]{0,63}$/.test(n));return ok(`${names.length} variables (names only; values are never shown).`,{variables:names});}
  case 'status':{only(args,['operation','id']);const id=chatId(args.id,'id');
   const [u,t,s]=await Promise.all([backend.request('GET',`/api/chat/conversations/${id}/usage`),backend.request('GET',`/api/chat/conversations/${id}/team`),backend.request('GET',`/api/chat/conversations/${id}/schedule`).catch(()=>({schedule:null}))]);
   const sc=obj(obj(s).schedule??{});
   const team=((obj(t).team as any[])??[]).map((x:any)=>({agent:x.agentName,app:replyApp(String(x.model??'')),model:x.model,status:x.status,at:x.at}));
   // CH12: the same Models line as the side panel: each app once, with the helpers that used it (the lead's model is in usage).
   const models=[...new Set(team.map(x=>x.app))].map(app=>({app,agents:[...new Set(team.filter(x=>x.app===app).map(x=>x.agent))]}));
   return ok('This chat: tokens by model (estimates), the agents it handed work to (with the app and model each hand-off really ran on), the apps used with their agents, its schedule.',{usage:obj(u).usage??[],team,models,schedule:sc.every?{every:sc.every,at:sc.at,weekday:sc.weekday??null,paused:!!sc.paused,nextRun:sc.nextRun}:null});}
  case 'pull_request':{only(args,['operation','projectId']);if(typeof args.projectId!=='string'||!CHAT_ID.test(args.projectId))throw new InputError('projectId must be a project id from projects');
   const r=obj(await backend.request('GET',`/api/chat/projects/${args.projectId}/pr`));const p=r.pr?obj(r.pr):null;
   if(r.unavailable===true)return ok('PR state unavailable (GitHub could not be asked now).',{pullRequest:null,unavailable:true});
   return ok(p?`#${p.number} is ${p.state}.`:'This project\u2019s branch has no pull request.',{pullRequest:p?{number:p.number,title:p.title,state:p.state,url:p.url,checks:p.checks??null}:null});}
  case 'panel':{only(args,['operation']);return ok('The side panel for the owner (every chat): its parts top first, the folded ones, and how Changes shows a diff (unified = One column, split = Side by side).',{panel:panelView(obj(await backend.request('GET','/api/chat/panel')).panel)});}
  case 'set_panel':{only(args,['operation','order','folded','diff']);const change:Record<string,unknown>={};
   for(const k of ['order','folded'] as const)if(k in args){const v=args[k];if(!Array.isArray(v)||v.length>PANEL_PARTS.length||!v.every(x=>typeof x==='string'&&PANEL_PARTS.includes(x))||new Set(v).size!==v.length)throw new InputError(`${k} must list side panel parts (${PANEL_PARTS.join(', ')}) once each`);change[k]=v;}
   if('diff' in args){if(!DIFF_VIEWS.includes(args.diff as string))throw new InputError('diff must be unified (One column) or split (Side by side)');change.diff=args.diff;}
   if(!Object.keys(change).length)throw new InputError('Give order, folded or diff');
   return ok('Side panel saved for the owner. The window shows it the next time the side panel opens.',{panel:panelView(obj(await backend.request('PUT','/api/chat/panel',change)).panel)});}
  default:throw new InputError('operation must be list, projects, rename, pin, archive, move, set_mode, set_thinking, variables, status, pull_request, panel or set_panel');
 }
}

/** CH12: the reply app for a model id, in the words the side panel uses. */
export function replyApp(model:string):string{
 for(const [id,name] of [['subscription:claude','Claude Code'],['subscription:codex','Codex'],['subscription:gemini','Gemini']] as const)if(model===id||model.startsWith(`${id}/`)||model.startsWith(`${id}:`))return name;
 return /^claude-/.test(model)?'Claude':'On this computer';
}

/** RULES-01: reads and suggestions only; a suggestion waits for the owner in Agents \u203a Rules. */
async function workspaceRulesTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const op=args.operation as string;
 const ruleId=()=>{if(typeof args.id!=='string'||!/^[0-9a-f-]{36}$/.test(args.id))throw new InputError('id must be a rule id from list');return args.id;};
 const fields=(keys:string[])=>Object.fromEntries(keys.filter(k=>k in args).map(k=>[k,args[k]]));
 const RULE=['text','when','projectId','who','targets'];
 const rule=(r:any)=>r&&({id:r.id,text:r.text,when:r.when??null,locked:!!r.locked,projectId:r.projectId??null,who:r.who,targets:r.targets??[],paused:!!r.paused,status:r.status,source:r.source,reason:r.reason??null,version:r.version});
 switch(op){
  case 'list':{only(args,['operation']);const r=obj(await backend.request('GET','/api/agent-rules'));const rules=((r.rules as any[])??[]).map(rule),suggestions=((r.suggestions as any[])??[]).map(rule);return ok(`${rules.length} rules (${rules.filter(x=>x.source==='girru').length} come with Girru, ${rules.filter(x=>x.locked).length} always on, ${rules.filter(x=>x.paused).length} paused), ${suggestions.length} suggestions waiting. Order: everywhere, then a project, then rules for chosen agents; the later one wins.`,{rules,suggestions,departments:r.departments??[]});}
  case 'files':{only(args,['operation','projectId']);if(typeof args.projectId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(args.projectId))throw new InputError('projectId must be a project id');const f=obj(obj(await backend.request('GET',`/api/agent-rules/files/${args.projectId}`)).files);return ok(f.upToDate?'The coding app files are up to date.':f.folder?'The coding app files are not written or not up to date; the owner writes them in Agents \u203a Rules.':'This project has no folder.',{mode:f.mode,written:!!f.written,upToDate:!!f.upToDate,files:((f.files as any[])??[]).map((x:any)=>({name:x.name,action:x.action}))});}
  case 'effective':{only(args,['operation','agentId','projectId']);if(typeof args.agentId!=='string'||!args.agentId)throw new InputError('agentId is required');const qs=new URLSearchParams({agentId:args.agentId,...(typeof args.projectId==='string'&&args.projectId?{projectId:args.projectId}:{})});const rules=((obj(await backend.request('GET',`/api/agent-rules/effective?${qs}`)).rules as any[])??[]).map(rule);return ok(`${rules.length} rules reach this agent there, in this order.`,{rules});}
  case 'versions':{only(args,['operation','id']);return ok('Earlier versions, newest first.',{versions:obj(await backend.request('GET',`/api/agent-rules/${ruleId()}/versions`)).versions??[]});}
  case 'suggest':{only(args,['operation',...RULE,'reason']);const r=obj(await backend.request('POST','/api/agent-rules/suggestions',fields([...RULE,'reason'])));return ok('Suggested. It waits for the owner in Agents \u203a Rules.',{rule:rule(r.rule)});}
  default:throw new InputError(RULES_REFUSED);
 }
}

async function workspaceTasksTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const op=args.operation as string;
 const id=(k:string)=>{const v=args[k];if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(v))throw new InputError(`${k} must be an id from list`);return v;};
 switch(op){
  case 'list':{only(args,['operation','projectId']);const qs=args.projectId!==undefined?`?projectId=${id('projectId')}`:'';const r=obj(await backend.request('GET',`/api/boards/tasks${qs}`));const tasks=(r.tasks as any[])??[];return ok(`${tasks.filter(t=>!t.finished).length} open tasks, ${tasks.filter(t=>t.finished).length} finished${(r.problems as any[])?.length?`, ${(r.problems as any[]).length} lines to fix`:''}.`,{tasks,problems:r.problems??[]});}
  case 'get':{only(args,['operation','boardId','cardId']);const t=obj(await backend.request('GET',`/api/boards/${id('boardId')}/cards/${id('cardId')}/task`)).task;if(!t)throw new InputError('That card has no task in a project task file');return ok('The task as the project\u2019s task file has it.',{task:t});}
  case 'continue':{only(args,['operation','boardId','cardId','agentId','model']);const body:Record<string,unknown>={boardId:id('boardId'),cardId:id('cardId')};if(args.agentId!==undefined){if(typeof args.agentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(args.agentId))throw new InputError('agentId must be an agent id');body.agentId=args.agentId;}if(args.model!==undefined){if(typeof args.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(args.model))throw new InputError('model must be a model id');body.model=args.model;}const r=obj(await backend.request('POST','/api/chat/task-continue',body));return ok('A chat in the project continues the task now.',{conversation:r.conversation??null});}
  case 'activity':{only(args,['operation','boardId','cardId']);const base=`/api/boards/${id('boardId')}/cards/${id('cardId')}`;const page=obj(await backend.request('GET',`${base}/page`)).page;const a=obj(await backend.request('GET',`${base}/activity`));return ok(`The task page: ${((a.items as any[])??[]).length} things happened${a.more?' (older ones too)':''}.`,{page,items:a.items??[],more:a.more===true});}
  case 'people':{only(args,['operation','boardId','cardId','kind','id','role']);if(args.kind!=='user'&&args.kind!=='agent')throw new InputError('kind is user or agent');if(typeof args.id!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(args.id))throw new InputError('id must be a person or agent id');if(!('role' in args)||(args.role!==null&&!['asked','does','checks','tests'].includes(args.role as string)))throw new InputError('role is asked, does, checks, tests, or null to take them off');const r=obj(await backend.request('PUT',`/api/boards/${id('boardId')}/cards/${id('cardId')}/people`,{kind:args.kind,id:args.id,role:args.role}));return ok(args.role===null?'Taken off the task.':'On the task.',{people:r.people??[]});}
  case 'checklist':{only(args,['operation','boardId','cardId','text','itemId','done','ownerKind','ownerId']);const base=`/api/boards/${id('boardId')}/cards/${id('cardId')}/checklist`;
   if(typeof args.text==='string'){if(args.itemId!==undefined||args.done!==undefined||args.ownerKind!==undefined)throw new InputError('Add with text alone');const r=obj(await backend.request('POST',base,{text:args.text}));return ok('Item added.',{items:r.items??[]});}
   const item=id('itemId');const body:Record<string,unknown>={};if(args.done!==undefined){if(typeof args.done!=='boolean')throw new InputError('done is true or false');body.done=args.done;}
   if(args.ownerKind!==undefined||args.ownerId!==undefined){if((args.ownerKind!=='user'&&args.ownerKind!=='agent')||typeof args.ownerId!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(args.ownerId))throw new InputError('ownerKind (user|agent) and ownerId go together');body.owner={kind:args.ownerKind,id:args.ownerId};}
   if(!Object.keys(body).length)throw new InputError('Say done, or ownerKind and ownerId');const r=obj(await backend.request('PUT',`${base}/${item}`,body));return ok('Checklist updated.',{items:r.items??[]});}
  case 'schedule':{only(args,['operation','boardId','cardId','every','at','weekday','agentId','model','paused']);const path=`/api/boards/${id('boardId')}/cards/${id('cardId')}/schedule`;
   if(args.every===undefined){if(['at','weekday','agentId','model','paused'].some(k=>k in args))throw new InputError('Set every to change the schedule');return ok('How the task repeats (null: it does not).',{schedule:obj(await backend.request('GET',path)).schedule??null});}
   const body:Record<string,unknown>=args.every==='never'?{every:'never'}:{every:args.every,at:args.at,...(args.weekday!==undefined?{weekday:args.weekday}:{}),...(args.agentId!==undefined?{agentId:args.agentId}:{}),...(args.model!==undefined?{model:args.model}:{}),...(args.paused!==undefined?{paused:args.paused}:{})};
   if(args.every!=='never'&&(typeof args.at!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(args.at)))throw new InputError('at is a time like 09:00');
   const r=obj(await backend.request('PUT',path,body));return ok(args.every==='never'?'It no longer repeats.':'Saved: it runs by itself on that schedule.',{schedule:r.schedule??null});}
  case 'sort':{only(args,['operation','boardId','cardId','department']);if(typeof args.department!=='string'||!args.department.trim()||args.department.length>64)throw new InputError('department is required');const r=obj(await backend.request('POST',`/api/boards/${id('boardId')}/cards/${id('cardId')}/task-sort`,{department:args.department}));return ok('Sent to the department\u2019s board and written in the project\u2019s task file.',{boardId:r.boardId??null});}
  default:throw new InputError(TASKS_REFUSED);
 }
}

async function workspaceApprovalsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const operation=args.operation;
 if(typeof operation==='string'&&APPROVAL_WRITES.has(operation))throw new InputError(APPROVALS_REFUSED);
 switch(operation){
  case 'waiting':{only(args,['operation']);return ok(`Requests waiting for the owner. ${APPROVALS_REFUSED}`,{approvals:scrub(obj(await backend.request('GET','/api/approvals?status=pending')).approvals??[])});}
  case 'history':{
   only(args,['operation','status','agentId']);
   if(args.status!==undefined&&args.agentId!==undefined)throw new InputError('Use status or agentId, not both');
   if(args.status!==undefined&&!APPROVAL_STATUSES.includes(String(args.status)))throw new InputError(`status must be one of ${APPROVAL_STATUSES.join(', ')}`);
   const path=args.status!==undefined?`/api/approvals?status=${args.status}&limit=100`:args.agentId!==undefined?`/api/approvals?agentId=${agentIdArg(args.agentId,'agentId')}&limit=100`:'/api/approvals?limit=100';
   return ok('Approval history (newest first, up to 100).',{approvals:scrub(obj(await backend.request('GET',path)).approvals??[])});
  }
  case 'permissions':{
   only(args,['operation','agentId']);
   const one=args.agentId!==undefined?agentIdArg(args.agentId,'agentId'):null;
   let list:unknown[]=[{id:one}];
   if(!one){const all=obj(await backend.request('GET','/api/agents')).agents;list=Array.isArray(all)?all:[];}
   const agents=[];
   for(const a of list.filter(record).filter(a=>typeof a.id==='string'&&a.id!=='small-local-agent'&&AGENT_ID.test(a.id)).slice(0,200)){
    agents.push({id:a.id,name:text(a.name,200),role:text(a.role,40),department:text(a.department,64),permissions:scrub(await backend.request('GET','/api/agents/'+encodeURIComponent(String(a.id))+'/permissions'))});
   }
   return ok(`What agents may do. ${APPROVALS_REFUSED}`,{agents});
  }
  case 'rules':{
   only(args,['operation','cursor']);
   if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!/^[a-f0-9-]{36}$/.test(args.cursor)))throw new InputError('cursor must be the nextCursor of a previous page');
   return ok(`Approval rules. ${APPROVALS_REFUSED}`,scrub(await backend.request('GET','/api/reviewer-policies'+(args.cursor?`?cursor=${args.cursor}`:''))) as Record<string,unknown>);
  }
  case 'coverage':{only(args,['operation']);return ok('Tools and whether an approval or rule covers them (read only).',scrub(await backend.request('GET','/api/security/coverage')) as Record<string,unknown>);}
  default:throw new InputError('operation must be waiting, history, permissions, rules or coverage. '+APPROVALS_REFUSED);
 }
}

const APPS_REFUSED='Turning a channel on or off, its keys, who may write, GenVR connect, disconnect and publish are done by the owner in the app. This tool only reads them (channels, accounts, addons, catalogue).';
const APPS_OWNER_ONLY=new Set(['channel_on','channel_off','activate','deactivate','keys','set_keys','config','configure','who_may_write','allowed','connect','link','genvr_connect','disconnect','genvr_disconnect','publish','unpublish','upload','install','uninstall','enable_addon','disable_addon']);
const APPS_READS={
 channels:{note:'Chat channels and who may write (Settings \u203a Channels; read only). Keys are never returned.',paths:[['channels','/api/agent-connect/catalog']]},
 accounts:{note:'Linked accounts (Settings \u203a Accounts; read only). Sign-in codes and tokens are never returned.',paths:[['accounts','/api/connections']]},
 store:{note:'The Store: the apps that come with Girru (included: already in My apps; Code opens only in the Girru desktop app with its editor), Girru\u2019s app catalogue, the coding-app catalogue and the add-ons in coding apps on this computer (read only). Installing is done by the owner in the app.',paths:[['included','/api/apps'],['apps','/api/marketplace/search?limit=100&offset=0'],['codingApps','/api/chat/addons/catalogue'],['addons','/api/chat/addons']]},
 addons:{note:'Plugins and hooks from coding apps on this computer (read only).',paths:[['addons','/api/chat/addons']]},
 catalogue:{note:'The apps that come with Girru (included: already in My apps), Girru\u2019s app catalogue and the coding-app catalogue (read only). Installing is done by the owner in the app.',paths:[['included','/api/apps'],['apps','/api/marketplace/search?limit=100&offset=0'],['codingApps','/api/chat/addons/catalogue']]},
} as const;

async function meetingsTool(args:Record<string,unknown>,{backend}:HandlerDeps):Promise<ToolCallResult>{
 const path='/api/meetings',id=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(v))throw new InputError('Invalid meeting id');return v;};
 let result:any;
 switch(args.operation){
  case 'list':only(args,['operation']);result=await backend.request('GET',path);return ok('Recent meetings.',{meetings:Array.isArray(result.meetings)?result.meetings.map((m:any)=>({id:m.id,conversationId:m.conversationId,title:m.title,state:m.state})):[]});
  case 'departments':only(args,['operation']);result=await backend.request('GET',path+'/departments');return ok('Meeting departments.',{departments:result.departments,totalAgents:result.totalAgents});
  case 'participants':{only(args,['operation','id','query','offset']);const query=new URLSearchParams({limit:'50'});if(args.id!==undefined)query.set('meetingId',id(args.id));if(args.query!==undefined){if(typeof args.query!=='string'||args.query.length>100)throw new InputError('Search is too long');query.set('q',args.query);}if(args.offset!==undefined){if(!Number.isSafeInteger(args.offset)||Number(args.offset)<0||Number(args.offset)>1000000)throw new InputError('Invalid offset');query.set('offset',String(args.offset));}result=await backend.request('GET',path+'/roster?'+query);return ok('Invited participants (one page).',{agents:Array.isArray(result.agents)?result.agents.slice(0,50).map((a:any)=>({id:a.id,name:a.name,department:a.department,role:a.role})):[],total:result.total,nextOffset:result.nextOffset});}
  case 'read':only(args,['operation','id']);result=await backend.request('GET',path+'/'+id(args.id));break;
  case 'create':{only(args,['operation','body']);const b=obj(args.body);only(b,['requestId','title','objective','selection','projectId']);id(b.requestId);if(typeof b.title!=='string'||!b.title.trim()||b.title.length>160||typeof b.objective!=='string'||!b.objective.trim()||b.objective.length>4000)throw new InputError('Topic and objective are required');const selection=obj(b.selection);only(selection,['mode','departments','agentIds','headsOnly']);if(!['all','departments','agents'].includes(String(selection.mode))||typeof selection.headsOnly!=='boolean'||!Array.isArray(selection.departments)||selection.departments.length>100||selection.departments.some(d=>typeof d!=='string'||!/^[a-z0-9][a-z0-9 _-]{0,63}$/.test(d))||!Array.isArray(selection.agentIds)||selection.agentIds.length>5000)throw new InputError('Invalid participant selection');selection.agentIds.forEach(id);if(b.projectId!=null)id(b.projectId);result=await backend.request('POST',path,b);break;}
  case 'draft':{only(args,['operation','id','body']);const b=obj(args.body);only(b,['expectedVersion','summary','decisions']);if(!Number.isSafeInteger(b.expectedVersion)||typeof b.summary!=='string'||b.summary.length>20000||!Array.isArray(b.decisions)||b.decisions.length>200)throw new InputError('Invalid draft');for(const item of b.decisions){const d=obj(item);only(d,['id','title','description','agentId','department','dueDate','enabled']);id(d.id);if(typeof d.title!=='string'||!d.title.trim()||d.title.length>160||typeof d.description!=='string'||d.description.length>8000||typeof d.enabled!=='boolean')throw new InputError('Invalid action');if(d.agentId!=null)id(d.agentId);}result=await backend.request('PUT',path+'/'+id(args.id)+'/decisions',b);break;}
  default:throw new InputError('Meetings support list, read, departments, participants, create and draft only. The owner approves and starts calls in the app.');
 }
 const m=result.meeting??{};return ok('Meeting '+String(m.title??'')+'. Decisions remain proposals until approved in the app.',{meeting:{id:m.id,conversationId:m.conversationId,title:m.title,state:m.state,version:m.version,count:m.count,summary:typeof m.summary==='string'?m.summary.slice(0,6000):'',decisions:Array.isArray(m.decisions)?m.decisions.slice(0,30).map((d:any)=>({id:d.id,title:d.title,description:typeof d.description==='string'?d.description.slice(0,2000):'',agentId:d.agentId,department:d.department,dueDate:d.dueDate,enabled:d.enabled,boardId:d.boardId,cardId:d.cardId})):[],moreDecisions:Math.max(0,(m.decisions?.length??0)-30)}});
}
