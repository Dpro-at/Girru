-- STORE-MAP-01 P6 (GIRRU_STORE_P6), AG5: every write records the agent AND the app.
--
-- session_capabilities.agent_id: the Girru agent a coding-app run was started
-- for (NULL: the owner's own run). A write through that session records the
-- app (the capability's client) and this agent together.
-- memory_bridge_handoffs.agent_id: the agent of a coding-app handoff note.
ALTER TABLE session_capabilities ADD COLUMN agent_id TEXT;
ALTER TABLE memory_bridge_handoffs ADD COLUMN agent_id TEXT;
