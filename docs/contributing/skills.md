# Add or improve a skill

A skill is a reusable written workflow, not an executable tool grant.

## Where to work

- Bundled source: `packages/backend/skills/<skill-id>/SKILL.md`.
- Professional collection: [source guide](../../packages/backend/skills/PROFESSIONAL_PACKAGES.md).
- Discovery through the separate Store: `skills/<id>/manifest.json`; see [Store](store-apps.md).

Inspect a comparable current package and the skill parser before choosing metadata. Use stable identifiers, a clear description, ordered instructions and reviewable outputs. Supporting `references/` and `assets/` should be useful to the task; optional helpers must state their dependencies and side effects. Do not put credentials in a skill.

The professional collection currently documents 41 authored packages and a portable mapping for 122 specialty templates; see the linked source guide for the current collection. These are content counts, not a guarantee of model performance or certification.

## Delivery

1. Add or change the source and relevant examples/templates.
2. Document required resources separately from permissions.
3. Update the portable professional pack if this skill belongs to it; preserve source/pack parity.
4. Follow [content updates](content-updates.md) for published identities and revisions.
5. Verify parser/import behaviour and relevant package fixtures on isolated data.

Check `reviewed-skill-object.test.mjs`, `professional-pack.test.mjs` and applicable tests under `packages/backend/test/skill-packages/`. Installation and assignment require their own supported workflow; installing a skill never authorises tools automatically.
