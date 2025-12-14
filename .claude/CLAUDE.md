# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-orchestrator** is a headless orchestration system for Claude Code that enables autonomous operation through n8n workflows. It provides a complete infrastructure for managing parallel Claude Code sessions with bidirectional messaging (Slack/email), real-time monitoring via web dashboard, and session state persistence in PostgreSQL.

### Core Value Proposition

Instead of manually running Claude Code and monitoring output, this system enables:
- **Headless execution** via n8n workflow triggers
- **Parallel sessions** using git worktrees, local folders, or E2B sandboxes
- **Bidirectional conversations** through Slack threads or email
- **Real-time monitoring** with web dashboard polling
- **Event tracking** using Claude Code's native hooks (not process wrapping)

## Key Design Decisions

### Hooks Over Process Wrapping

The system uses Claude Code's **native hooks** to POST events directly to the backend API instead of wrapping Claude Code in a process manager. This eliminates:
- Process wrapper classes with EventEmitter patterns
- stdout/stderr stream parsing and buffering
- WebSocket server infrastructure and connection management
- Redis pub-sub for event distribution

Benefits:
- Simpler, stateless API backend
- Claude Code runs naturally without supervision
- Dashboard uses straightforward REST polling (3-second intervals)
- Easier debugging and lower resource overhead

### Polling Over WebSocket

For the monitoring dashboard, REST polling is sufficient because:
- Tool execution monitoring doesn't require sub-second latency
- We're not building a terminal emulator or streaming tokens
- Polling is simpler, more reliable, and connection-state-free
- 2-3 second polling is adequate for the use case

## Architecture

### System Components

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   n8n       │───▶│  REST API   │◀───│  Message    │
│  Workflows  │    │  Backend    │    │  Router     │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Claude Code │    │ PostgreSQL  │    │ Slack/Email │
│ (w/ hooks)  │    │             │    │  Webhooks   │
└─────────────┘    └─────────────┘    └─────────────┘
       │
       │ POST /api/hooks/* (on each tool use)
       ▼
┌─────────────────────────────────────────────────────┐
│        Web Dashboard (React + REST Polling)         │
└─────────────────────────────────────────────────────┘
```

### Backend Structure (`/src`)

- **`src/index.ts`**: Express server on port 3001 with PostgreSQL connection pool
- **`src/api/routes.ts`**: RESTful API endpoints
  - Session CRUD operations (GET, POST, PATCH `/api/sessions`)
  - Message logging and retrieval (`/api/sessions/:id/messages`)
  - Command log queries (`/api/sessions/:id/logs`)
  - GitHub repository cloning for project initialization
- **`src/api/hooks.ts`**: Claude Code hook receivers
  - `POST /api/hooks/tool-complete`: Fires after each tool execution
  - `POST /api/hooks/notification`: Fires on Claude Code status messages
- **`src/services/workspace.ts`**: Workspace management
  - GitHub cloning, local folders, git worktrees, E2B sandboxes
- **`src/services/sessionMonitor.ts`**: Session health monitoring
  - Stale session detection (no heartbeat for 2+ minutes)
  - Process liveness checks via PID tracking
  - Automatic status transitions to 'stale' or 'crashed'
- **`src/db/`**: Database schema and query helpers

### Dashboard (`/dashboard`)

React-based monitoring interface:
- **`SessionList.tsx`**: List of all active/recent sessions
- **`SessionPanel.tsx`**: Single session detail view with messages and logs
- **`CommandLog.tsx`**: Tool execution history
- **`MessageThread.tsx`**: Conversation view
- **`usePolling.ts`**: Custom hook for REST polling (3-second intervals)

### Database Schema

PostgreSQL tables:
- **`sessions`**: Session metadata (id, project_path, status, claude_session_id, metadata JSONB)
- **`session_messages`**: Conversation history (direction, content, source, timestamp)
- **`command_logs`**: Tool execution logs (tool, input JSONB, result, duration_ms)
- **`slack_thread_mapping`**: Maps Slack thread_ts to session_id

## Development Commands

### Setup
```bash
npm install                    # Install dependencies
```

### Database Setup
```bash
# Create PostgreSQL database
createdb claude_orchestrator

# Run schema
psql -d claude_orchestrator -f src/db/schema.sql
```

### Running
```bash
npx tsx src/index.ts           # Run API server on port 3001
cd dashboard && npm start      # Run dashboard on port 3000
```

### Type Checking
```bash
npx tsc --noEmit               # Type check without build
```

**Note:** The project currently lacks configured build, test, and lint scripts. Consider adding:
- `npm run build`: Compile TypeScript to `dist/`
- `npm run test`: Jest/Vitest unit tests
- `npm run lint`: ESLint + Prettier

## Environment Configuration

Create `.env` in project root:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/claude_orchestrator

# API Server
API_PORT=3001
WORKSPACE_BASE=/tmp/claude-workspaces

# Optional: n8n webhook URLs
N8N_WEBHOOK_BASE=http://localhost:5678

# Optional: Slack integration
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret

# Session Monitor Configuration
ENABLE_SESSION_MONITOR=true
SESSION_STALE_TIMEOUT_MINUTES=2
SESSION_STALE_CRON=* * * * *
SESSION_LIVENESS_CRON=*/5 * * * *
```

## Claude Code Hook Configuration

### Global Hook Setup

Location: `~/.claude/settings.json`

```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "*",
        "command": "curl -sS -X POST http://localhost:3001/api/hooks/tool-complete -H 'Content-Type: application/json' -d '{\"session\": \"'\"$CLAUDE_SESSION_ID\"'\", \"tool\": \"'\"$TOOL_NAME\"'\", \"result\": \"'\"$(echo $TOOL_RESULT | head -c 10000 | jq -Rs .)\"'\"}'"
      }
    ]
  }
}
```

### Project-Level Hooks

Location: `.claude/settings.local.json` (overrides global settings)

This allows different projects to POST to different orchestrator instances.

## n8n Integration

### Required Workflows

1. **Session Initializer**: Creates session, prepares workspace, starts Claude Code
   - Trigger: Webhook POST to `/webhook/claude/start`
   - Actions: Clone repo → Create session → Execute claude CLI → Store thread mapping

2. **Message Handler**: Routes Slack/email replies to continue sessions
   - Trigger: Slack event (message in thread)
   - Actions: Lookup session → Execute `claude --resume` → Reply to thread

3. **Session Monitor** (optional): Periodic health checks and cleanup
   - Trigger: Schedule (every 5 minutes)
   - Actions: Mark stale sessions → Send alerts

## API Endpoints

### Sessions (API Key Authentication Required)
All session endpoints require API key authentication via the `x-api-key` header:
- `POST /api/sessions` - Create new session
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get session details
- `PATCH /api/sessions/:id` - Update session (status, claude_session_id, metadata)
- `POST /api/sessions/:id/heartbeat` - Signal session liveness (API key auth)

### Messages (API Key Authentication Required)
- `GET /api/sessions/:id/messages` - Get conversation history
- `POST /api/sessions/:id/messages` - Add message (for dashboard intervention)

### Command Logs (API Key Authentication Required)
- `GET /api/sessions/:id/logs?limit=50` - Get tool execution history

### Hooks (Hook Secret Authentication)
Hook endpoints use a separate authentication mechanism via the `x-hook-secret` header.
These are called by Claude Code hook scripts:
- `POST /api/hooks/tool-complete` - Log tool execution
- `POST /api/hooks/notification` - Log Claude Code notification
- `POST /api/hooks/sessions/:id/heartbeat` - Signal session liveness (hook auth)

**Authentication Configuration:**
- API key: Set `ORCHESTRATOR_API_KEY` environment variable in hook scripts
- Hook secret: Set `HOOK_SECRET` environment variable (must match server's `HOOK_SECRET`)
- Hook scripts should include error handling for 401/403 responses to surface auth failures

### Session Status Values
- `active` - Session is running and receiving heartbeats
- `paused` - Session is paused
- `completed` - Session finished successfully
- `error` - Session encountered an error
- `stale` - Session stopped sending heartbeats (detected by session monitor)
- `crashed` - Claude Code process died (detected by PID liveness check)

## Development Workflow

### Adding New Features

1. **Backend API changes**: Update `src/api/routes.ts` or `src/api/hooks.ts`
2. **Database changes**: Modify `src/db/schema.sql` (add migrations if needed)
3. **Dashboard changes**: Update React components in `dashboard/src/components/`
4. **n8n workflow changes**: Export workflow JSON, document in ARCHITECTURE.md

### Testing Hooks Locally

```bash
# Simulate tool completion hook
CLAUDE_SESSION_ID=test-session \
TOOL_NAME=bash \
TOOL_RESULT="hello world" \
curl -X POST http://localhost:3001/api/hooks/tool-complete \
  -H 'Content-Type: application/json' \
  -d '{"session":"test-session","tool":"bash","result":"hello world"}'
```

### Testing Session Flow

1. Start API server: `npx tsx src/index.ts`
2. Create session via API:
   ```bash
   curl -X POST http://localhost:3001/api/sessions \
     -H 'Content-Type: application/json' \
     -d '{"projectType":"local","projectPath":"/tmp/test","initialPrompt":"Hello"}'
   ```
3. Run Claude Code with hooks configured
4. Check dashboard at `http://localhost:3000`

## Troubleshooting

### Hooks Not Firing
1. Verify hook configuration in `~/.claude/settings.json`
2. Check Claude Code version supports hooks
3. Test hook command manually (see above)

### Session Not Resuming
1. Verify `claude_session_id` is stored in database
2. Check Claude Code session exists: `ls ~/.claude/projects/`
3. Ensure `--resume` flag uses correct session ID

### Dashboard Not Updating
1. Check polling interval (default 3 seconds)
2. Verify API connectivity: `curl http://localhost:3001/api/sessions`
3. Check browser console for errors

### Database Connection Issues
1. Verify PostgreSQL is running: `pg_isready`
2. Check `DATABASE_URL` in `.env`
3. Ensure database and tables exist

## Technology Stack

- **Backend**: Node.js, Express v5, TypeScript
- **Database**: PostgreSQL 15+ (JSONB support required)
- **Frontend**: React, TypeScript
- **Orchestration**: n8n
- **Runtime**: tsx (TypeScript execution without build)
- **Module System**: CommonJS (not ESM)

## Future Enhancements

Consider adding:
- **Authentication**: API key middleware for production
- **Metrics**: Prometheus metrics for tool execution tracking
- **Docker Compose**: Single-command deployment
- **E2B Integration**: Sandbox execution environment
- **Email Integration**: Gmail/SendGrid message routing
- **Build Pipeline**: TypeScript compilation and bundling
- **Tests**: Jest unit tests for API endpoints and hooks
