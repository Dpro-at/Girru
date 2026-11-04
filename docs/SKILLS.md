# Skills

A skill is written guidance for an agent: a Markdown file (`SKILL.md`) that explains how to do one kind of work. A skill never grants tools, connections, memory or permissions. Those stay with the agent's grants and the owner's rules.

## Where skills live

| Part | Where | Notes |
|---|---|---|
| Skill text | `<data>/skill-library/` | Content-addressed: the file name is the hash of its text, so one text is stored once and never changes in place |
| The library list | the main database | One row per skill, pointing to the version in use |
| Which agent follows which skill | the main database (assignments, with a revision number) | A change names the revision it read; a stale change is refused |
| Skills that come with a specialty | the specialty's version | An agent with that specialty follows its skills too |

Everything is on the computer that runs Girru. See the [storage map](architecture/storage-map.md).

## Where skills come from

- **Bundled:** Girru ships a set of skills and puts them in the library at start-up.
- **The Store:** official skills come from the public Girru Store repository. Adding one from the Store asks for the owner's authenticator code, and every file is checked before it is added.
- **Found on this computer:** the Skills window can look for skill packages that coding tools keep on this computer. Nothing there changes. The owner previews a package and adds it with its hash; an added skill stays unassigned.

The old skill marketplace (`/api/skills/marketplace/*`) is retired. With `GIRRU_STORE_P4` on it answers `410`.

## Using skills

The Skills window uses four words:

- **Add** a skill to Girru.
- **Give** a skill to an agent.
- **Update** an installed copy to a newer version.
- **Take back** a skill from an agent.

Giving, taking back and updating change what agents follow, so only the owner does them, in the app. An agent or a coding tool can read the library and add a found package on the owner's explicit instruction; it cannot give or take back skills. A skill that agents or specialties still use cannot be removed.

### How an agent reads a skill

With `GIRRU_STORE_P2` on, an agent's instructions list each of its skills and specialties by name and the first line of its description. The agent loads one skill's full text with the `guide_read` tool when its work needs it, and only its own skills. This keeps every turn small, which matters most for local models.

So the first line of a skill's description should be one clear sentence about what the skill is for.

## Skill file format

```markdown
---
name: email-writer
description: Write clear, polite business emails with a subject, a short body and one request.
---

# Email writer

1. Start with the reason for the email in one sentence.
2. ...
```

- `name`: lower case with dashes.
- `description`: the first line is what agents see before they load the skill.
- The body is plain Markdown. A skill may have extra reference files next to `SKILL.md`.

Skill text from outside Girru is treated as data: it is reviewed before it is added, and it never overrides the owner's rules.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/skill-library` | members | The library |
| `GET /api/skill-library/items/:id` | owner | One skill's text |
| `POST /api/skill-library/scan`, `GET /api/skill-library/scans/:id` | owner | Look for skill packages on this computer |
| `POST /api/skill-library/preview` | owner | Read a found package before adding it |
| `POST /api/skill-library/import` | owner | Add a found package by its hash |
| `GET`, `PUT /api/skill-library/agents/:id` | owner or admin | An agent's skills (`PUT` sends the revision it read) |
| `DELETE /api/skill-library/items/:id` | owner | Remove an unused skill (asks first) |

## Related pages

- [Agent personality](AGENT_PERSONALITY.md)
- [Storage map](architecture/storage-map.md)
- [Bundled skills](../packages/backend/skills/README.md)
