# Repository map

| Repository | Owns | Contribution destination |
|---|---|---|
| [Girru](https://github.com/Dpro-at/Girru) | Workspace, agent execution, memory, tasks, grants and desktop host | Core and host integration |
| [Girru Store](https://github.com/Dpro-at/girru-store) | App/MCP/skill/specialty catalogue and distributable items | Store items and generated index |
| [Agent Connect](https://github.com/Dpro-at/agent-connect) | Reusable messaging transports; package `agent-connect-dpro` | Connector implementation |
| [GenVR World SDK](https://github.com/Dpro-at/genvr-world-sdk) | Reusable world authoring SDK | World/authoring implementation |

All are separate projects: follow each repository's current licence, contribution rules and compatibility requirements. Sharing an organisation does not make their releases interchangeable.

For work spanning repositories, link the related changes, state the contract/version and release order, and verify the consuming Girru build. Do not patch a vendored copy as a substitute for an upstream contribution.

Start with [channels](../contributing/channels.md), [GenVR](../contributing/genvr.md), or [Store items](../contributing/store-apps.md).
