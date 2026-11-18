-- Migration 007: Add TTS provider support to phone_numbers
-- Adds support for multiple TTS providers (Twilio Polly, OpenAI, Google Cloud, Azure, ElevenLabs)

-- Add tts_provider column to phone_numbers
ALTER TABLE phone_numbers ADD COLUMN tts_provider TEXT DEFAULT 'twilio';

-- Add provider_api_key column for storing encrypted API keys per phone number
ALTER TABLE phone_numbers ADD COLUMN provider_api_key TEXT;

-- Update existing records to use Twilio as default provider
UPDATE phone_numbers SET tts_provider = 'twilio' WHERE tts_provider IS NULL;

-- Add index for faster provider queries
CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider ON phone_numbers(tts_provider);
