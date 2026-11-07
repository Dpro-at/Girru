# Add a Store item

The Store is a separate repository: [Dpro-at/girru-store](https://github.com/Dpro-at/girru-store).

| Item | Path in that repository |
|---|---|
| App | `apps/<id>/manifest.json` |
| MCP server | `mcp/<id>/manifest.json` |
| Skill | `skills/<id>/manifest.json` |
| Specialty | `specialties/<id>/manifest.json` |

Read its README and CONTRIBUTING before editing. Generate `index.json` with `node scripts/build-index.mjs`; never hand-edit the generated index. Run `node scripts/build-index.mjs --check` there after changes.

Installable apps carry `apps/<id>/package/agentplayer.plugin.json` and the referenced JavaScript entry. The standard extension package validator in `packages/backend/src/services/store-repo.ts` limits packages to 300 files / 5 MiB and specified file types. Separate native-runtime archives and runtime dependencies use different contracts; do not apply the extension-package limit or manifest to those artifacts. App migrations are restricted to creating the app's own namespaced tables/indexes. Verify current rules in that repository and Girru's installer before packaging.

Discovery is not installation, and installation is not an agent tool grant. A listing cannot supply a new native runtime capability. Mark previews truthfully; do not advertise an unimplemented host integration as installable.

For a cross-repository change, document the minimum compatible host/package version, integrity metadata, test evidence and release order. See [ecosystem map](../ecosystem/repositories.md).
