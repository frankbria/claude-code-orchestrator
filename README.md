# Claude Code Orchestrator

A headless orchestration system for Claude Code that enables autonomous operation through n8n workflows, parallel session management, bidirectional messaging, and real-time monitoring.

## Overview

**claude-orchestrator** transforms Claude Code from an interactive CLI tool into a headless automation platform. Instead of manually running Claude Code and monitoring output, this system provides:

- **Headless Execution**: Trigger Claude Code sessions via n8n workflows or API calls
- **Parallel Sessions**: Run multiple Claude Code instances simultaneously using git worktrees, local folders, or E2B sandboxes
- **Bidirectional Messaging**: Continue conversations through Slack threads or email
- **Real-Time Monitoring**: Track tool executions and session state via web dashboard
- **Event Tracking**: Capture all tool executions using Claude Code's native hooks

## Architecture

The system uses a hook-based architecture instead of process wrapping for simplicity and reliability:

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

### Key Design Decisions

**Hooks Over Process Wrapping**: Uses Claude Code's native hooks to POST events directly to the API instead of wrapping processes, parsing stdout, and managing WebSocket connections.

**Polling Over WebSocket**: Dashboard polls REST API every 3 seconds instead of using WebSocket, which is simpler and sufficient for monitoring use cases.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## Features

- **Session Management**: Create, track, and resume Claude Code sessions
- **Multi-Workspace Support**: GitHub repos, local folders, git worktrees, E2B sandboxes
- **Hook-Based Event Tracking**: Capture tool executions via Claude Code's native hooks
- **Conversation History**: Store all user/assistant messages with timestamps
- **Command Logging**: Track every tool execution with input, output, and duration
- **Slack Integration**: Start and continue sessions via Slack threads
- **Web Dashboard**: Monitor sessions, view logs, intervene manually
- **n8n Workflows**: Automate session lifecycle and message routing

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Claude Code CLI (`@anthropic-ai/claude-code`)
- n8n (optional, for workflow automation)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/frankbria/claude-orchestrator.git
   cd claude-orchestrator
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd dashboard && npm install && cd ..
   ```

3. **Set up PostgreSQL database**
   ```bash
   createdb claude_orchestrator
   psql -d claude_orchestrator -f src/db/schema.sql
   ```

4. **Configure environment**

   Create `.env` file:
   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/claude_orchestrator
   API_PORT=3001
   WORKSPACE_BASE=/tmp/claude-workspaces
   ```

5. **Configure Claude Code hooks**

   Add to `~/.claude/settings.json`:
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

6. **Start the services**
   ```bash
   # Terminal 1: API server
   npx tsx src/index.ts

   # Terminal 2: Dashboard
   cd dashboard && npm start
   ```

7. **Access the dashboard**

   Open http://localhost:3000

## Usage

### Creating a Session via API

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "projectType": "github",
    "githubRepo": "owner/repo",
    "initialPrompt": "Review the codebase and suggest improvements",
    "slackChannel": "#dev-automation"
  }'
```

Response:
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "workspacePath": "/tmp/claude-workspaces/repo-1234567890",
  "status": "created"
}
```

### Running Claude Code with Session Tracking

```bash
cd /tmp/claude-workspaces/repo-1234567890
claude --print -p "Review the authentication module"
```

Hooks will automatically POST tool executions to the API.

### Continuing a Session

```bash
# Get the claude_session_id from the database or API
claude --print --resume <claude-session-id> -p "Now check the database queries"
```

### Viewing Sessions in Dashboard

1. Navigate to http://localhost:3000
2. View list of all sessions
3. Click on a session to see:
   - Conversation history
   - Tool execution logs
   - Session metadata
4. Send manual interventions via dashboard input

## API Reference

### Sessions

- `POST /api/sessions` - Create new session
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get session details
- `PATCH /api/sessions/:id` - Update session (status, claude_session_id)

### Messages

- `GET /api/sessions/:id/messages` - Get conversation history
- `POST /api/sessions/:id/messages` - Add message

### Command Logs

- `GET /api/sessions/:id/logs?limit=50` - Get tool execution history

### Hooks

- `POST /api/hooks/tool-complete` - Log tool execution (called by Claude Code)
- `POST /api/hooks/notification` - Log notification (called by Claude Code)

See [ARCHITECTURE.md](ARCHITECTURE.md) for complete API documentation.

## n8n Integration

The system is designed to work with n8n workflows for automation:

### Workflow 1: Session Initializer

**Trigger**: Webhook POST to `/webhook/claude/start`

**Flow**:
1. Receive webhook with project config
2. Prepare workspace (clone repo, create folder, etc.)
3. Create session record via API
4. Execute `claude --print -p "{prompt}"`
5. Capture output and send to Slack/email
6. Store thread mapping for continuations

### Workflow 2: Message Handler

**Trigger**: Slack event (message in thread)

**Flow**:
1. Lookup session from thread_ts
2. Execute `claude --resume {session} -p "{message}"`
3. Capture output
4. Reply in Slack thread

See [ARCHITECTURE.md](ARCHITECTURE.md) for complete n8n workflow configurations.

## Database Schema

PostgreSQL tables:

- **sessions**: Session metadata (id, project_path, status, claude_session_id, metadata JSONB)
- **session_messages**: Conversation history (direction, content, source, timestamp)
- **command_logs**: Tool execution logs (tool, input JSONB, result, duration_ms)
- **slack_thread_mapping**: Maps Slack thread_ts to session_id

Schema file: `src/db/schema.sql`

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `API_PORT` | API server port | `3001` |
| `WORKSPACE_BASE` | Base directory for workspaces | `/tmp/claude-workspaces` |
| `N8N_WEBHOOK_BASE` | n8n webhook URL | - |
| `SLACK_BOT_TOKEN` | Slack bot token | - |
| `SLACK_SIGNING_SECRET` | Slack signing secret | - |

### Claude Code Hooks

**Global configuration**: `~/.claude/settings.json`
**Project-level configuration**: `<project>/.claude/settings.local.json`

Hook environment variables provided by Claude Code:
- `CLAUDE_SESSION_ID`: Internal session identifier
- `TOOL_NAME`: Name of executed tool
- `TOOL_RESULT`: Output of tool execution
- `TOOL_INPUT`: JSON string of tool input parameters

## Development

### Project Structure

```
claude-orchestrator/
├── src/
│   ├── index.ts              # Express server entry point
│   ├── api/
│   │   ├── routes.ts         # Main REST endpoints
│   │   └── hooks.ts          # Claude Code hook receivers
│   ├── services/
│   │   └── workspace.ts      # Git/folder operations
│   └── db/
│       ├── schema.sql        # PostgreSQL schema
│       └── queries.ts        # Database query helpers
├── dashboard/
│   └── src/
│       ├── components/       # React components
│       ├── hooks/            # Custom hooks (polling)
│       └── api/              # API client
├── ARCHITECTURE.md           # Detailed architecture documentation
├── CLAUDE.md                 # Claude Code guidance
├── PRD.md                    # Product Requirements Document
├── TECHNICAL_SPEC.md         # Technical specifications
└── package.json
```

### Running Tests

Currently no tests configured. Consider adding:
```bash
npm run test       # Jest/Vitest unit tests
npm run test:e2e   # Playwright E2E tests
```

### Type Checking

```bash
npx tsc --noEmit
```

### Building

Currently uses `tsx` for direct TypeScript execution. Consider adding build:
```bash
npm run build      # Compile TypeScript to dist/
```

## Deployment

### Docker Compose

See [ARCHITECTURE.md](ARCHITECTURE.md) for complete Docker Compose configuration including:
- PostgreSQL with automatic schema initialization
- API server with workspace volumes
- Dashboard with static build
- n8n with shared workspace access

### Production Considerations

1. **Authentication**: Add API key middleware for production
2. **SSL/TLS**: Use reverse proxy (nginx) with Let's Encrypt
3. **Database**: Use managed PostgreSQL (AWS RDS, etc.)
4. **Monitoring**: Add Prometheus metrics and Grafana dashboards
5. **Logging**: Implement structured logging with log aggregation
6. **Backup**: Regular database backups and workspace snapshots

## Troubleshooting

### Hooks Not Firing

1. Verify hook configuration in `~/.claude/settings.json`
2. Check Claude Code version supports hooks
3. Test hook manually:
   ```bash
   curl -X POST http://localhost:3001/api/hooks/tool-complete \
     -H 'Content-Type: application/json' \
     -d '{"session":"test","tool":"bash","result":"hello"}'
   ```

### Session Not Resuming

1. Verify `claude_session_id` in database
2. Check Claude Code session exists: `ls ~/.claude/projects/`
3. Ensure `--resume` uses correct session ID

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
- **Database**: PostgreSQL 15+ (JSONB support)
- **Frontend**: React, TypeScript
- **Orchestration**: n8n
- **Runtime**: tsx (TypeScript execution)
- **AI**: Claude Code CLI (@anthropic-ai/claude-code)

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Complete architecture documentation
- [CLAUDE.md](.claude/CLAUDE.md) - Claude Code development guidance
- [PRD.md](PRD.md) - Product Requirements Document
- [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) - Technical specifications

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Roadmap

### Phase 1: Core Infrastructure (Current)
- [x] Hook-based event tracking
- [x] PostgreSQL session storage
- [x] REST API for session management
- [x] Basic web dashboard

### Phase 2: Integration & Automation
- [ ] n8n workflow templates
- [ ] Slack integration (bidirectional)
- [ ] Email integration (Gmail/SendGrid)
- [ ] E2B sandbox support

### Phase 3: Production Readiness
- [ ] Authentication & authorization
- [ ] Prometheus metrics & monitoring
- [ ] Docker Compose deployment
- [ ] Automated tests (unit + E2E)

### Phase 4: Advanced Features
- [ ] Multi-user support
- [ ] Session templates & presets
- [ ] Advanced filtering & search
- [ ] Export/import sessions

## Support

- **Issues**: https://github.com/frankbria/claude-orchestrator/issues
- **Discussions**: https://github.com/frankbria/claude-orchestrator/discussions

## Acknowledgments

Built with [Claude Code](https://claude.ai/code) by Anthropic.
