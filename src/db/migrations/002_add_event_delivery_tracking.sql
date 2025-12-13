-- Migration: Add event delivery tracking to command_logs
-- This migration adds support for idempotent event handling and retry logic
-- PostgreSQL 15+ required

-- Add event_id column for idempotency
ALTER TABLE command_logs
ADD COLUMN IF NOT EXISTS event_id UUID UNIQUE;

-- Add delivery tracking columns
ALTER TABLE command_logs
ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'delivered'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'dead_letter'));

ALTER TABLE command_logs
ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 1;

ALTER TABLE command_logs
ADD COLUMN IF NOT EXISTS last_delivery_attempt TIMESTAMP DEFAULT NOW();

ALTER TABLE command_logs
ADD COLUMN IF NOT EXISTS delivery_error TEXT;

-- Create index for fast duplicate lookups
CREATE INDEX IF NOT EXISTS idx_command_logs_event_id ON command_logs (event_id);

-- Create composite index for efficient retry queue queries
CREATE INDEX IF NOT EXISTS idx_command_logs_delivery_retry
ON command_logs (delivery_status, last_delivery_attempt)
WHERE delivery_status IN ('pending', 'failed');

-- Add similar tracking to session_messages for notification hooks
ALTER TABLE session_messages
ADD COLUMN IF NOT EXISTS event_id UUID UNIQUE;

ALTER TABLE session_messages
ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'delivered'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'dead_letter'));

ALTER TABLE session_messages
ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 1;

ALTER TABLE session_messages
ADD COLUMN IF NOT EXISTS last_delivery_attempt TIMESTAMP DEFAULT NOW();

ALTER TABLE session_messages
ADD COLUMN IF NOT EXISTS delivery_error TEXT;

-- Create indexes for session_messages
CREATE INDEX IF NOT EXISTS idx_session_messages_event_id ON session_messages (event_id);

CREATE INDEX IF NOT EXISTS idx_session_messages_delivery_retry
ON session_messages (delivery_status, last_delivery_attempt)
WHERE delivery_status IN ('pending', 'failed');

-- Comment on columns for documentation
COMMENT ON COLUMN command_logs.event_id IS 'Unique event identifier for idempotency';
COMMENT ON COLUMN command_logs.delivery_status IS 'Status of event delivery: pending, delivered, failed, dead_letter';
COMMENT ON COLUMN command_logs.delivery_attempts IS 'Number of delivery attempts made';
COMMENT ON COLUMN command_logs.last_delivery_attempt IS 'Timestamp of last delivery attempt';
COMMENT ON COLUMN command_logs.delivery_error IS 'Error message from last failed delivery attempt';

COMMENT ON COLUMN session_messages.event_id IS 'Unique event identifier for idempotency';
COMMENT ON COLUMN session_messages.delivery_status IS 'Status of event delivery: pending, delivered, failed, dead_letter';
COMMENT ON COLUMN session_messages.delivery_attempts IS 'Number of delivery attempts made';
COMMENT ON COLUMN session_messages.last_delivery_attempt IS 'Timestamp of last delivery attempt';
COMMENT ON COLUMN session_messages.delivery_error IS 'Error message from last failed delivery attempt';
