# Girru Skills

Skills extend Girru's capabilities with specific functionalities.

The [professional collection](PROFESSIONAL_PACKAGES.md) adds 41 authored workflow packages and a [portable pack for 122 specialty templates](professional-workspace-settings.json). Import is explicit; the collection does not create agents or grant permissions automatically.

## Structure

```
skills/
├── README.md              # This file
├── calculator/
│   └── SKILL.md          # Skill definition
├── github/
│   └── SKILL.md
├── weather/
│   └── SKILL.md
├── web-search/
│   └── SKILL.md
├── hello-world/
│   └── SKILL.md
├── summarize/
│   └── SKILL.md
├── note-taking/
│   └── SKILL.md
└── json-render/
    ├── SKILL.md
    └── references/
        └── components.md
```

## Available Skills

| Skill | Emoji | Category | Description |
|-------|-------|----------|-------------|
| [calculator](./calculator/) | 🧮 | utilities | Math calculations and conversions |
| [github](./github/) | 🐙 | development | GitHub repository management |
| [weather](./weather/) | 🌤️ | utilities | Weather forecasts worldwide |
| [web-search](./web-search/) | 🔍 | research | Web search and retrieval |
| [hello-world](./hello-world/) | 👋 | demo | Simple greeting demonstration |
| [summarize](./summarize/) | 📝 | productivity | Text and article summarization |
| [note-taking](./note-taking/) | 📒 | productivity | Personal note management |
| [json-render](./json-render/) | 🎨 | utilities | Generate rich UI specs (charts, tables, dashboards) rendered as interactive React components |

## SKILL.md Format

Each skill has a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: skill-name
description: "Brief description of what the skill does"
metadata:
  agent-player:
    emoji: "🔧"
    version: "1.0.0"
    author: "Author Name"
    category: "utilities"
    tags: ["tag1", "tag2"]
    triggers:
      - trigger1
      - "trigger phrase"
    settings:
      - key: setting_key
        type: string|number|boolean|select|secret
        label: "Display Label"
        default: "default_value"
    requires:
      bins: ["required_binary"]
      apis: ["required_api"]
      libs: ["required_library"]
      llm: true  # if LLM required
    install:
      - id: brew
        kind: brew
        formula: package_name
        label: "Install via Homebrew"
---

# Skill Name

Full documentation in Markdown...
```

## Creating a New Skill

1. Create skill folder:
```bash
mkdir skills/my-skill
```

2. Create `SKILL.md`:
```bash
touch skills/my-skill/SKILL.md
```

3. Add frontmatter and documentation

4. Optional: Add reference files
```bash
mkdir skills/my-skill/references
mkdir skills/my-skill/scripts
```

## Skill Categories

| Category | Description |
|----------|-------------|
| `utilities` | General utility tools |
| `development` | Developer tools |
| `productivity` | Work and organization |
| `research` | Information and search |
| `demo` | Demonstration skills |
| `communication` | Messaging and chat |
| `media` | Audio, video, images |

## How these skills are used

At start-up Girru adds the bundled skills to its central skill library (`<data>/skill-library/`, one file per text, named by its hash). From there the owner gives skills to agents in the Skills window. A skill is guidance only: it never grants tools, connections, memory or permissions.

With `GIRRU_STORE_P2` on, an agent sees each of its skills by name and the first line of its `description`, and loads the full text with `guide_read` when it needs it. Keep that first line one clear sentence about what the skill is for.

The old skill marketplace routes (`/api/skills/marketplace/*`) are retired; with `GIRRU_STORE_P4` on they answer `410`. The library routes are listed in [docs/SKILLS.md](../../../docs/SKILLS.md).
