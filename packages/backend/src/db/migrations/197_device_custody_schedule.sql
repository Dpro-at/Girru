-- Target-local pending Board metadata and owner-authorized single-use schedule intent.
ALTER TABLE computer_attempts ADD COLUMN target_card_id TEXT;
ALTER TABLE computer_attempts ADD COLUMN target_card_version INTEGER;
ALTER TABLE computer_attempts ADD COLUMN timing_json TEXT;
ALTER TABLE computer_attempts ADD COLUMN approval_intent_json TEXT;
