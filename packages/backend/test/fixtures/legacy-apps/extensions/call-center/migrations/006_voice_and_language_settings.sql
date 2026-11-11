-- Migration 006: Add voice and language settings to phone_numbers
-- Adds voice and language preferences for each phone number

-- Add voice and language columns to phone_numbers
ALTER TABLE phone_numbers ADD COLUMN voice TEXT DEFAULT 'Polly.Joanna';
ALTER TABLE phone_numbers ADD COLUMN language TEXT DEFAULT 'en-US';

-- Update existing records to use default values
UPDATE phone_numbers SET voice = 'Polly.Joanna' WHERE voice IS NULL;
UPDATE phone_numbers SET language = 'en-US' WHERE language IS NULL;
