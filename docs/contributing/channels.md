# Channels and messaging connectors

Reusable channel transport belongs in [Agent Connect](https://github.com/Dpro-at/agent-connect), package `agent-connect-dpro`. Girru owns the host identity, configuration, persistence, execution and permission boundaries.

Read the upstream [channel catalogue](https://github.com/Dpro-at/agent-connect/blob/main/docs/CHANNELS.md) and [usage guide](https://github.com/Dpro-at/agent-connect/blob/main/docs/USAGE.md). Implement transport there; implement Girru-specific configuration and routing here. Pin and test a reviewed upstream version before consuming it.

Channel input is untrusted. Reuse the restricted channel turn policy and SDK authorisation rather than forwarding it with unrestricted owner grants. Verify signature/authentication, owner binding, destination boundaries, deduplication, disconnect/reconnect and secret redaction.

Use fixtures for routine tests. A passing connector unit test does not establish live-account/provider acceptance. Phone integrations can have separate providers and costs; they are not automatically supplied by a messaging catalogue entry.
