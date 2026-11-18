-- Migration 206: record WHO decided each approval (SEC-GATE-02)
--   decided_by_kind  the kind of decider when an approval is decided:
--     'human'  an owner approved or denied it (the only decider today)
--     'rule'   a structural argv-prefix rule decided it (tools/argv-gate.ts)
--     'model'  a model judge decided it
--     'system' server policy decided it
-- decided_by stays the identity (owner id) where there is one; this adds the
-- kind beside it so every decision records both who and how it was decided.
-- Date: 2026-11-17

ALTER TABLE tool_approvals ADD COLUMN decided_by_kind TEXT;
