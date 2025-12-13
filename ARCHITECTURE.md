# Claude Code + n8n Orchestrator Architecture

A headless Claude Code orchestration system with n8n workflows, session management, Slack/email integration, and web dashboard for parallel session monitoring.

## Table of Contents

- [Overview](#overview)
- [Design Philosophy](#design-philosophy)
- [System Architecture](#system-architecture)
- [Component Details](#component-details)
- [Data Flow](#data-flow)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Claude Code Hook Configuration](#claude-code-hook-configuration)
- [n8n Workflow Configuration](#n8n-workflow-configuration)
- [Dashboard Implementation](#dashboard-implementation)
- [Deployment](#deployment)
- [Extension Points](#extension-points)

---

## Overview

This system enables headless operation of Claude Code through n8n workflows, with:

1. **Project initialization** via GitHub clone, local folder, E2B sandbox, or git worktree
2. **Session management** with UUID tracking and Claude Code session mapping
3. **Bidirectional messaging** through Slack threads or email
4. **Conversation loops** that continue until explicitly closed
5. **Parallel execution** leveraging git worktrees and E2B sandboxes
6. **Real-time monitoring** through a web dashboard

### Key Design Decision: Hooks Over Process Wrapping

Instead of wrapping Claude Code in a process manager that parses stdout/stderr streams and broadcasts via WebSocket, we use Claude Code's **native hooks** to POST events directly to the backend API.

**What this eliminates:**
- Process wrapper classes with EventEmitter patterns
- stdout/stderr stream parsing and buffering
- WebSocket server infrastructure
- WebSocket client connection management
- Redis pub-sub for real-time event distribution

**What this enables:**
- Simpler, stateless API backend
- Claude Code runs naturally without supervision
- Dashboard uses straightforward REST polling
- Easier debugging and testing
- Lower resource overhead

---

## Design Philosophy

### Why Hooks Instead of Process Wrapping?

**The Traditional Approach (Rejected):**
```
Orchestrator spawns Claude Code → captures stdout/stderr → parses JSON lines 
→ emits events → WebSocket broadcasts → clients receive real-time updates
```

Problems:
- Complex process lifecycle management
- Brittle stdout parsing (mixed content, buffering issues)
- WebSocket connection state management
- Reconnection logic for clients
- Memory leaks from orphaned event listeners

**The Hook-Based Approach (Adopted):**
```
Claude Code runs independently → hook fires on tool use 
→ curl POSTs to API → API stores in database → dashboard polls database
```

Benefits:
- Claude Code manages its own lifecycle
- Hooks are reliable, documented, and maintained by Anthropic
- REST API is stateless and horizontally scalable
- Polling is simple, reliable, and sufficient for monitoring use cases
- No connection state to manage

### When Would WebSocket Be Justified?

WebSocket would only be necessary if:
- Sub-second latency on partial output is critical
- You're building a terminal emulator experience
- Streaming token-by-token output to users

For monitoring tool executions and session status, **2-3 second polling is adequate**.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ORCHESTRATION LAYER                                │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │   n8n       │───▶│  REST API   │◀───│  Message    │                      │
│  │  Workflows  │    │  Backend    │    │  Router     │                      │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                      │
│         │                  │                  │                              │
└─────────┼──────────────────┼──────────────────┼──────────────────────────────┘
          │                  │                  │
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Claude Code    │  │   PostgreSQL    │  │  Slack/Email    │
│  (with hooks)   │  │                 │  │  Webhooks       │
└────────┬────────┘  └─────────────────┘  └─────────────────┘
         │
         │ POST /api/hooks/* (on each tool use)
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXECUTION LAYER                                    │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │  Local      │    │  E2B        │    │  Git        │                      │
│  │  Workspace  │    │  Sandbox    │    │  Worktrees  │                      │
│  └─────────────┘    └─────────────┘    └─────────────┘                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MONITORING LAYER                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │              Web Dashboard (React + REST Polling)            │            │
│  │                                                              │            │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │            │
│  │  │Session 1│  │Session 2│  │Session 3│  │Session N│        │            │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │            │
│  │                                                              │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Interaction Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  User    │     │   n8n    │     │   API    │     │  Claude  │
│ (Slack)  │     │          │     │  Backend │     │   Code   │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ "start project"│                │                │
     │───────────────▶│                │                │
     │                │ POST /sessions │                │
     │                │───────────────▶│                │
     │                │                │ create record  │
     │                │                │───────┐        │
     │                │                │◀──────┘        │
     │                │ {sessionId}    │                │
     │                │◀───────────────│                │
     │                │                │                │
     │                │ exec: claude -p "..."          │
     │                │───────────────────────────────▶│
     │                │                │                │
     │                │                │  POST /hooks   │
     │                │                │◀───────────────│ (on each tool)
     │                │                │   200 OK       │
     │                │                │───────────────▶│
     │                │                │                │
     │ "Session started"               │                │
     │◀───────────────│                │                │
     │                │                │                │
     │ "continue with X"               │                │
     │───────────────▶│                │                │
     │                │ exec: claude --resume -p "X"   │
     │                │───────────────────────────────▶│
     │                │                │                │
     │                │                │  POST /hooks   │
     │                │                │◀───────────────│
     │                │ capture output │                │
     │                │◀───────────────────────────────│
     │ "Response..."  │                │                │
     │◀───────────────│                │                │
     │                │                │                │
```

---

## Component Details

### 1. REST API Backend

**Purpose:** Central coordination point that receives hook events, manages session state, and serves data to the dashboard.

**Technology:** Node.js/Express with PostgreSQL

**Responsibilities:**
- Receive and store hook events from Claude Code
- Create and manage session records
- Serve session data to dashboard via REST endpoints
- Map Slack threads to session IDs

**Project Structure:**
```
src/
├── index.ts              # Express server entry point
├── api/
│   ├── routes.ts         # Main REST endpoints
│   └── hooks.ts          # Claude Code hook receivers
├── services/
│   └── workspace.ts      # Git/folder operations
└── db/
    ├── schema.sql        # PostgreSQL schema
    └── queries.ts        # Database query helpers
```

### 2. Claude Code (with Hooks)

**Purpose:** The AI coding agent that performs actual work.

**Configuration:** Hooks defined in `.claude/settings.json` or project-level `.claude/settings.local.json`

**Hook Types Used:**
- `postToolUse`: Fires after each tool execution (bash, file edit, search, etc.)
- `notification`: Fires on status messages from Claude Code

### 3. n8n Workflows

**Purpose:** Orchestrate the lifecycle of sessions and route messages.

**Workflows:**
1. **Session Initializer**: Creates session, prepares workspace, starts Claude Code
2. **Message Handler**: Routes Slack/email replies to continue sessions
3. **Session Monitor**: Periodic health checks and cleanup (optional)

### 4. Web Dashboard

**Purpose:** Visual monitoring of all active sessions and their command logs.

**Technology:** React with REST polling

**Features:**
- List all active/recent sessions
- View command execution history per session
- View conversation thread per session
- Manual intervention capability (send prompts)

### 5. PostgreSQL Database

**Purpose:** Persistent storage for sessions, messages, and command logs.

**Why PostgreSQL:**
- JSONB support for flexible metadata
- UUID generation for session IDs
- Reliable, well-understood, easy to query

---

## Data Flow

### Session Creation Flow

```
1. User triggers n8n webhook with project config
2. n8n calls POST /api/sessions with:
   - projectType: 'github' | 'local' | 'e2b' | 'worktree'
   - projectPath or githubRepo
   - initialPrompt
   - slackChannel (optional)
3. API creates workspace (clone repo, create folder, etc.)
4. API inserts session record, returns sessionId
5. n8n executes: claude --print -p "{prompt}" in workspace
6. Claude Code runs, hooks POST to /api/hooks/* on each tool use
7. n8n captures final output, sends to Slack
8. n8n stores thread_ts → sessionId mapping
```

### Message Continuation Flow

```
1. User replies in Slack thread
2. Slack webhook triggers n8n workflow
3. n8n looks up sessionId from thread_ts
4. n8n executes: claude --print --resume {claudeSessionId} -p "{reply}"
5. Claude Code runs with context restored
6. Hooks POST to /api/hooks/* on each tool use
7. n8n captures output, replies in Slack thread
```

### Dashboard Polling Flow

```
1. Dashboard loads, fetches GET /api/sessions
2. User selects session to view
3. Dashboard polls every 3 seconds:
   - GET /api/sessions/{id}/logs
   - GET /api/sessions/{id}/messages
4. UI updates with latest data
5. User can POST /api/sessions/{id}/messages to intervene
```

---

## Database Schema

```sql
-- Sessions: Core session tracking
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claude_session_id VARCHAR(255),      -- Claude Code's internal session ID
    project_path VARCHAR(500) NOT NULL,
    project_type VARCHAR(50) NOT NULL,   -- 'local', 'github', 'e2b', 'worktree'
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'paused', 'completed', 'error'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'          -- Flexible storage for config, prompts, etc.
);

-- Session Messages: Conversation history
CREATE TABLE session_messages (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL,      -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    source VARCHAR(50),                  -- 'slack', 'dashboard', 'n8n', 'cli', 'claude-hook'
    timestamp TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Command Logs: Tool execution history (populated by hooks)
CREATE TABLE command_logs (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    tool VARCHAR(100) NOT NULL,          -- 'bash', 'edit_file', 'read_file', etc.
    input JSONB,                         -- Tool input parameters
    result TEXT,                         -- Tool output/result
    status VARCHAR(20) DEFAULT 'completed',
    duration_ms INTEGER,
    timestamp TIMESTAMP DEFAULT NOW(),
    -- Event delivery tracking (for reliable hook processing)
    event_id UUID UNIQUE,                -- Unique event ID for idempotency
    delivery_status VARCHAR(20) DEFAULT 'delivered',  -- 'pending', 'delivered', 'failed', 'dead_letter'
    delivery_attempts INTEGER DEFAULT 1,
    last_delivery_attempt TIMESTAMP DEFAULT NOW(),
    delivery_error TEXT
);

-- Slack Thread Mapping: Link Slack threads to sessions
CREATE TABLE slack_thread_mapping (
    thread_ts VARCHAR(50) PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    channel_id VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- API Keys for authentication
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_messages_session ON session_messages(session_id, timestamp);
CREATE INDEX idx_logs_session ON command_logs(session_id, timestamp DESC);
CREATE INDEX idx_slack_session ON slack_thread_mapping(session_id);
CREATE INDEX idx_api_keys_active_key ON api_keys(key) WHERE active = true;
```

---

## API Reference

**Authentication:** All `/api/*` endpoints (except `/api/hooks/*`) require an API key in the `x-api-key` header.

### Sessions

#### Create Session
```
POST /api/sessions
Headers: x-api-key: YOUR_API_KEY

Body:
{
  "projectType": "github" | "local" | "e2b" | "worktree",
  "projectPath": "/path/to/workspace",        // for local/worktree
  "githubRepo": "owner/repo",                 // for github
  "initialPrompt": "Create a REST API...",
  "slackChannel": "#dev-automation"           // optional
}

Response:
{
  "sessionId": "uuid",
  "workspacePath": "/tmp/claude-workspaces/repo-1234567890",
  "status": "created"
}
```

#### List Sessions
```
GET /api/sessions
Headers: x-api-key: YOUR_API_KEY

Response:
[
  {
    "id": "uuid",
    "project_path": "/path/to/workspace",
    "project_type": "github",
    "status": "active",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:35:00Z"
  }
]
```

#### Get Session Details
```
GET /api/sessions/:id
Headers: x-api-key: YOUR_API_KEY

Response:
{
  "id": "uuid",
  "claude_session_id": "claude-internal-id",
  "project_path": "/path/to/workspace",
  "project_type": "github",
  "status": "active",
  "metadata": { ... },
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:35:00Z"
}
```

#### Update Session
```
PATCH /api/sessions/:id
Headers: x-api-key: YOUR_API_KEY

Body:
{
  "status": "completed",           // optional
  "claudeSessionId": "claude-id"   // optional
}

Response:
{ "status": "updated" }
```

### Messages

#### Get Session Messages
```
GET /api/sessions/:id/messages
Headers: x-api-key: YOUR_API_KEY

Response:
[
  {
    "id": 1,
    "direction": "user",
    "content": "Create a REST API for user management",
    "source": "slack",
    "timestamp": "2024-01-15T10:30:00Z"
  },
  {
    "id": 2,
    "direction": "assistant",
    "content": "I'll create a REST API...",
    "source": "claude",
    "timestamp": "2024-01-15T10:30:15Z"
  }
]
```

#### Add Message
```
POST /api/sessions/:id/messages
Headers: x-api-key: YOUR_API_KEY

Body:
{
  "direction": "user" | "assistant" | "system",
  "content": "Message content",
  "source": "slack" | "dashboard" | "n8n"
}

Response:
{ "status": "logged" }
```

### Command Logs

#### Get Session Logs
```
GET /api/sessions/:id/logs?limit=50
Headers: x-api-key: YOUR_API_KEY

Response:
[
  {
    "id": 1,
    "tool": "bash",
    "input": { "command": "npm init -y" },
    "result": "Wrote to /workspace/package.json...",
    "status": "completed",
    "duration_ms": 234,
    "timestamp": "2024-01-15T10:30:05Z"
  }
]
```

### Hooks (Called by Claude Code)

#### Tool Complete Hook
```
POST /api/hooks/tool-complete
Headers: x-hook-secret: YOUR_HOOK_SECRET (optional, if CLAUDE_HOOK_SECRET is set)

Body:
{
  "session": "claude-session-id",
  "tool": "bash",
  "input": { "command": "npm install express" },
  "result": "added 57 packages...",
  "duration_ms": 5432
}

Response: 200 OK
```

#### Notification Hook
```
POST /api/hooks/notification
Headers: x-hook-secret: YOUR_HOOK_SECRET (optional, if CLAUDE_HOOK_SECRET is set)

Body:
{
  "session": "claude-session-id",
  "message": "Task completed successfully"
}

Response: 200 OK
```

### Admin (API Key Management)

**Authorization:** All admin endpoints require an API key with `admin: true` in the metadata. Non-admin keys will receive a 403 Forbidden response.

**Bootstrap:** Create the first admin key using the CLI script:
```bash
npx tsx scripts/create-admin-key.ts "Initial Admin Key"
```

#### Create API Key
```
POST /api/admin/keys
Headers: x-api-key: YOUR_ADMIN_API_KEY

Body:
{
  "name": "n8n-integration",
  "metadata": { 
    "owner": "automation-team",
    "admin": true  // Set to true for admin privileges
  }
}

Response:
{
  "id": "uuid",
  "key": "64-character-hex-string",  // Only shown once!
  "name": "n8n-integration",
  "created_at": "2024-01-15T10:30:00Z",
  "message": "Store this key securely. It will not be shown again."
}
```

#### List API Keys
```
GET /api/admin/keys
Headers: x-api-key: YOUR_ADMIN_API_KEY

Response:
[
  {
    "id": "uuid",
    "name": "n8n-integration",
    "active": true,
    "created_at": "2024-01-15T10:30:00Z",
    "last_used_at": "2024-01-15T11:00:00Z",
    "metadata": { "owner": "automation-team" }
  }
]
```

#### Get API Key Details
```
GET /api/admin/keys/:id
Headers: x-api-key: YOUR_ADMIN_API_KEY

Response:
{
  "id": "uuid",
  "name": "n8n-integration",
  "active": true,
  "created_at": "2024-01-15T10:30:00Z",
  "last_used_at": "2024-01-15T11:00:00Z",
  "metadata": { "owner": "automation-team" }
}
```

#### Revoke API Key
```
PATCH /api/admin/keys/:id/revoke
Headers: x-api-key: YOUR_ADMIN_API_KEY

Response:
{ "status": "revoked", "id": "uuid" }
```

#### Delete API Key
```
DELETE /api/admin/keys/:id
Headers: x-api-key: YOUR_ADMIN_API_KEY

Response:
{ "status": "deleted", "id": "uuid" }
```

### Health Check

#### Health Status
```
GET /health
Headers: (none - unauthenticated endpoint)

Response:
{ "status": "ok", "timestamp": "2024-01-15T10:30:00Z" }
```

**Security Note:** The `/health` endpoint is intentionally unauthenticated for monitoring and load balancer health checks. It only exposes server status and timestamp, no sensitive information. In production deployments, consider restricting access via firewall rules or reverse proxy configuration if needed.

---

## Claude Code Hook Configuration

### Global Configuration

Location: `~/.claude/settings.json`

```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "*",
        "command": "curl -sS -X POST http://localhost:3001/api/hooks/tool-complete -H 'Content-Type: application/json' -d '{\"session\": \"'\"$CLAUDE_SESSION_ID\"'\", \"tool\": \"'\"$TOOL_NAME\"'\", \"result\": \"'\"$(echo $TOOL_RESULT | head -c 10000 | jq -Rs .)\"'\"}'"
      }
    ],
    "notification": [
      {
        "command": "curl -sS -X POST http://localhost:3001/api/hooks/notification -H 'Content-Type: application/json' -d '{\"session\": \"'\"$CLAUDE_SESSION_ID\"'\", \"message\": \"'\"$MESSAGE\"'\"}'"
      }
    ]
  }
}
```

### Project-Level Configuration

Location: `<project>/.claude/settings.local.json`

This overrides global settings for specific projects:

```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "*",
        "command": "/path/to/custom-hook.sh"
      }
    ]
  }
}
```

### Hook Environment Variables

Claude Code provides these environment variables to hooks:

| Variable | Description |
|----------|-------------|
| `CLAUDE_SESSION_ID` | The internal session identifier |
| `TOOL_NAME` | Name of the tool that was executed |
| `TOOL_RESULT` | Output/result of the tool execution |
| `TOOL_INPUT` | JSON string of tool input parameters |
| `MESSAGE` | Notification message (for notification hooks) |

### Reliable Hook Scripts

The orchestrator provides hook scripts with built-in reliability features:

**Location:** `hooks/claude-orchestrator-hook.sh` and `hooks/claude-orchestrator-notify.sh`

**Features:**
- **UUID-based event IDs** for idempotency (prevents duplicate processing)
- **Local event logging** before HTTP delivery (ensures no data loss)
- **Automatic retry queue** for failed deliveries
- **Graceful degradation** - always exits 0 to not block Claude Code

**Configuration:**

```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "*",
        "command": "/path/to/hooks/claude-orchestrator-hook.sh"
      }
    ],
    "notification": [
      {
        "command": "/path/to/hooks/claude-orchestrator-notify.sh"
      }
    ]
  }
}
```

**Environment Variables for Hook Scripts:**

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_ORCHESTRATOR_API` | API base URL | `http://localhost:3001` |
| `CLAUDE_ORCHESTRATOR_LOGS` | Event log directory | `/var/log/claude-orchestrator/events` |
| `CLAUDE_HOOK_SECRET` | Shared secret for auth | (none) |
| `HOOK_TIMEOUT` | HTTP timeout in seconds | `5` |

### Event Delivery Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code │────▶│ Hook Script │────▶│ Local Log   │────▶│ HTTP POST   │
└─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                   │
                    ┌──────────────────────────────────────────────┘
                    │
              ┌─────▼─────┐
              │  Success? │
              └─────┬─────┘
                    │
         ┌──────────┴──────────┐
         │                     │
    ┌────▼────┐          ┌─────▼─────┐
    │   Yes   │          │    No     │
    │ (done)  │          │ (retry)   │
    └─────────┘          └─────┬─────┘
                               │
                    ┌──────────▼──────────┐
                    │ Write to failed     │
                    │ events queue        │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Retry Daemon        │
                    │ (30s interval)      │
                    └─────────────────────┘
```

### Idempotency

Each event includes a unique `eventId` (UUID). The API checks for duplicates before inserting:

1. **Check phase:** SELECT to see if event_id exists
2. **Insert phase:** INSERT with event_id
3. **Constraint check:** UNIQUE constraint on event_id prevents race conditions

Duplicate events receive a `200 OK` response with `status: "duplicate"`.

### Retry Daemon

The background retry daemon automatically redelivers failed events:

- **Interval:** Configurable (default 30 seconds)
- **Backoff:** Exponential (30s, 60s, 120s, ... up to 1 hour)
- **Max attempts:** Configurable (default 10)
- **Dead letter:** Events exceeding max attempts move to dead letter queue

**Monitoring:**

```bash
# Check retry daemon status
curl http://localhost:3001/health

# Response includes:
{
  "status": "ok",
  "components": {
    "retryDaemon": {
      "running": true,
      "pendingRetries": 3,
      "deadLetterCount": 0
    }
  }
}
```

### Legacy Hook Script Example

For simple setups without reliability features:

```bash
#!/bin/bash
# /usr/local/bin/claude-hook.sh

API_URL="${CLAUDE_ORCHESTRATOR_API:-http://localhost:3001}"

# Truncate large results
RESULT=$(echo "$TOOL_RESULT" | head -c 50000)

# POST to API
curl -sS -X POST "$API_URL/api/hooks/tool-complete" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "session": "$CLAUDE_SESSION_ID",
  "tool": "$TOOL_NAME",
  "result": $(echo "$RESULT" | jq -Rs .),
  "input": $TOOL_INPUT
}
EOF
```

---

## n8n Workflow Configuration

### Workflow 1: Session Initializer

**Trigger:** Webhook POST to `/webhook/claude/start`

**Nodes:**

1. **Webhook** (Trigger)
   - Method: POST
   - Path: `claude/start`
   - Response: When Last Node Finishes

2. **Switch** (Route by projectType)
   - Property: `{{ $json.projectType }}`
   - Outputs: github, local, e2b, worktree

3. **Execute Command** (GitHub branch)
   ```bash
   gh repo clone {{ $json.githubRepo }} /tmp/claude-workspaces/{{ $json.projectName }}-$(date +%s)
   ```

4. **Execute Command** (Local branch)
   ```bash
   mkdir -p {{ $json.projectPath }}
   ```

5. **HTTP Request** (Create Session)
   - Method: POST
   - URL: `http://localhost:3001/api/sessions`
   - Body:
   ```json
   {
     "projectType": "{{ $json.projectType }}",
     "projectPath": "{{ $json.workspacePath }}",
     "initialPrompt": "{{ $json.prompt }}",
     "slackChannel": "{{ $json.slackChannel }}"
   }
   ```

6. **Execute Command** (Start Claude Code)
   ```bash
   cd {{ $json.workspacePath }} && \
   claude --print -p "{{ $json.prompt }}" 2>&1
   ```

7. **HTTP Request** (Update Session with Claude ID)
   - Method: PATCH
   - URL: `http://localhost:3001/api/sessions/{{ $json.sessionId }}`

8. **Slack** (Send Response)
   - Operation: Send Message
   - Channel: `{{ $json.slackChannel }}`
   - Text: `Started session {{ $json.sessionId }}\nReply to continue.`

9. **HTTP Request** (Store Thread Mapping)
   - Store `thread_ts` → `sessionId` mapping

### Workflow 2: Slack Message Handler

**Trigger:** Slack Event (message in channel)

**Nodes:**

1. **Slack Trigger**
   - Event: `message`
   - Filter: `thread_ts` exists (is a reply)

2. **HTTP Request** (Lookup Session)
   - GET `/api/slack-threads/{{ $json.thread_ts }}`

3. **IF** (Check for Close Command)
   - Condition: `{{ $json.text.toLowerCase().includes('close') || $json.text === '/done' }}`

4a. **HTTP Request** (Close Session - IF true)
    - PATCH `/api/sessions/{{ $json.sessionId }}`
    - Body: `{ "status": "completed" }`

4b. **Execute Command** (Continue Session - IF false)
    ```bash
    cd {{ $json.workspacePath }} && \
    claude --print --resume {{ $json.claudeSessionId }} -p "{{ $json.text }}" 2>&1
    ```

5. **HTTP Request** (Log User Message)
   - POST `/api/sessions/{{ $json.sessionId }}/messages`

6. **Slack** (Reply in Thread)
   - Reply to: `{{ $json.thread_ts }}`
   - Text: `{{ $json.claudeOutput }}`

### Workflow 3: Session Monitor (Optional)

**Trigger:** Schedule (every 5 minutes)

**Purpose:** Health checks and cleanup

**Nodes:**

1. **Schedule Trigger**
   - Interval: 5 minutes

2. **HTTP Request**
   - GET `/api/sessions?status=active`

3. **Loop Over Items**

4. **IF** (Stale Session Check)
   - Condition: `updated_at` older than 1 hour

5. **HTTP Request** (Mark as Stale)
   - PATCH `/api/sessions/{{ $json.id }}`
   - Body: `{ "status": "stale" }`

6. **Slack** (Notify)
   - Send alert about stale sessions

---

## Dashboard Implementation

### Project Structure

```
dashboard/
├── src/
│   ├── components/
│   │   ├── SessionList.tsx       # List of all sessions
│   │   ├── SessionPanel.tsx      # Single session detail view
│   │   ├── CommandLog.tsx        # Tool execution log
│   │   ├── MessageThread.tsx     # Conversation view
│   │   └── InterventionInput.tsx # Manual prompt input
│   ├── hooks/
│   │   └── usePolling.ts         # REST polling hook
│   ├── api/
│   │   └── client.ts             # API client functions
│   ├── types/
│   │   └── index.ts              # TypeScript interfaces
│   ├── App.tsx
│   └── index.tsx
├── package.json
└── tsconfig.json
```

### Polling Hook

```typescript
// src/hooks/usePolling.ts
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

    fetch();
    const interval = setInterval(fetch, intervalMs);

    return () => clearInterval(interval);
  }, [fetch, intervalMs, enabled]);

  return { data, error, loading, refetch: fetch };
}
```

### Session Panel Component

```typescript
// src/components/SessionPanel.tsx
import React, { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api/client';
import { Session, CommandLog, Message } from '../types';

interface SessionPanelProps {
  sessionId: string;
  onClose: () => void;
}

export function SessionPanel({ sessionId, onClose }: SessionPanelProps) {
  const [interventionText, setInterventionText] = useState('');

  const { data: logs } = usePolling<CommandLog[]>(
    () => api.getSessionLogs(sessionId),
    { intervalMs: 3000 }
  );

  const { data: messages, refetch: refetchMessages } = usePolling<Message[]>(
    () => api.getSessionMessages(sessionId),
    { intervalMs: 3000 }
  );

  const handleIntervention = async () => {
    if (!interventionText.trim()) return;
    
    await api.addMessage(sessionId, {
      direction: 'user',
      content: interventionText,
      source: 'dashboard'
    });
    
    setInterventionText('');
    refetchMessages();
  };

  return (
    <div className="session-panel">
      <header className="session-header">
        <h2>Session: {sessionId.slice(0, 8)}...</h2>
        <button onClick={onClose}>Close View</button>
      </header>

      <div className="session-content">
        <section className="messages-section">
          <h3>Conversation</h3>
          <div className="message-list">
            {messages?.map((msg) => (
              <div key={msg.id} className={`message message-${msg.direction}`}>
                <span className="message-source">{msg.source}</span>
                <span className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
                <pre className="message-content">{msg.content}</pre>
              </div>
            ))}
          </div>
          
          <div className="intervention-input">
            <textarea
              value={interventionText}
              onChange={(e) => setInterventionText(e.target.value)}
              placeholder="Send a message to this session..."
            />
            <button onClick={handleIntervention}>Send</button>
          </div>
        </section>

        <section className="logs-section">
          <h3>Command Log</h3>
          <div className="log-list">
            {logs?.map((log) => (
              <div key={log.id} className="log-entry">
                <span className="log-tool">{log.tool}</span>
                <span className="log-status">{log.status}</span>
                <span className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                {log.duration_ms && (
                  <span className="log-duration">{log.duration_ms}ms</span>
                )}
                <pre className="log-result">
                  {log.result?.slice(0, 500)}
                  {log.result?.length > 500 && '...'}
                </pre>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
```

### API Client

```typescript
// src/api/client.ts
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
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

export const api = {
  getSessions: () => fetchJson<Session[]>('/sessions'),
  
  getSession: (id: string) => fetchJson<Session>(`/sessions/${id}`),
  
  getSessionLogs: (id: string) => fetchJson<CommandLog[]>(`/sessions/${id}/logs`),
  
  getSessionMessages: (id: string) => fetchJson<Message[]>(`/sessions/${id}/messages`),
  
  addMessage: (id: string, message: Omit<Message, 'id' | 'timestamp'>) =>
    fetchJson<{ status: string }>(`/sessions/${id}/messages`, {
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

---

## Deployment

### Docker Compose

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: claude_orchestrator
      POSTGRES_USER: claude
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./src/db/schema.sql:/docker-entrypoint-initdb.d/schema.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U claude -d claude_orchestrator"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://claude:${POSTGRES_PASSWORD}@postgres:5432/claude_orchestrator
      WORKSPACE_BASE: /workspaces
      NODE_ENV: production
    volumes:
      - workspaces:/workspaces
      - ${HOME}/.claude:/root/.claude:ro  # Claude Code config (read-only)
    ports:
      - "3001:3001"
    depends_on:
      postgres:
        condition: service_healthy

  dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    environment:
      REACT_APP_API_URL: http://api:3001/api
    ports:
      - "3000:80"
    depends_on:
      - api

  n8n:
    image: n8nio/n8n:latest
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_USER}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD}
      - N8N_HOST=0.0.0.0
      - WEBHOOK_URL=http://localhost:5678/
    volumes:
      - n8n_data:/home/node/.n8n
      - workspaces:/workspaces
      - ${HOME}/.claude:/home/node/.claude:ro
    ports:
      - "5678:5678"
    depends_on:
      - api

volumes:
  postgres_data:
  workspaces:
  n8n_data:
```

### Environment Variables

Create a `.env` file:

```bash
# Database
POSTGRES_PASSWORD=your-secure-password

# n8n
N8N_USER=admin
N8N_PASSWORD=your-n8n-password

# API
API_PORT=3001
WORKSPACE_BASE=/tmp/claude-workspaces

# Slack (for n8n)
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret

# GitHub CLI (for repo cloning)
GH_TOKEN=ghp_your-token
```

### Dockerfile (API)

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Build
RUN npm run build

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

EXPOSE 3001

CMD ["node", "dist/index.js"]
```

---

## Extension Points

### Adding New Workspace Types

Extend `WorkspaceManager` to support additional execution environments:

```typescript
// src/services/workspace.ts
export class WorkspaceManager {
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
      case 'docker':
        return this.createDockerWorkspace(config);
      // Add new types here
      default:
        throw new Error(`Unknown project type: ${config.projectType}`);
    }
  }
}
```

### Adding New Messaging Integrations

Create new n8n workflows or add API endpoints:

```typescript
// src/api/integrations/discord.ts
router.post('/discord/webhook', async (req, res) => {
  const { channelId, messageId, content, sessionId } = req.body;
  
  // Log the message
  await db.query(
    `INSERT INTO session_messages (session_id, direction, content, source)
     VALUES ($1, 'user', $2, 'discord')`,
    [sessionId, content]
  );
  
  // Trigger continuation...
});
```

### Custom Hook Processors

Add specialized processing for specific tool types:

```typescript
// src/api/hooks.ts
router.post('/tool-complete', async (req, res) => {
  const { session, tool, result, input } = req.body;
  
  // Standard logging
  await logToolExecution(session, tool, result);
  
  // Custom processing by tool type
  switch (tool) {
    case 'bash':
      await processBashExecution(session, input, result);
      break;
    case 'edit_file':
      await trackFileChanges(session, input);
      break;
    case 'web_search':
      await cacheSearchResults(session, result);
      break;
  }
  
  res.sendStatus(200);
});
```

### Metrics and Observability

Add Prometheus metrics:

```typescript
// src/metrics.ts
import { Counter, Histogram, register } from 'prom-client';

export const toolExecutions = new Counter({
  name: 'claude_tool_executions_total',
  help: 'Total tool executions',
  labelNames: ['tool', 'status']
});

export const toolDuration = new Histogram({
  name: 'claude_tool_duration_ms',
  help: 'Tool execution duration in milliseconds',
  labelNames: ['tool'],
  buckets: [10, 50, 100, 500, 1000, 5000, 10000]
});

// In hooks.ts
router.post('/tool-complete', async (req, res) => {
  toolExecutions.inc({ tool: req.body.tool, status: 'completed' });
  if (req.body.duration_ms) {
    toolDuration.observe({ tool: req.body.tool }, req.body.duration_ms);
  }
  // ...
});
```

---

## Security Considerations

### API Authentication

The system uses database-backed API key authentication for all `/api/*` routes (except hooks):

```typescript
// src/middleware/auth.ts
import { Pool } from 'pg';
import { validateApiKey } from '../db/queries';

export function createApiKeyAuth(db: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      res.status(401).json({ error: 'API key required', code: 'MISSING_API_KEY' });
      return;
    }

    const keyRecord = await validateApiKey(db, apiKey);
    if (!keyRecord) {
      res.status(401).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
      return;
    }

    req.apiKey = keyRecord; // Attach for downstream use
    next();
  };
}

// Applied in index.ts:
app.use('/api/hooks', hookAuth, createHookRouter(db)); // Separate auth for hooks
app.use('/api', apiKeyAuth, createRouter(db));         // API key auth for all other routes
```

### API Key Management

API keys are stored in the `api_keys` table with:
- Unique 64-character hex key (generated via `crypto.randomBytes(32)`)
- `last_used_at` timestamp updated on each successful authentication (tracks actual API usage)
- `active` flag for soft revocation (revoked keys remain in database for audit)
- JSONB metadata for extensibility (e.g., `{"admin": true, "owner": "team-name"}`)

**Authorization Model:**
- Admin endpoints require `metadata.admin = true` on the authenticating API key
- Non-admin keys receive 403 Forbidden when accessing admin endpoints
- First admin key must be created via CLI: `npx tsx scripts/create-admin-key.ts`

Admin endpoints for key management:
- `POST /api/admin/keys` - Create new key (returns key once, never again) - **Requires admin**
- `GET /api/admin/keys` - List keys (without exposing key values) - **Requires admin**
- `PATCH /api/admin/keys/:id/revoke` - Revoke a key - **Requires admin**
- `DELETE /api/admin/keys/:id` - Permanently delete a key - **Requires admin**

### Hook Authentication

Hook endpoints use optional shared secret authentication via the `CLAUDE_HOOK_SECRET` environment variable:

**⚠️ Production Security:** If `CLAUDE_HOOK_SECRET` is not set, hook endpoints are **unauthenticated** and a warning is logged. This is acceptable for development but **should not be used in production**. Always set `CLAUDE_HOOK_SECRET` in production environments to prevent unauthorized hook submissions.

The implementation uses constant-time comparison to prevent timing attacks:

```typescript
// src/middleware/auth.ts
export function createHookAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hookSecret = process.env.CLAUDE_HOOK_SECRET;

    // If no hook secret configured, allow all requests (development mode only!)
    if (!hookSecret) {
      console.warn('CLAUDE_HOOK_SECRET not set - hook endpoints are unauthenticated. Set this in production!');
      next();
      return;
    }

    const providedSecret = req.headers['x-hook-secret'];
    // Uses crypto.timingSafeEqual for constant-time comparison
    // (implementation details in source code)
  };
}
```

When `CLAUDE_HOOK_SECRET` is set, Claude Code hooks must include the secret:
```json
{
  "hooks": {
    "postToolUse": [{
      "matcher": "*",
      "command": "curl -sS -X POST http://localhost:3001/api/hooks/tool-complete -H 'x-hook-secret: YOUR_SECRET' -H 'Content-Type: application/json' ..."
    }]
  }
}
```

### Hook Validation

Validate that hooks originate from expected sources:

```typescript
router.post('/tool-complete', async (req, res) => {
  // Verify the session exists and is active
  const session = await db.query(
    'SELECT id FROM sessions WHERE claude_session_id = $1 AND status = $2',
    [req.body.session, 'active']
  );

  if (!session.rows.length) {
    return res.status(404).json({ error: 'Session not found or inactive' });
  }

  // Proceed with logging...
});
```

### Workspace Isolation

Ensure workspaces are properly isolated:

```typescript
async cloneGitHubRepo(repo: string): Promise<string> {
  // Validate repo format
  if (!/^[\w-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('Invalid repository format');
  }
  
  // Create isolated directory
  const workspaceId = uuidv4();
  const basePath = process.env.WORKSPACE_BASE || '/tmp/claude-workspaces';
  const targetPath = path.join(basePath, workspaceId);
  
  // Ensure we're not escaping the base path
  if (!targetPath.startsWith(basePath)) {
    throw new Error('Invalid workspace path');
  }
  
  await fs.mkdir(targetPath, { recursive: true });
  execSync(`gh repo clone ${repo} ${targetPath}`, { timeout: 60000 });
  
  return targetPath;
}
```

---

## Troubleshooting

### Hooks Not Firing

1. Verify hook configuration in `~/.claude/settings.json`
2. Check Claude Code version supports hooks
3. Test hook command manually:
   ```bash
   CLAUDE_SESSION_ID=test TOOL_NAME=bash TOOL_RESULT=ok \
     curl -X POST http://localhost:3001/api/hooks/tool-complete ...
   ```

### Session Not Resuming

1. Verify `claude_session_id` is stored in database
2. Check Claude Code session exists: `ls ~/.claude/projects/`
3. Ensure `--resume` flag uses correct session ID

### Dashboard Not Updating

1. Check polling interval (default 3 seconds)
2. Verify API connectivity: `curl http://localhost:3001/api/sessions`
3. Check browser console for errors

### n8n Workflow Failures

1. Check n8n execution logs
2. Verify environment variables are set
3. Test API endpoints manually
4. Ensure Claude Code is installed in n8n container

### Failed Event Delivery

1. Check the retry daemon is running:
   ```bash
   curl http://localhost:3001/health
   ```

2. Check for pending retries:
   ```bash
   cat /var/log/claude-orchestrator/events/failed-events.ndjson
   ```

3. Check dead letter queue for events that exceeded max retries:
   ```bash
   cat /var/log/claude-orchestrator/events/dead-letter.ndjson
   ```

4. Verify event log directory permissions:
   ```bash
   ls -la /var/log/claude-orchestrator/events/
   # Should be writable by both hook scripts and API server
   ```

5. Test hook delivery manually:
   ```bash
   # With event ID for idempotency
   curl -X POST http://localhost:3001/api/hooks/tool-complete \
     -H "Content-Type: application/json" \
     -d '{"eventId":"550e8400-e29b-41d4-a716-446655440000","session":"test","tool":"bash","result":"ok"}'
   ```

6. Check database for delivery statistics:
   ```sql
   SELECT delivery_status, COUNT(*)
   FROM command_logs
   WHERE event_id IS NOT NULL
   GROUP BY delivery_status;
   ```

### Recovering Dead Letter Events

Dead letter events can be manually reprocessed:

```bash
# Read dead letter events
cat /var/log/claude-orchestrator/events/dead-letter.ndjson | jq .

# Manually retry a specific event
cat dead-letter.ndjson | jq -r 'select(.event.eventId == "your-event-id") | .event' | \
  curl -X POST http://localhost:3001/api/hooks/tool-complete \
    -H "Content-Type: application/json" \
    -d @-
```

---

## License

MIT License - See LICENSE file for details.
