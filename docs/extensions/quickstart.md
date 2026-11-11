# Extension quickstart

This example illustrates the extension runner contract; it does not install or enable an extension. Test in an isolated development profile.

```text
packages/backend/extensions/example-tool/
  agentplayer.plugin.json
  index.js
  README.md
```

```json
{
  "id": "example-tool",
  "name": "Example Tool",
  "version": "0.1.0",
  "description": "Minimal extension lifecycle example",
  "author": "Your organisation",
  "type": "tool",
  "main": "index.js",
  "permissions": []
}
```

```js
export default {
  id: 'example-tool',
  name: 'Example Tool',
  version: '0.1.0',
  async register(api) {
    // Register only capabilities supported by the current SDK.
  },
  async onDisable(api) {
    // Release only resources owned by this extension.
  },
};
```

Use executable JavaScript for runtime entries; do not place uncompiled TypeScript syntax in `.js`. Adding a folder does not bypass the enabled configuration, installation validation or grants. See [permissions](permissions.md) before adding tools, routes, timers or external effects.
