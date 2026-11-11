# Shared contributor workflow

This is the public workflow for human contributors and coding assistants. Local private instructions may add constraints; they must never be copied into a public change.

1. Read the documentation index and choose the contribution type and owning repository.
2. Inspect current source, nearby tests and existing extension points. Reuse the existing controller, service or contract instead of creating a parallel implementation.
3. Define the expected behaviour, acceptance checks and scope. Preserve unrelated work and user data.
4. Implement a focused change. Keep owner identity, grants, approvals and external-effect boundaries intact.
5. Run checks appropriate to the changed area using isolated fixtures. Report actual outcomes and remaining limits.
6. Update affected documentation and examples. Follow the repository review process before publishing.

## Documentation is part of completion

For every change, assess whether behaviour, configuration, API, permissions, installation, contribution instructions, package compatibility or repository links changed. Update affected documentation in the same change. If no update is needed, state why in the change summary or private handoff.

For cross-repository work, document compatibility and the release/consumption order in each affected repository. Distinguish local implementation, tested source, merged code and released availability. Do not advertise a Store preview as installable.

Use English for public project files. Keep secrets, machine-specific paths, internal planning and private signatures out of published material. Documentation examples must not bypass approvals or imply that a skill grants tools.

## Handoff

Record what changed, checks performed, documentation impact, unresolved issues and the next action. Use the project's private handoff when available; do not require a public contributor to possess private files. Follow local authorisation rules for installations, servers, commits and publication.
