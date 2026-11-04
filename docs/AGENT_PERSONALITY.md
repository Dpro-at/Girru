# Agent Personality System

Each agent has a personality (how it talks), a job (what it does), owner rules,
its own notes and knowledge files.

**Folder:** `.data/agents/{agentId}/`

---

## Where each part lives

| Part | The one place it is edited | Copies (views) |
|---|---|---|
| Personality: its text and its adjustments (traits, dialect, lock) | The personality record: one versioned history in the database | `PERSONALITY.md` (with `GIRRU_STORE_P4` on) |
| Job | The agent's specialty links (Agent › Specialties) | none |
| Owner's extra instructions | Agent › General (`agents_config.system_prompt`) | none |
| Own notes | `MEMORY.md`; with `GIRRU_STORE_P5` on, the agent's own drawer in the database | `MEMORY.md` (with `GIRRU_STORE_P5` on) |
| Reference files | `knowledge/` (Files › Knowledge) | none |

A personality changes how an agent talks. It never changes its job, skills or
permissions.

### The personality record (`GIRRU_STORE_P4`, on by default)

With the switch on:

- **One history.** Every change of the text or of an adjustment is a new
  version (`agent_personality_versions`; the text is stored once by its
  sha256 in `personality_texts`). Restoring an older version makes a new
  version again, so nothing is rewritten.
- **Edits in Girru save at once.** Files › Who it is and the Personality tab
  save a new version straight away; Undo restores the version before. A lock
  stops suggestions, not your own edits.
- **`PERSONALITY.md` is a view.** Girru writes it from the record: the text,
  then a generated settings part between markers (edits inside the markers are
  ignored).
- **Outside edits wait for review.** If a coding app or a text editor changes
  `PERSONALITY.md`, the change is not used. It appears in Personality review
  as before → after; *Agree* makes it a version, *No* writes the record back
  into the file.
- **Suggestions wait for review.** Evolution and agents suggest text changes
  in Personality review; nothing changes until you agree.
- **Start-up import.** The first start with the switch on copies each agent's
  current `PERSONALITY.md` text into its record once (the untouched template
  counts as no text). Older trait versions are kept.
- **Job from the specialty link.** Hiring from a linked specialty, and team
  hiring with a specialty from the library, link the specialty instead of
  copying its text into the instructions. A copy hire keeps its frozen copy.
- **Duplicate** gives the copy the original's current record as its version 1.

With the switch off, `PERSONALITY.md` is read as before.

---

## PERSONALITY.md

Defines the agent's core identity and behavior.

### Example

```markdown
# Agent Personality

## Name
Technical Support Assistant

## Role
You are a friendly technical support agent specializing in software troubleshooting.

## Personality Traits
- Patient and helpful
- Clear and concise explanations
- Proactive problem-solving
- Empathetic to user frustrations

## Communication Style
- Use simple, non-technical language when possible
- Ask clarifying questions before jumping to solutions
- Provide step-by-step instructions
- Always offer to help further

## Knowledge Areas
- Software installation and configuration
- Common error messages and fixes
- Basic network troubleshooting
- Account and login issues

## Limitations
- Cannot access user's computer directly
- Cannot reset passwords (guide user to reset flow)
- Cannot install software remotely
```

### How to Use

1. Open the agent, then **Files › Who it is** (or the **Personality** tab).
2. Edit the text. With `GIRRU_STORE_P4` on it is saved as a new version at
   once (Undo restores); the generated settings part is read only.
3. Earlier versions are listed under **Earlier versions**.

---

## MEMORY.md

Stores learned knowledge and patterns from conversations.

### Example

```markdown
# Agent Memory

## Learned Patterns

### Common User Issues
- Database connection timeout → Usually firewall blocking port 5432
- App crashes on startup → Clear cache in %AppData% folder
- Slow performance → Check background processes in Task Manager

### Successful Solutions
- **2026-02-20:** Fixed login issue by clearing browser cookies
- **2026-02-19:** Resolved installation error by running as administrator
- **2026-02-18:** Solved network error by disabling VPN

### User Preferences
- Prefers command-line solutions over GUI
- Familiar with Linux environment
- Works in software development team

### Important Context
- Company uses PostgreSQL database (port 5432)
- Internal server: db.company.local
- Support ticket system: support.company.com
```

### How Memory Works

1. **Automatic:** Agent can update memory during conversations
2. **Manual:** Edit via `/dashboard/agents/{id}/files` → "Memory" tab
3. **Tools:** Agent uses `memory_save` tool to record patterns
4. **Retrieval:** Agent references memory in future conversations

---

## Knowledge Files

Additional context files stored in `knowledge/` folder.

### Example Structure

```
knowledge/
├── company-policies.md
├── product-documentation.md
├── troubleshooting-guide.md
└── faq.md
```

### How to Add

1. **Go to:** `/dashboard/agents/{id}/files`
2. **Click:** "Knowledge" tab
3. **Upload:** Markdown or text files
4. **Agent:** Automatically references these files when relevant

---

## What an agent reads when it answers

With the one context (`GIRRU_STORE_P2` or `GIRRU_STORE_P4` on) chat, task
runs, coding apps and the heartbeat read the same parts, in this
order. The order is for prompt caching; precedence is a rule: owner rules come
before everything, and data never overrides instructions.

1. Identity (`You are <name>.`)
2. Owner rules
3. Your instructions (the owner's extra instructions)
4. Your personality (the record's text)
5. Working style (from the adjustments)
6. Specialties and skills (the job)
7. Team (names only)
8. Knowledge files the owner marked as read
9. Memory, framed as data (`MEMORY.md`, pinned facts, the newest handoff)

A public room is different: it gets the room's prompt and then only the
agent's personality text (never the owner's rules, instructions, team or
skills). The heartbeat reads no owner memory.

---

## Memory Tools

Agents can manage their own memory using these tools:

### memory_save
Save new knowledge pattern
```javascript
{
  "category": "troubleshooting",
  "pattern": "Database timeout usually means firewall blocking port",
  "context": "Solved 5 similar issues this week"
}
```

### memory_search
Search existing memory
```javascript
{
  "query": "database connection issues"
}
```

### memory_reflect
Analyze patterns and insights
```javascript
{
  "period": "last_week",
  "focus": "common_problems"
}
```

### memory_stats
Get memory statistics
```javascript
{}
```

---

## Best Practices

### PERSONALITY.md

✅ **Do:**
- Define clear role and responsibilities
- Specify communication style
- Set boundaries and limitations
- Keep under 500 words

❌ **Don't:**
- Include temporary information
- Write long essays
- Use vague descriptions
- Mix personality with memory

### MEMORY.md

✅ **Do:**
- Record successful solutions
- Document learned patterns
- Track user preferences
- Update regularly

❌ **Don't:**
- Store sensitive data
- Include temporary notes
- Duplicate PERSONALITY.md content
- Let it grow unbounded (clean old entries)

### Knowledge Files

✅ **Do:**
- Organize by topic
- Use clear filenames
- Keep files focused
- Update when information changes

❌ **Don't:**
- Upload large files (>1MB)
- Include duplicate information
- Use complex formatting
- Mix multiple topics in one file

---

## Examples

### Customer Support Agent

**PERSONALITY.md:**
```markdown
# Customer Support Agent

## Role
Friendly customer support for e-commerce platform

## Style
- Warm and welcoming
- Solution-focused
- Apologetic when appropriate
- Proactive follow-up

## Knowledge
- Order tracking and shipping
- Returns and refunds
- Account management
- Product catalog
```

**MEMORY.md:**
```markdown
# Memory

## Common Issues
- Shipping delays → Check carrier status first
- Wrong item → Process replacement immediately
- Payment failed → Verify card details and billing address

## Customer Patterns
- 80% of issues resolved with order tracking link
- Peak support hours: 2-4 PM weekdays
- Most returns: wrong size (clothing)
```

---

### Technical Writer Agent

**PERSONALITY.md:**
```markdown
# Technical Writer

## Role
Create clear, concise technical documentation

## Style
- Simple language
- Step-by-step instructions
- Visual aids when helpful
- Beginner-friendly

## Expertise
- API documentation
- User guides
- Installation manuals
- Troubleshooting guides
```

**MEMORY.md:**
```markdown
# Memory

## Writing Patterns
- Always start with prerequisites
- Use numbered lists for procedures
- Include code examples for APIs
- Add "Common Pitfalls" section

## User Feedback
- Users prefer short paragraphs
- Screenshots increase clarity by 60%
- Examples more valuable than theory
```

---

## API Access

All routes are owner only.

```bash
# The record (personality text + adjustments)
GET  /api/agents/:id/personality/current          # adds "text" with GIRRU_STORE_P4 on
GET  /api/agents/:id/personality/versions
PUT  /api/agents/:id/personality/text             # { text, expectedVersion } (GIRRU_STORE_P4)
POST /api/agents/:id/personality/versions         # adjustments
POST /api/agents/:id/personality/rollback         # { version } -> a new version
GET  /api/agents/:id/personality/proposals        # suggestions and outside edits
POST /api/agents/:id/personality/proposals/:pid/approve   # { expectedReviewHash }
POST /api/agents/:id/personality/proposals/:pid/reject    # { expectedReviewHash, note? }

# Files (Who it is, MEMORY.md, knowledge/)
GET  /api/agents/:id/library
GET  /api/agents/:id/library/file?name=PERSONALITY.md
PUT  /api/agents/:id/library/file                 # { name, content, expectedHash }
GET  /api/agents/:id/library/versions?name=...

# Older file route
GET  /api/agents/:id/personality                  # the PERSONALITY.md file
PUT  /api/agents/:id/personality                  # { content } ; with GIRRU_STORE_P4: { content, expectedVersion }
```

A save with an old `expectedVersion` or `expectedHash` answers `409`
(`changed`): open the latest and try again.

---

## File Limits

- **Personality text / PERSONALITY.md:** 1 MB
- **MEMORY.md:** 32 KB (secrets are hidden before saving)
- **Knowledge files:** 1 MB each, up to 200 files (`.md`, `.txt`, `.csv`, `.json`)
- Who it is and Knowledge keep their last 20 saved file versions; with
  `GIRRU_STORE_P4` on, Who it is also lists every version of the record.

---

## Security

- Agent files stored in `.data/agents/` (gitignored)
- Each agent has isolated directory
- Path traversal prevention (sanitized filenames)
- Only agent owner can access files
