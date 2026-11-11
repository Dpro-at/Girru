# Versioned content updates

Bundled skills and specialty templates have published identities and update history. Editing a Markdown file alone may not offer a reviewable update to an existing installation.

## Sources

- `packages/backend/skills/<id>/`: authored skill packages.
- `professional-role-profiles.json`: role source.
- `professional-workspace-settings.json`: portable Markdown-only skills/specialties pack.
- `professional-source-history.json`: registered release identities and hashes.
- `packages/backend/scripts/professional-source-history.cjs`: verification/generation logic, including pinned historical identities.

## Change process

1. Inspect the current pack, its source and the importer/update tests.
2. Make source and portable-pack changes consistently. The portable pack intentionally excludes executable helpers and credentials.
3. Preserve published identity, fingerprints and historical baselines. Append a reviewed release; do not rewrite old records to make tests pass.
4. Review the history generator's pinned digests and expected release count. Its non-check mode writes history: use it only for a deliberate content release and inspect the resulting diff.
5. Verify current source with `node packages/backend/scripts/professional-source-history.cjs --check` from a full-history checkout.
6. Test preview/update on an isolated fixture already at the previous registered release, including local overrides, conflicts and repeated/interrupted imports.

Run `professional-source-history.test.cjs`, `professional-pack.test.mjs`, pinned skill tests and affected specialty update tests. An import must not create accounts/agents or silently change tool grants, memory access, personalities or live assignments.

A Store index revision and a professional source release are different distribution mechanisms; update the one your contribution actually uses.
