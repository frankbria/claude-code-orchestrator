-- Migration: 003_add_session_version_column
-- Description: Add version column to sessions table for optimistic locking concurrency control
-- Date: 2025-01-15

-- Add version column for optimistic locking
-- Default value of 1 ensures existing sessions work correctly
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Create composite index for efficient version-checked updates
-- This index optimizes the WHERE id = $1 AND version = $2 queries
CREATE INDEX IF NOT EXISTS idx_sessions_id_version ON sessions (id, version);

-- Create or replace function to auto-increment version on updates
-- This ensures version always increments even if not explicitly set
CREATE OR REPLACE FUNCTION update_session_version()
RETURNS TRIGGER AS $$
BEGIN
    -- Always increment version on update
    NEW.version := OLD.version + 1;
    -- Also update the timestamp
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS trigger_update_session_version ON sessions;

-- Create trigger to automatically increment version on any update
CREATE TRIGGER trigger_update_session_version
BEFORE UPDATE ON sessions
FOR EACH ROW
EXECUTE FUNCTION update_session_version();

-- Comment on the version column for documentation
COMMENT ON COLUMN sessions.version IS 'Optimistic locking version number. Automatically incremented on each update. Used to prevent concurrent update race conditions.';

-- Comment on the trigger for documentation
COMMENT ON TRIGGER trigger_update_session_version ON sessions IS 'Automatically increments session version and updates timestamp on each update';
