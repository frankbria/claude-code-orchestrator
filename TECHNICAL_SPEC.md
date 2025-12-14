# Technical Specifications: Claude Code Orchestrator

**Version**: 1.0
**Date**: December 12, 2025
**Status**: Design
**Author**: Frank Bria

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [API Specifications](#api-specifications)
3. [Database Design](#database-design)
4. [Hook System](#hook-system)
5. [Dashboard Implementation](#dashboard-implementation)
6. [n8n Workflow Specifications](#n8n-workflow-specifications)
7. [Workspace Management](#workspace-management)
8. [Security Considerations](#security-considerations)
9. [Performance Requirements](#performance-requirements)
10. [Deployment Architecture](#deployment-architecture)
11. [Error Handling](#error-handling)
12. [Testing Strategy](#testing-strategy)

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT LAYER                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Slack      │  │     n8n      │  │  Dashboard   │       │
│  │   Webhook    │  │   Workflows  │  │   (React)    │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
└─────────┼──────────────────┼──────────────────┼──────────────┘
          │                  │                  │
          │                  ▼                  │
          │         ┌────────────────┐          │
          └────────▶│   REST API     │◀─────────┘
                    │  (Express v5)  │
                    └────────┬───────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   PostgreSQL    │  │  Workspace      │  │  Claude Code    │
│   Database      │  │  Manager        │  │  (w/ hooks)     │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **REST API** | Session management, hook receivers, data serving | Express v5, TypeScript |
| **Database** | Session persistence, message storage, log storage | PostgreSQL 15+ |
| **Workspace Manager** | Git operations, folder creation, cleanup | Node.js child_process |
| **Claude Code** | AI coding agent, tool execution | Claude Code CLI |
| **Hooks** | Event capture, API notification | Bash curl commands |
| **Dashboard** | Session monitoring, log viewing | React, TypeScript |
| **n8n** | Workflow orchestration, message routing | n8n workflows |

### Technology Stack

```typescript
// Backend
{
  "runtime": "Node.js 20+",
  "framework": "Express 5.x",
  "language": "TypeScript 5.x",
  "database": "PostgreSQL 15+",
  "execution": "tsx (no build step)"
}

// Frontend
{
  "framework": "React 18+",
  "language": "TypeScript 5.x",
  "state": "React hooks (useState, useEffect)",
  "http": "Fetch API",
  "styling": "CSS modules or styled-components"
}

// Infrastructure
{
  "orchestration": "n8n",
  "containerization": "Docker (optional)",
  "messaging": "Slack API",
  "version_control": "Git"
}
```

---

## API Specifications

### Base Configuration

```
Base URL: http://localhost:3001/api
Content-Type: application/json
Module System: CommonJS
```

### Endpoints

#### 1. Create Session

**Request**:
```http
POST /api/sessions
Content-Type: application/json

{
  "projectType": "github" | "local" | "e2b" | "worktree",
  "projectPath": "/path/to/workspace",        // for local/worktree
  "githubRepo": "owner/repo",                 // for github
  "initialPrompt": "Create a REST API...",
  "slackChannel": "#dev-automation"           // optional
}
```

**Response** (201 Created):
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "workspacePath": "/tmp/claude-workspaces/repo-1734012345",
  "status": "created"
}
```

**Error Response** (400 Bad Request):
```json
{
  "error": "Invalid project type",
  "details": "projectType must be one of: github, local, e2b, worktree"
}
```

**Implementation**:
```typescript
// src/api/routes.ts
import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { WorkspaceManager } from '../services/workspace';

const router = Router();
const workspaceManager = new WorkspaceManager();

router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { projectType, projectPath, githubRepo, initialPrompt, slackChannel } = req.body;

    // Validate request
    if (!['github', 'local', 'e2b', 'worktree'].includes(projectType)) {
      return res.status(400).json({
        error: 'Invalid project type',
        details: 'projectType must be one of: github, local, e2b, worktree'
      });
    }

    // Create workspace
    const workspacePath = await workspaceManager.prepareWorkspace({
      projectType,
      projectPath,
      githubRepo
    });

    // Insert session record
    const result = await pool.query(
      `INSERT INTO sessions (project_path, project_type, status, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [workspacePath, projectType, 'active', JSON.stringify({ initialPrompt, slackChannel })]
    );

    const sessionId = result.rows[0].id;

    res.status(201).json({
      sessionId,
      workspacePath,
      status: 'created'
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

#### 2. List Sessions

**Request**:
```http
GET /api/sessions?status=active&limit=20
```

**Query Parameters**:
| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| status | string | Filter by status (active, paused, completed, error) | - |
| limit | integer | Max results to return | 50 |
| offset | integer | Pagination offset | 0 |

**Response** (200 OK):
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "claude_session_id": "claude-internal-abc123",
    "project_path": "/tmp/claude-workspaces/repo-1734012345",
    "project_type": "github",
    "status": "active",
    "created_at": "2025-12-12T10:30:00Z",
    "updated_at": "2025-12-12T10:35:00Z",
    "metadata": {
      "initialPrompt": "Create a REST API",
      "slackChannel": "#dev-automation"
    }
  }
]
```

**Implementation**:
```typescript
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM sessions';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }

    query += ` ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

#### 3. Get Session Details

**Request**:
```http
GET /api/sessions/:id
```

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "claude_session_id": "claude-internal-abc123",
  "project_path": "/tmp/claude-workspaces/repo-1734012345",
  "project_type": "github",
  "status": "active",
  "created_at": "2025-12-12T10:30:00Z",
  "updated_at": "2025-12-12T10:35:00Z",
  "metadata": {
    "initialPrompt": "Create a REST API",
    "slackChannel": "#dev-automation"
  }
}
```

**Error Response** (404 Not Found):
```json
{
  "error": "Session not found"
}
```

#### 4. Update Session

**Request**:
```http
PATCH /api/sessions/:id
Content-Type: application/json

{
  "status": "completed",
  "claudeSessionId": "claude-internal-abc123"
}
```

**Response** (200 OK):
```json
{
  "status": "updated"
}
```

#### 5. Get Session Messages

**Request**:
```http
GET /api/sessions/:id/messages?limit=100
```

**Response** (200 OK):
```json
[
  {
    "id": 1,
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "direction": "user",
    "content": "Create a REST API for user management",
    "source": "slack",
    "timestamp": "2025-12-12T10:30:00Z",
    "metadata": {}
  },
  {
    "id": 2,
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "direction": "assistant",
    "content": "I'll create a REST API for user management...",
    "source": "claude",
    "timestamp": "2025-12-12T10:30:15Z",
    "metadata": {}
  }
]
```

#### 6. Add Message

**Request**:
```http
POST /api/sessions/:id/messages
Content-Type: application/json

{
  "direction": "user",
  "content": "Add input validation to the API",
  "source": "dashboard"
}
```

**Response** (201 Created):
```json
{
  "status": "logged",
  "messageId": 3
}
```

#### 7. Get Command Logs

**Request**:
```http
GET /api/sessions/:id/logs?limit=50
```

**Response** (200 OK):
```json
[
  {
    "id": 1,
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "tool": "bash",
    "input": {
      "command": "npm init -y"
    },
    "result": "Wrote to /workspace/package.json:\n{\n  \"name\": \"api\",\n  \"version\": \"1.0.0\"\n}",
    "status": "completed",
    "duration_ms": 234,
    "timestamp": "2025-12-12T10:30:05Z"
  },
  {
    "id": 2,
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "tool": "edit_file",
    "input": {
      "file_path": "/workspace/src/api.ts",
      "old_string": "const port = 3000",
      "new_string": "const port = 8080"
    },
    "result": "File edited successfully",
    "status": "completed",
    "duration_ms": 45,
    "timestamp": "2025-12-12T10:30:10Z"
  }
]
```

#### 8. Tool Complete Hook

**Request** (from Claude Code):
```http
POST /api/hooks/tool-complete
Content-Type: application/json

{
  "session": "claude-internal-abc123",
  "tool": "bash",
  "input": {
    "command": "npm install express"
  },
  "result": "added 57 packages, and audited 58 packages in 5s",
  "duration_ms": 5432
}
```

**Response** (200 OK):
```http
HTTP/1.1 200 OK
Content-Length: 0
```

**Implementation**:
```typescript
// src/api/hooks.ts
router.post('/tool-complete', async (req: Request, res: Response) => {
  try {
    const { session, tool, input, result, duration_ms } = req.body;

    // Find session by claude_session_id
    const sessionResult = await pool.query(
      'SELECT id FROM sessions WHERE claude_session_id = $1',
      [session]
    );

    if (sessionResult.rows.length === 0) {
      // Session not found, but don't error (fire-and-forget)
      return res.sendStatus(200);
    }

    const sessionId = sessionResult.rows[0].id;

    // Truncate large results
    const truncatedResult = result?.length > 50000
      ? result.slice(0, 50000) + '\n... (truncated)'
      : result;

    // Insert command log
    await pool.query(
      `INSERT INTO command_logs (session_id, tool, input, result, duration_ms, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, tool, JSON.stringify(input), truncatedResult, duration_ms, 'completed']
    );

    // Update session timestamp
    await pool.query(
      'UPDATE sessions SET updated_at = NOW() WHERE id = $1',
      [sessionId]
    );

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing hook:', error);
    // Return 200 anyway (fire-and-forget)
    res.sendStatus(200);
  }
});
```

#### 9. Notification Hook

**Request** (from Claude Code):
```http
POST /api/hooks/notification
Content-Type: application/json

{
  "session": "claude-internal-abc123",
  "message": "Task completed successfully"
}
```

**Response** (200 OK):
```http
HTTP/1.1 200 OK
Content-Length: 0
```

---

## Database Design

### Schema Definition

```sql
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claude_session_id VARCHAR(255),
    project_path VARCHAR(500) NOT NULL,
    project_type VARCHAR(50) NOT NULL CHECK (project_type IN ('local', 'github', 'e2b', 'worktree')),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'error')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1,  -- Optimistic locking version
    metadata JSONB DEFAULT '{}'
);

-- Index for optimistic locking queries
CREATE INDEX idx_sessions_id_version ON sessions (id, version);

-- Trigger to auto-increment version on updates
CREATE OR REPLACE FUNCTION update_session_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.version := OLD.version + 1;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_session_version
BEFORE UPDATE ON sessions
FOR EACH ROW
EXECUTE FUNCTION update_session_version();

-- Session messages table
CREATE TABLE session_messages (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    source VARCHAR(50) CHECK (source IN ('slack', 'dashboard', 'n8n', 'cli', 'claude-hook')),
    timestamp TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Command logs table
CREATE TABLE command_logs (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    tool VARCHAR(100) NOT NULL,
    input JSONB,
    result TEXT,
    status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('completed', 'error')),
    duration_ms INTEGER,
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Slack thread mapping table
CREATE TABLE slack_thread_mapping (
    thread_ts VARCHAR(50) PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    channel_id VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_claude_id ON sessions(claude_session_id);
CREATE INDEX idx_messages_session ON session_messages(session_id, timestamp);
CREATE INDEX idx_logs_session ON command_logs(session_id, timestamp DESC);
CREATE INDEX idx_slack_session ON slack_thread_mapping(session_id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### Connection Pool Configuration

```typescript
// src/db/connection.ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Maximum pool size
  idleTimeoutMillis: 30000,   // Close idle clients after 30s
  connectionTimeoutMillis: 2000, // Timeout for new connections
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
  console.log('Database connected:', res.rows[0].now);
});
```

### Query Helpers

```typescript
// src/db/queries.ts
import { pool } from './connection';

export async function createSession(data: {
  projectPath: string;
  projectType: string;
  metadata?: object;
}) {
  const result = await pool.query(
    `INSERT INTO sessions (project_path, project_type, metadata)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [data.projectPath, data.projectType, JSON.stringify(data.metadata || {})]
  );
  return result.rows[0].id;
}

export async function getSessionByClaudeId(claudeSessionId: string) {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE claude_session_id = $1',
    [claudeSessionId]
  );
  return result.rows[0] || null;
}

export async function logToolExecution(data: {
  sessionId: string;
  tool: string;
  input: object;
  result: string;
  duration_ms?: number;
}) {
  await pool.query(
    `INSERT INTO command_logs (session_id, tool, input, result, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [data.sessionId, data.tool, JSON.stringify(data.input), data.result, data.duration_ms]
  );
}

export async function addMessage(data: {
  sessionId: string;
  direction: 'user' | 'assistant' | 'system';
  content: string;
  source: string;
}) {
  const result = await pool.query(
    `INSERT INTO session_messages (session_id, direction, content, source)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [data.sessionId, data.direction, data.content, data.source]
  );
  return result.rows[0].id;
}
```

---

## Hook System

### Hook Configuration

**Global hooks** (`~/.claude/settings.json`):
```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "*",
        "command": "/usr/local/bin/claude-orchestrator-hook.sh"
      }
    ],
    "notification": [
      {
        "command": "/usr/local/bin/claude-orchestrator-notify.sh"
      }
    ]
  }
}
```

### Hook Script Implementation

**Tool Complete Hook** (`/usr/local/bin/claude-orchestrator-hook.sh`):
```bash
#!/bin/bash

# Configuration
API_URL="${CLAUDE_ORCHESTRATOR_API:-http://localhost:3001}"
MAX_RESULT_SIZE=50000

# Extract environment variables
SESSION_ID="$CLAUDE_SESSION_ID"
TOOL_NAME="$TOOL_NAME"
TOOL_INPUT="$TOOL_INPUT"
TOOL_RESULT="$TOOL_RESULT"

# Truncate large results
if [ ${#TOOL_RESULT} -gt $MAX_RESULT_SIZE ]; then
  TOOL_RESULT="${TOOL_RESULT:0:$MAX_RESULT_SIZE}\n... (truncated)"
fi

# Escape result for JSON
RESULT_JSON=$(echo "$TOOL_RESULT" | jq -Rs .)

# POST to API (fire-and-forget)
curl -sS -X POST "$API_URL/api/hooks/tool-complete" \
  -H "Content-Type: application/json" \
  -d @- <<EOF >/dev/null 2>&1 &
{
  "session": "$SESSION_ID",
  "tool": "$TOOL_NAME",
  "input": $TOOL_INPUT,
  "result": $RESULT_JSON
}
EOF

# Exit immediately (don't wait for curl)
exit 0
```

**Notification Hook** (`/usr/local/bin/claude-orchestrator-notify.sh`):
```bash
#!/bin/bash

API_URL="${CLAUDE_ORCHESTRATOR_API:-http://localhost:3001}"
SESSION_ID="$CLAUDE_SESSION_ID"
MESSAGE="$MESSAGE"

MESSAGE_JSON=$(echo "$MESSAGE" | jq -Rs .)

curl -sS -X POST "$API_URL/api/hooks/notification" \
  -H "Content-Type: application/json" \
  -d @- <<EOF >/dev/null 2>&1 &
{
  "session": "$SESSION_ID",
  "message": $MESSAGE_JSON
}
EOF

exit 0
```

### Hook Environment Variables

Claude Code provides these variables to hooks:

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `CLAUDE_SESSION_ID` | string | `"abc123..."` | Claude Code's internal session ID |
| `TOOL_NAME` | string | `"bash"` | Name of tool that executed |
| `TOOL_INPUT` | JSON | `{"command":"ls"}` | Tool input parameters |
| `TOOL_RESULT` | string | `"file1.txt\nfile2.txt"` | Tool output (may be very large) |
| `MESSAGE` | string | `"Task completed"` | Notification message |

---

## Dashboard Implementation

### Polling Hook

```typescript
// dashboard/src/hooks/usePolling.ts
import { useState, useEffect, useCallback } from 'react';

interface UsePollingOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export function usePolling<T>(
  fetchFn: () => Promise<T>,
  options: UsePollingOptions = {}
) {
  const { intervalMs = 3000, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const result = await fetchFn();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    if (!enabled) return;

    // Fetch immediately
    fetch();

    // Poll at interval
    const interval = setInterval(fetch, intervalMs);

    return () => clearInterval(interval);
  }, [fetch, intervalMs, enabled]);

  return { data, error, loading, refetch: fetch };
}
```

### API Client

```typescript
// dashboard/src/api/client.ts
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  getSessions: () => fetchJson<Session[]>('/sessions'),

  getSession: (id: string) => fetchJson<Session>(`/sessions/${id}`),

  getSessionLogs: (id: string, limit = 50) =>
    fetchJson<CommandLog[]>(`/sessions/${id}/logs?limit=${limit}`),

  getSessionMessages: (id: string, limit = 100) =>
    fetchJson<Message[]>(`/sessions/${id}/messages?limit=${limit}`),

  addMessage: (id: string, message: Omit<Message, 'id' | 'timestamp'>) =>
    fetchJson<{ status: string; messageId: number }>(`/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    }),

  updateSession: (id: string, updates: Partial<Session>) =>
    fetchJson<{ status: string }>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
};
```

### TypeScript Types

```typescript
// dashboard/src/types/index.ts
export interface Session {
  id: string;
  claude_session_id: string | null;
  project_path: string;
  project_type: 'github' | 'local' | 'e2b' | 'worktree';
  status: 'active' | 'paused' | 'completed' | 'error';
  created_at: string;
  updated_at: string;
  metadata: Record<string, any>;
}

export interface Message {
  id: number;
  session_id: string;
  direction: 'user' | 'assistant' | 'system';
  content: string;
  source: string;
  timestamp: string;
  metadata: Record<string, any>;
}

export interface CommandLog {
  id: number;
  session_id: string;
  tool: string;
  input: Record<string, any>;
  result: string;
  status: 'completed' | 'error';
  duration_ms: number | null;
  timestamp: string;
}
```

---

## n8n Workflow Specifications

### Workflow 1: Session Initializer

**Trigger**: Webhook
**URL**: `/webhook/claude/start`
**Method**: POST

**Expected Payload**:
```json
{
  "projectType": "github",
  "githubRepo": "owner/repo",
  "prompt": "Create a REST API",
  "slackChannel": "#dev"
}
```

**Nodes**:

1. **Webhook** (Trigger)
2. **Switch** (Route by projectType)
3. **Execute Command** (GitHub clone)
   ```bash
   gh repo clone {{ $json.githubRepo }} /tmp/claude-workspaces/{{ $json.projectName }}-$(date +%s)
   ```
4. **HTTP Request** (Create session)
   - URL: `http://localhost:3001/api/sessions`
   - Method: POST
   - Body: `{{ JSON.stringify($json) }}`
5. **Execute Command** (Start Claude)
   ```bash
   cd {{ $json.workspacePath }} && claude --print -p "{{ $json.prompt }}" 2>&1
   ```
6. **HTTP Request** (Update session with Claude ID)
7. **Slack** (Send response)
8. **Set** (Store thread mapping)

### Workflow 2: Slack Message Handler

**Trigger**: Slack Event (message)
**Event**: `message`

**Nodes**:

1. **Slack Trigger**
2. **IF** (Check for thread_ts)
3. **HTTP Request** (Lookup session)
   - URL: `http://localhost:3001/api/slack-threads/{{ $json.thread_ts }}`
4. **Execute Command** (Resume Claude)
   ```bash
   cd {{ $json.workspacePath }} && claude --print --resume {{ $json.claudeSessionId }} -p "{{ $json.text }}" 2>&1
   ```
5. **Slack** (Reply in thread)

---

## Workspace Management

### WorkspaceManager Service

```typescript
// src/services/workspace.ts
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface SessionConfig {
  projectType: 'github' | 'local' | 'e2b' | 'worktree';
  projectPath?: string;
  githubRepo?: string;
}

export class WorkspaceManager {
  private baseDir: string;

  constructor(baseDir = process.env.WORKSPACE_BASE || '/tmp/claude-workspaces') {
    this.baseDir = baseDir;
  }

  async prepareWorkspace(config: SessionConfig): Promise<string> {
    switch (config.projectType) {
      case 'github':
        return this.cloneGitHubRepo(config.githubRepo!);
      case 'local':
        return this.ensureLocalDirectory(config.projectPath!);
      case 'worktree':
        return this.createGitWorktree(config.projectPath!);
      case 'e2b':
        return this.createE2BSandbox(config);
      default:
        throw new Error(`Unknown project type: ${config.projectType}`);
    }
  }

  private async cloneGitHubRepo(repo: string): Promise<string> {
    // Validate repo format
    if (!/^[\w-]+\/[\w.-]+$/.test(repo)) {
      throw new Error('Invalid repository format');
    }

    const workspaceId = uuidv4();
    const targetPath = path.join(this.baseDir, `${repo.replace('/', '-')}-${Date.now()}`);

    // Ensure base directory exists
    await fs.mkdir(this.baseDir, { recursive: true });

    // Clone repository
    execSync(`gh repo clone ${repo} ${targetPath}`, {
      timeout: 60000,
      stdio: 'pipe'
    });

    return targetPath;
  }

  private async ensureLocalDirectory(dirPath: string): Promise<string> {
    await fs.mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  private async createGitWorktree(basePath: string): Promise<string> {
    const branchName = `session-${Date.now()}`;
    const worktreePath = path.join(this.baseDir, branchName);

    execSync(`git worktree add ${worktreePath} -b ${branchName}`, {
      cwd: basePath,
      timeout: 10000
    });

    return worktreePath;
  }

  private async createE2BSandbox(config: SessionConfig): Promise<string> {
    // TODO: Implement E2B sandbox creation
    throw new Error('E2B sandbox not yet implemented');
  }

  async cleanup(workspacePath: string): Promise<void> {
    // Remove workspace directory
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}
```

---

## Security Considerations

### Input Validation

```typescript
// src/middleware/validation.ts
import { Request, Response, NextFunction } from 'express';

export function validateSessionCreate(req: Request, res: Response, next: NextFunction) {
  const { projectType, projectPath, githubRepo } = req.body;

  // Validate projectType
  if (!['github', 'local', 'e2b', 'worktree'].includes(projectType)) {
    return res.status(400).json({ error: 'Invalid project type' });
  }

  // Validate GitHub repo format
  if (projectType === 'github' && !/^[\w-]+\/[\w.-]+$/.test(githubRepo)) {
    return res.status(400).json({ error: 'Invalid GitHub repo format' });
  }

  // Validate local path (prevent path traversal)
  if (projectType === 'local' && projectPath) {
    const resolvedPath = path.resolve(projectPath);
    if (!resolvedPath.startsWith('/tmp/') && !resolvedPath.startsWith('/workspace/')) {
      return res.status(400).json({ error: 'Invalid project path' });
    }
  }

  next();
}
```

### SQL Injection Prevention

Always use parameterized queries:
```typescript
// GOOD: Parameterized query
await pool.query(
  'SELECT * FROM sessions WHERE id = $1',
  [sessionId]
);

// BAD: String concatenation (vulnerable to SQL injection)
await pool.query(
  `SELECT * FROM sessions WHERE id = '${sessionId}'`
);
```

### Authentication (Future)

```typescript
// src/middleware/auth.ts
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Apply to routes
app.use('/api/sessions', apiKeyAuth, sessionRoutes);
```

---

## Performance Requirements

### API Response Times

| Endpoint | Target (p95) | Max (p99) |
|----------|--------------|-----------|
| POST /api/sessions | 500ms | 1000ms |
| GET /api/sessions | 100ms | 200ms |
| GET /api/sessions/:id/logs | 150ms | 300ms |
| POST /api/hooks/* | 50ms | 100ms |

### Database Query Optimization

```typescript
// Use EXPLAIN ANALYZE to optimize queries
const result = await pool.query(`
  EXPLAIN ANALYZE
  SELECT * FROM command_logs
  WHERE session_id = $1
  ORDER BY timestamp DESC
  LIMIT 50
`, [sessionId]);
```

### Connection Pool Tuning

```typescript
export const pool = new Pool({
  max: 20,                      // Adjust based on load
  idleTimeoutMillis: 30000,     // Close idle connections
  connectionTimeoutMillis: 2000, // Fail fast on connection issues
});
```

---

## Deployment Architecture

### Docker Compose

See [ARCHITECTURE.md](ARCHITECTURE.md) for complete Docker Compose configuration.

### Environment Variables

```bash
# .env
DATABASE_URL=postgresql://claude:password@postgres:5432/claude_orchestrator
API_PORT=3001
WORKSPACE_BASE=/workspaces
NODE_ENV=production
```

### Health Checks

```typescript
// src/api/health.ts
router.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});
```

---

## Error Handling

### API Error Responses

```typescript
// src/middleware/error.ts
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error('Error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.message
    });
  }

  if (err.name === 'NotFoundError') {
    return res.status(404).json({
      error: 'Resource not found',
      details: err.message
    });
  }

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
}

// Apply to app
app.use(errorHandler);
```

### Hook Error Handling

Hooks use fire-and-forget pattern:
```bash
# Always return exit code 0
curl ... >/dev/null 2>&1 &
exit 0
```

---

## Testing Strategy

### Unit Tests (Jest)

```typescript
// src/api/__tests__/routes.test.ts
import request from 'supertest';
import app from '../index';
import { pool } from '../db/connection';

describe('POST /api/sessions', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('should create a new session', async () => {
    const response = await request(app)
      .post('/api/sessions')
      .send({
        projectType: 'local',
        projectPath: '/tmp/test',
        initialPrompt: 'Hello'
      })
      .expect(201);

    expect(response.body).toHaveProperty('sessionId');
    expect(response.body).toHaveProperty('workspacePath');
  });

  it('should return 400 for invalid projectType', async () => {
    await request(app)
      .post('/api/sessions')
      .send({
        projectType: 'invalid',
        projectPath: '/tmp/test'
      })
      .expect(400);
  });
});
```

### Integration Tests (Playwright)

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from '@playwright/test';

test('dashboard displays sessions', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Wait for sessions to load
  await page.waitForSelector('[data-testid="session-list"]');

  // Check that sessions are displayed
  const sessions = await page.locator('[data-testid="session-item"]').count();
  expect(sessions).toBeGreaterThan(0);
});

test('can view session details', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Click first session
  await page.locator('[data-testid="session-item"]').first().click();

  // Check that details are displayed
  await expect(page.locator('[data-testid="session-messages"]')).toBeVisible();
  await expect(page.locator('[data-testid="command-logs"]')).toBeVisible();
});
```

---

## Revision History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2025-12-12 | Initial technical specifications | Frank Bria |
