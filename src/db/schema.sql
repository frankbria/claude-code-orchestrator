-- Claude Orchestrator Database Schema
-- PostgreSQL 15+ required for JSONB support

-- Enable UUID extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claude_session_id VARCHAR(255),
    project_path VARCHAR(1024) NOT NULL,
    project_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'created',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_claude_session_id ON sessions (claude_session_id);

-- Session messages table
CREATE TABLE IF NOT EXISTS session_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    direction VARCHAR(20) NOT NULL, -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    source VARCHAR(50), -- 'n8n', 'slack', 'email', 'claude-hook', 'dashboard'
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages (timestamp);

-- Command logs table (tool execution history)
CREATE TABLE IF NOT EXISTS command_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    tool VARCHAR(100) NOT NULL,
    input JSONB,
    result TEXT,
    status VARCHAR(50) DEFAULT 'completed',
    duration_ms INTEGER,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_command_logs_session_id ON command_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_command_logs_timestamp ON command_logs (timestamp DESC);

-- Slack thread mapping table
CREATE TABLE IF NOT EXISTS slack_thread_mapping (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    channel_id VARCHAR(50) NOT NULL,
    thread_ts VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_thread_mapping_session_id ON slack_thread_mapping (session_id);

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

CREATE INDEX IF NOT EXISTS idx_api_keys_created_at
    ON api_keys (created_at DESC);
