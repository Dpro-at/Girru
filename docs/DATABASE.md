# Database Structure

Girru uses SQLite database stored in `packages/backend/.data/database.db`

---

## Core Tables

### users
User accounts
```sql
id TEXT PRIMARY KEY
email TEXT UNIQUE
password_hash TEXT
name TEXT
avatar TEXT
created_at DATETIME
```

### agents
AI agents
```sql
id TEXT PRIMARY KEY
user_id TEXT
name TEXT
emoji TEXT
system_prompt TEXT
model TEXT (claude-sonnet-4.5, gpt-4, etc)
created_at DATETIME
```

### sessions
Chat sessions
```sql
id TEXT PRIMARY KEY
agent_id TEXT
user_id TEXT
title TEXT
created_at DATETIME
```

### messages
Chat messages
```sql
id TEXT PRIMARY KEY
session_id TEXT
role TEXT (user, assistant, system)
content TEXT
created_at DATETIME
```

---

## Agent System

### agents_config
Agent configuration (cron, tools)
```sql
agent_id TEXT PRIMARY KEY
cron_enabled BOOLEAN
cron_schedule TEXT
tools_enabled TEXT (JSON array)
```

### agent_personality_versions, personality_texts, personality_file_state, personality_proposals
An agent's personality record (append-only; the current personality is the highest version).
```sql
-- agent_personality_versions: agent_id, version, traits (JSON), preset, dialect, locked,
--   locked_traits (JSON), source, based_on_version, note, created_by, created_at,
--   text_hash TEXT  -- the personality text of this version (personality_texts.hash); NULL before
--                   -- the GIRRU_STORE_P4 import; a version that does not set it keeps the one before
-- personality_texts: hash TEXT PRIMARY KEY (sha256), body TEXT  -- each text stored once
-- personality_file_state: agent_id, written_hash, written_version -- what Girru last wrote into
--   PERSONALITY.md; another hash means the file was changed outside Girru (a proposal)
-- personality_proposals: + base_text_hash, proposed_text_hash, origin ('file' | 'evolution_text')
```

### agent_handoffs
Handoff notes, one table (STORE-MAP-01 P4, migration 169).
```sql
id TEXT PRIMARY KEY, owner_id, agent_id,       -- agent_id 'app:<client>' for a coding-app note
scope_kind TEXT  -- 'conversation' | 'task' | 'project' (a coding app's note for a project)
scope_id, project_id, version,
done, remaining, next_steps, open_questions,    -- JSON lists
source TEXT      -- 'agent' | 'model' | 'fallback' | 'owner' | 'coding_app'
run_id, client, created_at
```
`memory_bridge_handoffs` still receives coding-app notes too (same id) while
`GIRRU_STORE_P4` is on, and is dropped one release later.

### agent_memory_imports, agent_package_imports
STORE-MAP-01 P5 (migration 171, used while `GIRRU_STORE_P5` is on).
```sql
-- agent_memory_imports: agent_id, memory_id (the agent drawer memory), file_hash (MEMORY.md when
--   imported), versions (history rows from .memory-versions), written_hash (what Girru last wrote)
-- agent_package_imports: id, agent_id, package_hash, schema_version, source_name,
--   refused (JSON: what the import left out), imported_by, imported_at
```
An agent's notes are one row of `memories` with `drawer_kind = 'agent'` and
`drawer_key` = the agent id; searches and the owner's memory list skip them.

### write_requests and the P6 columns
STORE-MAP-01 P6 (migrations 172-174, used while `GIRRU_STORE_P6` is on).
```sql
-- memory_bridge_folders.company_facts: 1 = company facts may reach coding-app sessions in this project
-- session_capabilities.agent_id: the agent a coding-app session works for (NULL: the owner's own run)
-- memory_bridge_handoffs.agent_id: the agent of a coding-app handoff note
-- write_requests: owner_id, request_id, verb, status ('pending' | 'done'), result (ids only), created_at
--   one row per memory-contract write that carried a request id; a retry gets the same answer
```

### agent_activity
Agent execution logs
```sql
id INTEGER PRIMARY KEY
agent_id TEXT
action TEXT
status TEXT
timestamp DATETIME
```

---

## Storage

### storage_files
File uploads
```sql
id TEXT PRIMARY KEY
user_id TEXT
filename TEXT
file_path TEXT
zone TEXT (cache, cdn)
category TEXT (audio, images, files)
size INTEGER
created_at DATETIME
```

---

## Calendar

### calendar_events
Calendar events
```sql
id TEXT PRIMARY KEY
user_id TEXT
title TEXT
start DATETIME
end DATETIME
type TEXT (meeting, deadline, reminder)
external_id TEXT
source_id TEXT
```

### calendar_sources
Calendar sources (Google, iCal)
```sql
id TEXT PRIMARY KEY
user_id TEXT
type TEXT (google, ical)
name TEXT
url TEXT
sync_enabled BOOLEAN
last_sync DATETIME
```

---

## Notifications

### notifications
User notifications
```sql
id TEXT PRIMARY KEY
user_id TEXT
type TEXT
title TEXT
message TEXT
read BOOLEAN
created_at DATETIME
```

### notification_settings
User notification preferences
```sql
user_id TEXT PRIMARY KEY
channel_in_app BOOLEAN
channel_email BOOLEAN
channel_push BOOLEAN
dnd_enabled BOOLEAN
dnd_start TIME
dnd_end TIME
```

---

## Extensions

### extension_configs
Extension settings
```sql
extension_id TEXT PRIMARY KEY
enabled BOOLEAN
settings TEXT (JSON)
installed_at DATETIME
```

### extension_migrations
Extension migration tracking
```sql
extension_id TEXT
migration_name TEXT
applied_at DATETIME
```

---

## User Worlds

### user_worlds
User-uploaded 3D worlds
```sql
id TEXT PRIMARY KEY
user_id TEXT
name TEXT
glb_file_id TEXT
thumbnail_file_id TEXT
is_public BOOLEAN
max_players INTEGER
spawn_position TEXT (JSON)
```

---

## Security

### credentials
Encrypted credentials vault (AES-256-GCM)
```sql
id TEXT PRIMARY KEY
user_id TEXT
service TEXT
encrypted_data TEXT
iv TEXT
created_at DATETIME
```

### audit_logs
Security audit logs
```sql
id INTEGER PRIMARY KEY
user_id TEXT
action TEXT
resource TEXT
ip_address TEXT
timestamp DATETIME
```

### account_lockouts
Failed login tracking
```sql
user_id TEXT PRIMARY KEY
failed_attempts INTEGER
locked_until DATETIME
```

---

## Memory

Memory lives in the main database. A memory belongs to one **drawer**: `owner`, `project`, `experience`, `task` or `people`. Every change is versioned.

### memories
One remembered fact, preference, decision, lesson or event.
- `id`, `user_id` - owner of the memory
- `type`, `content`, `importance_score`, `memory_layer`
- `drawer_kind`, `drawer_key` - the drawer; for a project drawer the key is the project's slug, or its id while `GIRRU_STORE_P3` is on
- `topic_key` - a stable topic; one current memory per topic and drawer
- `embedding`, `embedding_model`, `embedding_dims` - the vector used for search
- `source_agent_id`, `metadata` - who saved it and from where
- `source`, `source_ref`, `trust` - owner, agent, coding_app, import, channel or system; checked, unchecked or imported (filled while `GIRRU_STORE_P3` is on)
- `valid_from`, `valid_to`, `superseded_by` - since when it is true; when and by which memory it was replaced. A replaced memory keeps `status = 'replaced'`: it stays in History and is never recalled

### memory_versions
Append-only history of each memory (`create`, `update`, `delete`, `forget`, `baseline`), with who made the change and why. Its `version` is the number an editor sends as `expectedVersion`; an edit based on an older version is refused with the current text.

### memory_project_scopes, memory_departments, departments
State of a project drawer (name, department, pinned, archived, Trash) and the departments projects belong to. While `GIRRU_STORE_P3` is on, `departments` is the one list for agents and projects; `memory_departments` is kept equal to it so the switch can go off again. `department_merges` keeps what a merge moved so it can be undone; `department_questions` holds what an upgrade could not decide alone.

### memory_pinned_facts, memory_access_rules, memory_access_scope_rules, memory_scope_rules
Pinned facts per company, department or project; which agents may read or write which drawers; review rules per scope.

### memory_project_keys, memory_key_state
Which project slugs were moved to project ids, and whether an owner's project keys are slugs or ids now. Start-up moves the keys to follow `GIRRU_STORE_P3`.

### change_scopes, change_events, projection_state
The change log of opted-in project drawers (one event per write, in the same transaction) and the state of each generated copy (brief file, status). Used by the storage pilot.

### memory_cache_revisions
A counter per user and scope, raised by triggers on every memory write; recall caches use it to know they are out of date.

---

## Start-up checks

### schema_layout
One row: the highest migration this data has and the Girru version that last opened it. While `GIRRU_STORE_P3` is on, a Girru that finds migrations it does not know stops before writing anything, and a failed migration is named with an error id; the desktop start page explains both.

---

## Migrations

Migrations are SQL files in `packages/backend/src/db/migrations/`

**Naming:** `XXX_description.sql`

**Example:**
```sql
-- Migration: 001_init.sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL
);
```

**Auto-run:** Backend runs all migrations on startup

**Order:** Migrations run in numerical order (001, 002, 003...)

---

## Database Operations

### Backup
```bash
# Via API
POST /api/database/backup

# Manual
cp packages/backend/.data/database.db backup.db
```

### Restore
```bash
# Via API
POST /api/database/restore

# Manual
cp backup.db packages/backend/.data/database.db
```

### Optimize (VACUUM)
```bash
# Via API
POST /api/database/vacuum

# Manual
sqlite3 database.db "VACUUM;"
```

### Inspect
```bash
cd packages/backend/.data
sqlite3 database.db

sqlite> .tables
sqlite> .schema users
sqlite> SELECT * FROM agents;
sqlite> .quit
```

---

## Database Size

Typical sizes:
- Empty: ~100 KB
- Small usage: ~1-5 MB
- Medium usage: ~10-50 MB
- Large usage: ~100+ MB

**Storage breakdown:**
- Messages: 60-70%
- Files metadata: 15-20%
- Other tables: 10-15%

---

## Performance

**Indexes:**
- All primary keys auto-indexed
- Foreign keys indexed
- Common query fields indexed (user_id, agent_id, session_id)

**Query optimization:**
- Use `EXPLAIN QUERY PLAN` to check queries
- Add indexes for slow queries
- Run VACUUM periodically (removes deleted data)

---

## Security

- Database file: chmod 600 (owner read/write only)
- No remote access (SQLite is file-based)
- Credentials encrypted with AES-256-GCM
- Password hashes use bcrypt
- All queries use parameterized statements (prevents SQL injection)
