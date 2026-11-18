# Girru documentation

Start with the guide for your task. The current desktop uses Electron and the React/TypeScript Core UI; the repository also retains a legacy Next.js application. Do not assume the root development command starts the desktop UI.

## Use and operate Girru

- [Installation](INSTALLATION.md), [setup](SETUP.md), [deployment](DEPLOYMENT.md), [upgrading](UPGRADING.md).
- [Personality reference](AGENT_PERSONALITY.md), [skills reference](SKILLS.md), [team delegation](TEAM_DELEGATION.md).
- [API](API.md), [database](DATABASE.md), [release checklist](RELEASE_CHECKLIST.md).

Existing references contain historical material. For a changed API or setting, verify the owning source and tests before relying on an example; contribution guides below identify those sources.

## Contribute

- [Choose a contribution](contributing/README.md).
- [Architecture and boundaries](architecture/overview.md).
- [Development setup](getting-started/development.md).
- [Shared contributor workflow](contributing/agent-workflow.md).
- [Related repositories](ecosystem/repositories.md).

## Develop extensions

- [Overview](extensions/overview.md), [quickstart](extensions/quickstart.md), [manifest](extensions/manifest.md).
- [Lifecycle](extensions/lifecycle.md), [permissions](extensions/permissions.md), [UI](extensions/ui.md), [examples](extensions/examples.md).

New behaviour, settings and contracts must include corresponding documentation changes. See the [maintenance rule](contributing/agent-workflow.md#documentation-is-part-of-completion).
