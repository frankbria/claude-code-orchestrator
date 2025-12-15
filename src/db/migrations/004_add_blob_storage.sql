-- Migration 004: Add blob storage support for large tool results
-- This migration adds a blob_uri column to store references to large tool outputs
-- that exceed the inline storage threshold (100KB)

-- Add blob_uri column to command_logs table
-- This column stores the URI (file:// or s3://) of the blob if the result
-- was too large to store inline
ALTER TABLE command_logs ADD COLUMN IF NOT EXISTS blob_uri VARCHAR(500);

-- Add result_size_bytes column to track original size of results
-- Useful for monitoring and analytics
ALTER TABLE command_logs ADD COLUMN IF NOT EXISTS result_size_bytes INTEGER;

-- Create partial index for efficient queries on logs with blob URIs
-- Only indexes rows where blob_uri is not null for faster lookups
CREATE INDEX IF NOT EXISTS idx_command_logs_blob_uri
    ON command_logs (blob_uri)
    WHERE blob_uri IS NOT NULL;

-- Add index for efficient queries by result size (for monitoring large outputs)
CREATE INDEX IF NOT EXISTS idx_command_logs_result_size
    ON command_logs (result_size_bytes DESC)
    WHERE result_size_bytes IS NOT NULL;

-- Comment on columns for documentation
COMMENT ON COLUMN command_logs.blob_uri IS
    'URI of blob storage location for large tool results (file:// or s3://). NULL if result is stored inline.';

COMMENT ON COLUMN command_logs.result_size_bytes IS
    'Original size of the tool result in bytes before any truncation or blob storage.';
