# Product Requirements Document: Claude Code Orchestrator

**Version**: 1.0
**Date**: December 12, 2025
**Status**: Planning
**Owner**: Frank Bria

---

## Executive Summary

The Claude Code Orchestrator is a headless automation platform that transforms Claude Code from an interactive CLI tool into an autonomous coding agent that can be triggered, monitored, and integrated into workflows. It enables teams to leverage Claude Code for continuous development, automated code reviews, scheduled maintenance tasks, and collaborative coding without manual intervention.

**Key Value Proposition**: Enable Claude Code to work autonomously in the background, accept requests via messaging platforms, maintain conversation context across sessions, and provide visibility into all AI-driven development activities.

---

## Problem Statement

### Current Challenges

1. **Manual Operation Required**: Claude Code requires manual CLI interaction, preventing automation and headless operation
2. **No Session Persistence**: Difficult to track and resume long-running development sessions
3. **Limited Collaboration**: No built-in way to share Claude Code sessions or allow team collaboration
4. **Poor Visibility**: Tool executions and decisions are only visible in terminal output
5. **No Integration**: Cannot integrate Claude Code into existing workflows (CI/CD, Slack, email)
6. **Sequential Work**: Cannot run multiple Claude Code sessions in parallel efficiently

### User Pain Points

**Developer Pain Points**:
- "I want to trigger Claude Code from Slack without opening a terminal"
- "I need to see what Claude Code did while I was away"
- "I can't easily share an ongoing Claude Code session with my team"
- "I want to run Claude Code on multiple repos simultaneously"

**Team Lead Pain Points**:
- "I need visibility into AI-driven code changes across the team"
- "I want to audit what Claude Code has done in production repos"
- "I need to ensure Claude Code follows our development standards"

**DevOps Pain Points**:
- "I want to trigger automated refactoring on schedule"
- "I need to integrate Claude Code into our CI/CD pipeline"
- "I want to run Claude Code in isolated sandboxes for security"

---

## Goals and Objectives

### Primary Goals

1. **Enable Headless Operation**: Allow Claude Code to be triggered and run without manual CLI interaction
2. **Provide Session Management**: Track, persist, and resume Claude Code sessions across time
3. **Enable Workflow Integration**: Integrate with n8n, Slack, email, and other automation tools
4. **Deliver Real-Time Visibility**: Show what Claude Code is doing in real-time via web dashboard
5. **Support Parallel Execution**: Run multiple Claude Code sessions simultaneously on different projects

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Session Creation Time | < 10 seconds | Time from API call to Claude Code execution |
| Hook Delivery Latency | < 500ms | Time from tool execution to database log |
| Dashboard Update Latency | < 5 seconds | Time from event to dashboard display |
| Concurrent Sessions | 10+ sessions | Number of parallel Claude Code processes |
| Session Resume Success Rate | > 95% | Percentage of successful session resumptions |
| API Uptime | > 99.5% | Percentage of time API is available |

### Non-Goals (Out of Scope)

- **Real-time token streaming**: Not building a terminal emulator
- **Claude API integration**: Using Claude Code CLI, not Anthropic API directly
- **Custom AI models**: Only supports Claude Code's built-in models
- **Code execution sandboxing**: Relies on E2B or external sandboxes, not built-in
- **Multi-tenancy**: Initial version is single-tenant

---

## User Personas

### Persona 1: Solo Developer (Alex)

**Background**: Full-stack developer working on multiple side projects
**Goals**: Automate repetitive coding tasks, get help with code reviews
**Pain Points**: Limited time, switching between projects, forgets context
**Usage Pattern**: Triggers Claude Code from Slack to work on repos while focusing on other tasks

**Key Features for Alex**:
- Slack integration for triggering sessions
- Session history to see what was done
- Parallel sessions for multiple projects
- Easy resume for continuing work

### Persona 2: Engineering Team Lead (Jordan)

**Background**: Leads team of 5 developers, responsible for code quality
**Goals**: Monitor AI assistance usage, ensure code standards, audit changes
**Pain Points**: Needs visibility into AI-driven changes, wants to control access
**Usage Pattern**: Uses dashboard to monitor team's Claude Code sessions, reviews logs

**Key Features for Jordan**:
- Dashboard with all team sessions
- Audit logs of tool executions
- Filtering and search capabilities
- Export session history

### Persona 3: DevOps Engineer (Sam)

**Background**: Manages CI/CD pipelines, automation infrastructure
**Goals**: Integrate Claude Code into workflows, automate maintenance
**Pain Points**: Needs reliable API, wants containerized deployment
**Usage Pattern**: Sets up n8n workflows to trigger Claude Code on schedule or events

**Key Features for Sam**:
- REST API for automation
- Docker deployment
- Webhook integration
- E2B sandbox support

---

## Feature Requirements

### Must-Have (MVP)

#### 1. Session Management API

**Description**: REST API for creating, listing, and updating Claude Code sessions

**User Stories**:
- As a developer, I want to create a new Claude Code session via API
- As a team lead, I want to list all active sessions
- As a developer, I want to update session status (pause, resume, close)

**Acceptance Criteria**:
- [ ] POST /api/sessions creates session and returns session ID
- [ ] GET /api/sessions returns list of sessions with metadata
- [ ] GET /api/sessions/:id returns session details
- [ ] PATCH /api/sessions/:id updates session status
- [ ] Session includes: id, project_path, status, created_at, updated_at

**Technical Requirements**:
- PostgreSQL for session storage
- UUID for session IDs
- JSONB metadata field for extensibility

#### 2. Hook-Based Event Tracking

**Description**: Capture Claude Code tool executions via hooks and store in database

**User Stories**:
- As a user, I want to see all tools Claude Code executed
- As a team lead, I want to audit file changes made by Claude Code
- As a developer, I want to know how long each operation took

**Acceptance Criteria**:
- [ ] Hook POSTs to /api/hooks/tool-complete on each tool execution
- [ ] Hook captures: tool name, input, output, duration
- [ ] All hooks stored in command_logs table
- [ ] Hook execution doesn't block Claude Code

**Technical Requirements**:
- Claude Code hooks configured in ~/.claude/settings.json
- API endpoint returns 200 OK within 100ms
- Truncate large outputs (>50KB) for database storage

#### 3. Web Dashboard

**Description**: React-based UI for monitoring sessions and viewing logs

**User Stories**:
- As a developer, I want to see all my active sessions in one place
- As a team lead, I want to view conversation history for a session
- As a user, I want to send manual prompts to a running session

**Acceptance Criteria**:
- [ ] Dashboard shows list of sessions sorted by updated_at
- [ ] Clicking session shows: messages, command logs, metadata
- [ ] Dashboard polls API every 3 seconds for updates
- [ ] Users can send messages to sessions from dashboard
- [ ] Command logs show: tool, status, timestamp, duration

**Technical Requirements**:
- React with TypeScript
- REST polling (not WebSocket)
- API client with error handling
- Responsive design for mobile/desktop

#### 4. n8n Workflow Integration

**Description**: Pre-built n8n workflows for session orchestration

**User Stories**:
- As a DevOps engineer, I want to trigger Claude Code from n8n
- As a user, I want to start sessions via Slack webhook
- As a developer, I want sessions to auto-close after completion

**Acceptance Criteria**:
- [ ] n8n workflow: Session Initializer (webhook trigger)
- [ ] n8n workflow: Message Handler (Slack integration)
- [ ] Workflows documented with JSON export
- [ ] Environment variables configured in workflow

**Technical Requirements**:
- n8n compatible workflow JSON
- Error handling in workflows
- Logging for debugging

#### 5. Conversation Persistence

**Description**: Store all user/assistant messages with timestamps

**User Stories**:
- As a developer, I want to review what I asked Claude Code
- As a team lead, I want to see the full conversation history
- As a user, I want to resume conversations with full context

**Acceptance Criteria**:
- [ ] All messages stored in session_messages table
- [ ] Messages include: direction (user/assistant), content, source, timestamp
- [ ] GET /api/sessions/:id/messages returns full conversation
- [ ] Messages associated with session via foreign key

**Technical Requirements**:
- PostgreSQL with indexed timestamps
- Source tracking (slack, dashboard, n8n, cli)
- Pagination support for large conversations

### Should-Have (Phase 2)

#### 6. Slack Integration

**Description**: Bidirectional messaging via Slack threads

**User Stories**:
- As a developer, I want to start Claude Code sessions from Slack
- As a user, I want to continue conversations by replying in Slack thread
- As a team member, I want to see when sessions complete

**Acceptance Criteria**:
- [ ] Slack slash command triggers session creation
- [ ] Slack thread replies continue sessions
- [ ] Claude Code responses posted to Slack thread
- [ ] Thread ID mapped to session ID in database

#### 7. Multi-Workspace Support

**Description**: Support for GitHub, local folders, git worktrees, E2B sandboxes

**User Stories**:
- As a developer, I want to clone GitHub repos for sessions
- As a user, I want to use git worktrees for parallel work
- As a DevOps engineer, I want to run Claude Code in E2B sandboxes

**Acceptance Criteria**:
- [ ] Support projectType: github, local, worktree, e2b
- [ ] Workspace creation via WorkspaceManager service
- [ ] Cleanup of temporary workspaces after session close

#### 8. Session Resume

**Description**: Resume paused sessions with full context

**User Stories**:
- As a developer, I want to pause a session and resume later
- As a user, I want to continue from where Claude Code left off

**Acceptance Criteria**:
- [ ] PATCH /api/sessions/:id can set status to paused
- [ ] Resume uses `claude --resume {claude_session_id}`
- [ ] Full conversation context restored

### Nice-to-Have (Phase 3)

#### 9. Advanced Filtering & Search

**Description**: Filter sessions by status, project, date range

**User Stories**:
- As a team lead, I want to filter sessions by team member
- As a user, I want to search for sessions by project name
- As an auditor, I want to export sessions from date range

**Acceptance Criteria**:
- [ ] Filter by: status, project_type, date range, assignee
- [ ] Search by project path or session metadata
- [ ] Export to JSON/CSV

#### 10. Authentication & Authorization

**Description**: API key authentication and role-based access

**User Stories**:
- As an admin, I want to require API keys for all requests
- As a team lead, I want to restrict who can create sessions
- As a user, I want to only see my own sessions

**Acceptance Criteria**:
- [ ] API key middleware for authentication
- [ ] Role-based access control (admin, user, viewer)
- [ ] User association with sessions

#### 11. Metrics & Monitoring

**Description**: Prometheus metrics for observability

**User Stories**:
- As a DevOps engineer, I want to monitor API performance
- As a team lead, I want to see tool execution trends
- As an admin, I want alerts on system issues

**Acceptance Criteria**:
- [ ] Prometheus metrics endpoint
- [ ] Metrics: tool_executions_total, tool_duration_ms, active_sessions
- [ ] Grafana dashboard template

---

## User Flows

### Flow 1: Create Session via API

```
1. User sends POST /api/sessions with project config
2. API validates request body
3. API creates workspace (clone repo, create folder, etc.)
4. API inserts session record in database
5. API returns session ID and workspace path
6. User executes `claude -p "{prompt}"` in workspace
7. Claude Code hooks POST to /api/hooks/tool-complete
8. User views session in dashboard
```

### Flow 2: Slack-Triggered Session

```
1. User posts message in Slack: "/claude Create a REST API"
2. Slack webhook triggers n8n workflow
3. n8n calls POST /api/sessions
4. n8n executes `claude --print -p "{prompt}"`
5. n8n captures output
6. n8n posts response to Slack thread
7. n8n stores thread_ts → session_id mapping
8. User replies in thread to continue session
9. n8n looks up session_id from thread_ts
10. n8n executes `claude --resume {session} -p "{reply}"`
11. Process repeats until user says "done"
```

### Flow 3: Dashboard Monitoring

```
1. User opens dashboard at http://localhost:3000
2. Dashboard calls GET /api/sessions
3. Dashboard displays list of sessions
4. User clicks on a session
5. Dashboard polls:
   - GET /api/sessions/:id/messages
   - GET /api/sessions/:id/logs
6. Dashboard updates every 3 seconds
7. User sees new tool executions in real-time
8. User sends manual intervention via input box
9. API stores message in session_messages
10. User manually executes `claude --resume` with new prompt
```

---

## Technical Requirements

### Performance

- API response time: < 200ms (p95)
- Hook delivery: < 500ms (p95)
- Dashboard polling: 3-second intervals
- Database queries: < 100ms (p95)
- Support 10+ concurrent sessions

### Scalability

- Horizontal scaling: Stateless API (multiple instances)
- Database: PostgreSQL with connection pooling
- File storage: Shared volume for workspaces
- Session isolation: Separate workspaces per session

### Security

- Input validation on all API endpoints
- SQL injection prevention (parameterized queries)
- Workspace isolation (prevent path traversal)
- Optional: API key authentication
- Optional: Rate limiting on hooks

### Reliability

- Database: ACID compliance, backups
- Hook retries: Not implemented (fire-and-forget)
- API error handling: 400/500 status codes with messages
- Session cleanup: Manual or scheduled (future)

### Compatibility

- Node.js 20+
- PostgreSQL 15+ (JSONB support)
- Claude Code CLI (latest version)
- Modern browsers (Chrome, Firefox, Safari)

---

## Data Model

### Sessions Table

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| claude_session_id | VARCHAR(255) | Claude Code's internal session ID |
| project_path | VARCHAR(500) | Workspace path |
| project_type | VARCHAR(50) | github, local, e2b, worktree |
| status | VARCHAR(50) | active, paused, completed, error |
| created_at | TIMESTAMP | Session creation time |
| updated_at | TIMESTAMP | Last activity time |
| metadata | JSONB | Flexible config storage |

### Session Messages Table

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL | Primary key |
| session_id | UUID | Foreign key to sessions |
| direction | VARCHAR(10) | user, assistant, system |
| content | TEXT | Message content |
| source | VARCHAR(50) | slack, dashboard, n8n, cli |
| timestamp | TIMESTAMP | Message time |
| metadata | JSONB | Additional data |

### Command Logs Table

| Field | Type | Description |
|-------|------|-------------|
| id | SERIAL | Primary key |
| session_id | UUID | Foreign key to sessions |
| tool | VARCHAR(100) | bash, edit_file, read_file, etc. |
| input | JSONB | Tool input parameters |
| result | TEXT | Tool output |
| status | VARCHAR(20) | completed, error |
| duration_ms | INTEGER | Execution time |
| timestamp | TIMESTAMP | Execution time |

### Slack Thread Mapping Table

| Field | Type | Description |
|-------|------|-------------|
| thread_ts | VARCHAR(50) | Primary key (Slack thread ID) |
| session_id | UUID | Foreign key to sessions |
| channel_id | VARCHAR(50) | Slack channel ID |
| created_at | TIMESTAMP | Mapping creation time |

---

## Dependencies

### Required

- **Node.js 20+**: Runtime environment
- **PostgreSQL 15+**: Database for session/log storage
- **Claude Code CLI**: AI coding agent
- **Express**: Web framework
- **React**: Dashboard UI
- **tsx**: TypeScript execution

### Optional

- **n8n**: Workflow automation
- **Slack API**: Messaging integration
- **E2B**: Sandbox environments
- **Docker**: Containerized deployment

---

## Risks and Mitigations

### Risk 1: Hook Delivery Failures

**Risk**: Claude Code hooks fail to POST to API (network issues, API downtime)

**Impact**: High - Missing tool execution logs, incomplete audit trail

**Mitigation**:
- Implement hook retry logic in shell script
- Add local logging as backup (write to file)
- Monitor hook delivery success rate

### Risk 2: Database Performance Degradation

**Risk**: Large result strings slow down database queries and inserts

**Impact**: Medium - API latency increases, poor user experience

**Mitigation**:
- Truncate tool results to 50KB before storage
- Add database indexes on session_id, timestamp
- Implement query pagination

### Risk 3: Session Context Loss

**Risk**: Claude Code session data lost if process crashes

**Impact**: High - Cannot resume sessions, lost work

**Mitigation**:
- Store claude_session_id in database immediately
- Claude Code persists sessions in ~/.claude/projects/
- Document session recovery process

### Risk 4: Workspace Collision

**Risk**: Multiple sessions using same workspace path

**Impact**: High - Code conflicts, data corruption

**Mitigation**:
- Generate unique workspace paths with UUIDs
- Validate workspace doesn't exist before creation
- Document workspace cleanup process

### Risk 5: Polling Performance

**Risk**: Dashboard polling every 3 seconds creates database load

**Impact**: Low - Acceptable for <100 concurrent dashboards

**Mitigation**:
- Use indexed queries for fast lookups
- Implement query result caching (future)
- Add dashboard connection limits (future)

---

## Success Criteria

### Launch Criteria (MVP)

- [ ] API can create, list, and update sessions
- [ ] Claude Code hooks POST to API successfully
- [ ] Dashboard displays sessions and logs
- [ ] n8n workflow template documented
- [ ] Database schema deployed
- [ ] Documentation complete (README, ARCHITECTURE)

### Success Metrics (3 months post-launch)

- [ ] 10+ sessions created per week
- [ ] 95%+ hook delivery success rate
- [ ] < 5 second dashboard update latency
- [ ] 5+ concurrent sessions supported
- [ ] 99%+ API uptime

### User Satisfaction

- [ ] Positive feedback from beta users
- [ ] No critical bugs reported
- [ ] Users successfully resume sessions
- [ ] Dashboard provides adequate visibility

---

## Timeline

### Phase 1: MVP (Weeks 1-4)

- **Week 1**: Database schema, API endpoints (sessions, hooks)
- **Week 2**: Hook configuration, workspace management
- **Week 3**: Dashboard UI (session list, detail view)
- **Week 4**: n8n workflows, documentation, testing

### Phase 2: Integration (Weeks 5-8)

- **Week 5**: Slack integration (slash command, threads)
- **Week 6**: Multi-workspace support (GitHub, worktrees, E2B)
- **Week 7**: Session resume functionality
- **Week 8**: Bug fixes, polish, beta testing

### Phase 3: Production (Weeks 9-12)

- **Week 9**: Authentication & authorization
- **Week 10**: Metrics & monitoring (Prometheus)
- **Week 11**: Docker deployment, CI/CD
- **Week 12**: Documentation, training, launch

---

## Open Questions

1. **Authentication**: Should MVP include API key auth or defer to Phase 3?
   - **Recommendation**: Defer to Phase 3 for faster MVP

2. **Hook Retries**: Should hooks retry on failure?
   - **Recommendation**: Fire-and-forget for MVP, add retries in Phase 2

3. **Workspace Cleanup**: Manual or automatic?
   - **Recommendation**: Manual for MVP, scheduled cleanup in Phase 3

4. **Multi-Tenancy**: Single-tenant or multi-tenant from start?
   - **Recommendation**: Single-tenant for MVP, multi-tenant in Phase 4

5. **Real-Time Updates**: Stick with polling or add WebSocket?
   - **Recommendation**: Polling for MVP, evaluate WebSocket in Phase 3 if needed

---

## Appendix

### Glossary

- **Session**: A Claude Code execution instance with persistent state
- **Hook**: Claude Code event callback that POSTs to API
- **Workspace**: Directory where Claude Code operates (local folder, git clone, etc.)
- **Tool**: Claude Code capability (bash, edit_file, read_file, etc.)
- **n8n**: Open-source workflow automation platform

### References

- Claude Code Documentation: https://claude.ai/code
- n8n Documentation: https://docs.n8n.io
- PostgreSQL Documentation: https://www.postgresql.org/docs/
- Express Documentation: https://expressjs.com/

### Revision History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2025-12-12 | Initial PRD | Frank Bria |
