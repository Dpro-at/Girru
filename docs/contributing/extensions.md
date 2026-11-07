# Contribute an extension

Use an extension for an independent executable capability: integration, channel, domain service or tools. Use a [skill](skills.md) for written guidance, not as a substitute for executable code.

Start with the [extension overview](../extensions/overview.md) and [quickstart](../extensions/quickstart.md). Distributable applications also need the [Store contract](store-apps.md).

Core changes should be limited to necessary shared contracts. Keep extension-specific settings and business logic in its package. Document permissions, migrations, lifecycle, data ownership, external effects and removal behaviour. Native host features need separately implemented and tested host support.
