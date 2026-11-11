-- Migration 008: Add STT (Speech-to-Text) provider support to phone_numbers
-- Adds support for multiple STT providers (OpenAI Whisper, Google Cloud STT, Azure STT, etc.)

-- Add stt_provider column to phone_numbers
ALTER TABLE phone_numbers ADD COLUMN stt_provider TEXT DEFAULT 'twilio';

-- Add stt_provider_api_key column for storing encrypted API keys per phone number
ALTER TABLE phone_numbers ADD COLUMN stt_provider_api_key TEXT;

-- Update existing records to use Twilio as default STT provider
UPDATE phone_numbers SET stt_provider = 'twilio' WHERE stt_provider IS NULL;

-- Add index for faster provider queries
CREATE INDEX IF NOT EXISTS idx_phone_numbers_stt_provider ON phone_numbers(stt_provider);
