# Extension development

Extensions are the first choice for independent executable capabilities. The supported backend extension runner is `packages/backend/src/plugins/extension-runner.ts`, using the API in `sdk.ts` and contracts in `types.ts` beside it.

The repository also contains an older class-based plugin loader. Its contract is different; do not combine that loader's class examples with the extension runner's object hooks.

Start with [quickstart](quickstart.md), [manifest](manifest.md), [lifecycle](lifecycle.md), [permissions](permissions.md), [UI](ui.md) and [examples](examples.md). Public distribution belongs in the [Store](../contributing/store-apps.md).

Current extension execution depends on the supported database/runtime configuration. The runner currently disables extensions for the PostgreSQL driver; do not promise parity without implementation and tests.
