# Add or improve a specialty

A specialty defines a job: role instructions, relevant skills and capability requirements. A department defines organisational ownership. Neither is a personality or a blanket permission grant.

## Source map

- Department/job suggestions: `packages/backend/src/services/company-specialties.ts`.
- Catalogue expansion: `packages/backend/src/services/specialty-catalogue.ts`.
- Saved templates and validation: `packages/backend/src/services/specialty-templates.ts`.
- Source content: `packages/backend/skills/professional-role-profiles.json` and `professional-workspace-settings.json`.
- Distribution: `packages/backend/src/services/specialty-distribution.ts`.
- Public discovery: separate Store `specialties/<id>/manifest.json`.

Choose between an owner-created template, a Store item and a bundled template change. Do not change application catalogue code to create a private workspace template.

## Requirements

Define stable identity, name, department, description, role instructions, skill mapping and explicit resource requirements. Preserve local overrides and reviewed update behaviour. Do not silently grant tools, share memory, change an agent's personality or create agents as part of importing content.

For published content follow [content updates](content-updates.md). Check specialty template/version/update tests and `professional-pack.test.mjs`. Verify preview, conflict/stale revision handling, ownership, interrupted import and explicit assignment with fixture data.
