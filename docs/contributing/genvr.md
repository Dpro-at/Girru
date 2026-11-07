# GenVR contributions

World authoring and reusable SDK behaviour belong in [Dpro-at/genvr-world-sdk](https://github.com/Dpro-at/genvr-world-sdk). Girru-specific mounting, account/agent mapping, permissions, desktop lifecycle and packaging belong in Girru.

Read the SDK's current README and contribution instructions before editing. Do not create a parallel world engine in Girru. Distinguish the SDK's own capabilities from what the host currently exposes.

A cross-repository change should state the SDK revision, host contract, minimum compatible version, build/staging requirements and release order. Verify save/reopen/export, owner scoping, denied tools, lifecycle cleanup and packaged resources as applicable. MCP authoring tests alone do not prove an agent was granted tools or actually used them.

Film production, simulation and robotics descriptions must distinguish implemented features from roadmap work. See the [repository map](../ecosystem/repositories.md).
