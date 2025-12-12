-- Migration: 001_add_api_keys
-- Description: Add API keys table for authentication
-- Date: 2025-01-01

-- API Keys table for authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Partial index for faster lookups on active keys
CREATE INDEX IF NOT EXISTS idx_api_keys_active_key
    ON api_keys (key)
    WHERE active = true;

-- Index for listing/filtering keys
CREATE INDEX IF NOT EXISTS idx_api_keys_created_at
    ON api_keys (created_at DESC);

COMMENT ON TABLE api_keys IS 'Stores API keys for authenticating requests to the orchestrator API';
COMMENT ON COLUMN api_keys.key IS 'The actual API key value (64 character hex string)';
COMMENT ON COLUMN api_keys.name IS 'Human-readable name/description for the key';
COMMENT ON COLUMN api_keys.active IS 'Whether the key is currently valid for authentication';
COMMENT ON COLUMN api_keys.last_used_at IS 'Timestamp of last successful authentication with this key';
COMMENT ON COLUMN api_keys.metadata IS 'Additional metadata (owner, permissions, etc.)';
