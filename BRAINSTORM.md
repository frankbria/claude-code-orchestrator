# Architecture Analysis & Future Roadmap

**Date**: December 12, 2025
**Purpose**: Critical analysis of architecture, identification of gaps, and future feature planning

---

## Table of Contents

1. [Critical Architecture Issues](#critical-architecture-issues)
2. [Scalability Concerns](#scalability-concerns)
3. [Reliability & Resilience Gaps](#reliability--resilience-gaps)
4. [Security Vulnerabilities](#security-vulnerabilities)
5. [Logic Gaps & Edge Cases](#logic-gaps--edge-cases)
6. [Missing Features](#missing-features)
7. [Operational Challenges](#operational-challenges)
8. [Future Enhancements](#future-enhancements)
9. [Recommendations & Priorities](#recommendations--priorities)

---

## Critical Architecture Issues

### 1. Hook Reliability - Fire-and-Forget Problem

**Issue**: Hooks use fire-and-forget pattern with no retry mechanism or delivery guarantees.

**Scenario**:
```bash
# Hook executes
curl -X POST http://localhost:3001/api/hooks/tool-complete ... &
exit 0  # Always exits successfully

# What if:
# - API is down?
# - Network timeout?
# - Database is locked?
```

**Impact**:
- Missing tool execution logs
- Incomplete audit trail
- No way to recover lost events

**Proposed Solutions**:
1. **Local Event Log**: Write to local file before HTTP POST
   ```bash
   echo "$EVENT_JSON" >> ~/.claude/orchestrator-events.log
   curl -X POST ... || echo "FAILED: $EVENT_JSON" >> ~/.claude/orchestrator-failed.log
   ```

2. **Background Sync Process**: Daemon that reads failed log and retries
   ```typescript
   // Every 30 seconds, retry failed events
   setInterval(async () => {
     const failedEvents = await readFailedLog();
     for (const event of failedEvents) {
       try {
         await postToAPI(event);
         await removeFromFailedLog(event);
       } catch (err) {
         // Keep in failed log
       }
     }
   }, 30000);
   ```

3. **Idempotency Keys**: Add event IDs to prevent duplicate processing
   ```json
   {
     "eventId": "uuid-here",
     "session": "...",
     "tool": "...",
     "timestamp": "..."
   }
   ```

**Recommendation**: Implement all three solutions. Critical for production use.

---

### 2. Session State Synchronization

**Issue**: Claude Code session state is external to our system. What if:
- Claude Code crashes mid-execution?
- User kills process with Ctrl+C?
- System reboots?

**Current State**:
```
Our Database              Claude Code
┌──────────────┐         ┌──────────────┐
│ session:     │         │ session:     │
│   status:    │ ❌      │   actual     │
│   "active"   │ ≠       │   state:     │
│              │         │   "crashed"  │
└──────────────┘         └──────────────┘
```

**Gaps**:
- No heartbeat mechanism to detect crashed sessions
- No automatic status updates when Claude Code exits
- Sessions stuck in "active" state forever

**Proposed Solutions**:

1. **Session Heartbeat**:
   ```typescript
   // Hook sends heartbeat every 30 seconds
   setInterval(() => {
     fetch('/api/sessions/:id/heartbeat', { method: 'POST' });
   }, 30000);

   // API marks session as stale if no heartbeat for 2 minutes
   setInterval(async () => {
     await pool.query(`
       UPDATE sessions
       SET status = 'stale'
       WHERE status = 'active'
       AND updated_at < NOW() - INTERVAL '2 minutes'
     `);
   }, 60000);
   ```

2. **Process ID Tracking**:
   ```typescript
   // Store Claude Code PID in metadata
   {
     "metadata": {
       "claudePid": 12345,
       "startedAt": "2025-12-12T10:00:00Z"
     }
   }

   // Periodically check if process is alive
   const isAlive = execSync(`ps -p ${claudePid}`).length > 0;
   if (!isAlive) {
     await updateSessionStatus(sessionId, 'crashed');
   }
   ```

3. **Claude Code Exit Hook**:
   ```json
   // ~/.claude/settings.json
   {
     "hooks": {
       "onExit": [
         {
           "command": "curl -X PATCH http://localhost:3001/api/sessions/$CLAUDE_SESSION_ID -d '{\"status\":\"completed\"}'"
         }
       ]
     }
   }
   ```

**Recommendation**: Implement heartbeat + PID tracking. Check if Claude Code supports onExit hooks.

---

### 3. Workspace Management Lifecycle

**Issue**: No clear workspace cleanup strategy. Orphaned workspaces accumulate indefinitely.

**Scenarios**:
```bash
# Session creates workspace
/tmp/claude-workspaces/repo-1734012345/

# Session completes but:
# - Workspace never cleaned up
# - Disk fills up over time
# - No quota enforcement
```

**Current Gaps**:
- No cleanup on session completion
- No cleanup on session error/crash
- No disk quota enforcement
- No workspace archival strategy

**Proposed Solutions**:

1. **Automatic Cleanup on Session Close**:
   ```typescript
   router.patch('/sessions/:id', async (req, res) => {
     const { status } = req.body;

     if (status === 'completed' || status === 'error') {
       const session = await getSession(req.params.id);

       // Archive workspace before deletion (optional)
       if (process.env.ARCHIVE_WORKSPACES === 'true') {
         await archiveWorkspace(session.project_path);
       }

       // Clean up workspace
       await workspaceManager.cleanup(session.project_path);
     }

     // Update session
     await updateSession(req.params.id, { status });
   });
   ```

2. **Scheduled Cleanup Job**:
   ```typescript
   // Cron job: Clean up completed sessions older than 24 hours
   cron.schedule('0 * * * *', async () => {
     const oldSessions = await pool.query(`
       SELECT id, project_path
       FROM sessions
       WHERE status IN ('completed', 'error', 'stale')
       AND updated_at < NOW() - INTERVAL '24 hours'
     `);

     for (const session of oldSessions.rows) {
       await workspaceManager.cleanup(session.project_path);
       await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
     }
   });
   ```

3. **Disk Quota Management**:
   ```typescript
   async prepareWorkspace(config: SessionConfig): Promise<string> {
     // Check available disk space
     const diskUsage = await checkDiskUsage(this.baseDir);
     if (diskUsage.available < 5 * 1024 * 1024 * 1024) { // 5GB minimum
       throw new Error('Insufficient disk space');
     }

     // Check workspace count quota
     const workspaceCount = await countWorkspaces();
     if (workspaceCount >= MAX_WORKSPACES) {
       throw new Error('Maximum workspace quota exceeded');
     }

     // Continue with workspace creation...
   }
   ```

4. **Workspace Archival Strategy**:
   ```typescript
   async archiveWorkspace(workspacePath: string): Promise<string> {
     const archivePath = `${ARCHIVE_DIR}/${path.basename(workspacePath)}.tar.gz`;
     execSync(`tar -czf ${archivePath} -C ${workspacePath} .`);
     return archivePath;
   }
   ```

**Recommendation**: Implement automatic cleanup + scheduled job. Add disk quota enforcement.

---

### 4. Database Scalability - Large Results Problem

**Issue**: Tool results can be megabytes in size (e.g., `git log`, `npm install` output).

**Problems**:
```typescript
// Bash output: 5MB
const result = execSync('npm install').toString();

// Hook truncates to 50KB
TOOL_RESULT="${TOOL_RESULT:0:50000}"

// But what about:
// - Searching logs later (truncated results are useless)
// - Database bloat (even 50KB * 10,000 logs = 500MB)
// - Query performance (scanning TEXT columns is slow)
```

**Proposed Solutions**:

1. **External Blob Storage**:
   ```typescript
   async function storeToolResult(sessionId: string, tool: string, result: string) {
     let storedResult: string;
     let blobKey: string | null = null;

     if (result.length > 10000) {
       // Store in S3/MinIO/filesystem
       blobKey = await blobStorage.put(
         `sessions/${sessionId}/tools/${Date.now()}.txt`,
         result
       );
       storedResult = `[Large output stored at: ${blobKey}]`;
     } else {
       storedResult = result;
     }

     await pool.query(
       `INSERT INTO command_logs (session_id, tool, result, blob_key)
        VALUES ($1, $2, $3, $4)`,
       [sessionId, tool, storedResult, blobKey]
     );
   }
   ```

2. **Result Compression**:
   ```typescript
   import zlib from 'zlib';

   async function storeCompressedResult(result: string) {
     const compressed = zlib.gzipSync(result);

     await pool.query(
       `INSERT INTO command_logs (session_id, tool, result_compressed)
        VALUES ($1, $2, $3)`,
       [sessionId, tool, compressed]
     );
   }
   ```

3. **Result Streaming API**:
   ```typescript
   // Instead of storing full result, stream it
   router.get('/sessions/:id/logs/:logId/output', async (req, res) => {
     const log = await getCommandLog(req.params.logId);

     if (log.blob_key) {
       const stream = await blobStorage.getStream(log.blob_key);
       stream.pipe(res);
     } else {
       res.send(log.result);
     }
   });
   ```

**Recommendation**: Implement blob storage for results >100KB. Use database for small results only.

---

### 5. Concurrent Session Conflicts

**Issue**: Multiple sessions operating on the same repository can cause conflicts.

**Scenario**:
```
Session 1: Working on /repo (branch: main)
Session 2: Working on /repo (branch: main)

Session 1: git commit -m "Add feature A"
Session 2: git commit -m "Add feature B"  ❌ Conflict!
```

**Current State**: No coordination between sessions.

**Proposed Solutions**:

1. **Workspace Isolation Enforcement**:
   ```typescript
   async prepareWorkspace(config: SessionConfig): Promise<string> {
     if (config.projectType === 'github') {
       // ALWAYS clone to unique directory
       const uniquePath = `${this.baseDir}/${repo}-${uuidv4()}`;
       return this.cloneGitHubRepo(repo, uniquePath);
     }

     if (config.projectType === 'local') {
       // WARN: Local workspaces can conflict
       const existingSessions = await findSessionsByPath(config.projectPath);
       if (existingSessions.length > 0) {
         throw new Error(`Workspace already in use by session ${existingSessions[0].id}`);
       }
     }
   }
   ```

2. **Git Worktree by Default**:
   ```typescript
   async prepareWorkspace(config: SessionConfig): Promise<string> {
     if (config.projectType === 'github') {
       // Clone main repo once
       const mainRepo = await ensureMainRepoCloned(repo);

       // Create worktree for this session
       const branchName = `session-${uuidv4()}`;
       const worktreePath = `${this.baseDir}/${branchName}`;

       execSync(`git worktree add ${worktreePath} -b ${branchName}`, {
         cwd: mainRepo
       });

       return worktreePath;
     }
   }
   ```

3. **Workspace Locking**:
   ```typescript
   // Add workspace_locks table
   CREATE TABLE workspace_locks (
     workspace_path VARCHAR(500) PRIMARY KEY,
     session_id UUID REFERENCES sessions(id),
     locked_at TIMESTAMP DEFAULT NOW()
   );

   async acquireWorkspaceLock(sessionId: string, path: string) {
     try {
       await pool.query(
         'INSERT INTO workspace_locks (workspace_path, session_id) VALUES ($1, $2)',
         [path, sessionId]
       );
     } catch (err) {
       if (err.code === '23505') { // Unique violation
         throw new Error('Workspace is locked by another session');
       }
       throw err;
     }
   }
   ```

**Recommendation**: Use git worktrees by default for GitHub repos. Implement workspace locking for local paths.

---

## Scalability Concerns

### 1. Database Connection Pool Exhaustion

**Issue**: Each API request uses a database connection. At scale, pool can exhaust.

**Scenario**:
```
Max connections: 20
Active requests: 25
Result: 5 requests wait → timeout → 500 error
```

**Proposed Solutions**:

1. **Connection Pool Monitoring**:
   ```typescript
   pool.on('acquire', () => {
     console.log('Pool acquired. Available:', pool.totalCount - pool.idleCount);
   });

   pool.on('remove', () => {
     console.log('Pool removed. Available:', pool.totalCount - pool.idleCount);
   });

   // Expose metrics
   router.get('/metrics', (req, res) => {
     res.json({
       pool: {
         total: pool.totalCount,
         idle: pool.idleCount,
         waiting: pool.waitingCount
       }
     });
   });
   ```

2. **Query Optimization**:
   ```typescript
   // BAD: Multiple queries
   const sessions = await pool.query('SELECT * FROM sessions');
   for (const session of sessions.rows) {
     const messages = await pool.query('SELECT * FROM session_messages WHERE session_id = $1', [session.id]);
     // ...
   }

   // GOOD: Join query
   const results = await pool.query(`
     SELECT s.*, json_agg(sm.*) as messages
     FROM sessions s
     LEFT JOIN session_messages sm ON sm.session_id = s.id
     GROUP BY s.id
   `);
   ```

3. **Read Replicas**:
   ```typescript
   const primaryPool = new Pool({ connectionString: PRIMARY_DB_URL });
   const replicaPool = new Pool({ connectionString: REPLICA_DB_URL });

   // Writes go to primary
   export async function writeQuery(query: string, params: any[]) {
     return primaryPool.query(query, params);
   }

   // Reads from replica
   export async function readQuery(query: string, params: any[]) {
     return replicaPool.query(query, params);
   }
   ```

**Recommendation**: Add connection pool monitoring. Optimize queries. Plan for read replicas at 100+ concurrent sessions.

---

### 2. Polling Overhead at Scale

**Issue**: Dashboard polls every 3 seconds. With 100 dashboards, that's 33 requests/second.

**Math**:
```
Dashboards: 100
Polling interval: 3 seconds
Endpoints polled per dashboard: 2 (logs + messages)

Requests per second: (100 * 2) / 3 = 67 req/s
Database queries per second: 67 * 2 = 134 queries/s
```

**Proposed Solutions**:

1. **Increase Polling Interval Dynamically**:
   ```typescript
   const usePolling = (fetchFn, options) => {
     const [interval, setInterval] = useState(3000);

     useEffect(() => {
       // If no changes detected for 30 seconds, slow down polling
       if (unchangedDuration > 30000) {
         setInterval(10000); // Poll every 10 seconds instead
       } else {
         setInterval(3000);
       }
     }, [unchangedDuration]);
   };
   ```

2. **Server-Sent Events (SSE)**:
   ```typescript
   // API
   router.get('/sessions/:id/stream', (req, res) => {
     res.setHeader('Content-Type', 'text/event-stream');
     res.setHeader('Cache-Control', 'no-cache');

     const interval = setInterval(async () => {
       const logs = await getRecentLogs(req.params.id);
       res.write(`data: ${JSON.stringify(logs)}\n\n`);
     }, 3000);

     req.on('close', () => clearInterval(interval));
   });

   // Dashboard
   const eventSource = new EventSource('/api/sessions/123/stream');
   eventSource.onmessage = (event) => {
     setLogs(JSON.parse(event.data));
   };
   ```

3. **WebSocket (if SSE not sufficient)**:
   ```typescript
   // After all, maybe WebSocket is needed for 100+ concurrent dashboards
   const wss = new WebSocketServer({ port: 3002 });

   wss.on('connection', (ws, req) => {
     const sessionId = req.url.split('/').pop();

     const interval = setInterval(async () => {
       const logs = await getRecentLogs(sessionId);
       ws.send(JSON.stringify({ type: 'logs', data: logs }));
     }, 3000);

     ws.on('close', () => clearInterval(interval));
   });
   ```

**Recommendation**: Start with increased polling intervals. Add SSE at 50+ dashboards. Consider WebSocket at 100+.

---

### 3. Hook Processing Bottleneck

**Issue**: All hooks POST to single API instance. At high concurrency, API becomes bottleneck.

**Scenario**:
```
Sessions: 20 parallel
Tools per session per minute: 10
Hooks per minute: 200

With 1 API instance:
- Each hook takes ~50ms to process
- Capacity: 1200 hooks/minute
- Safe for 60 sessions

At 100 sessions:
- Hooks per minute: 1000
- Nearing capacity limit
```

**Proposed Solutions**:

1. **Horizontal API Scaling**:
   ```yaml
   # docker-compose.yml
   services:
     api:
       image: orchestrator-api
       deploy:
         replicas: 3  # Run 3 instances

     nginx:
       image: nginx
       volumes:
         - ./nginx.conf:/etc/nginx/nginx.conf
   ```

   ```nginx
   # nginx.conf
   upstream api_backend {
     server api:3001;
     server api:3002;
     server api:3003;
   }

   server {
     location /api/hooks {
       proxy_pass http://api_backend;
     }
   }
   ```

2. **Async Hook Processing**:
   ```typescript
   // Current: Synchronous processing
   router.post('/hooks/tool-complete', async (req, res) => {
     await processHook(req.body);  // Blocks response
     res.sendStatus(200);
   });

   // Better: Async processing
   const hookQueue = new Queue();

   router.post('/hooks/tool-complete', (req, res) => {
     hookQueue.add(req.body);  // Non-blocking
     res.sendStatus(200);
   });

   hookQueue.process(async (job) => {
     await processHook(job.data);
   });
   ```

3. **Message Queue (Redis/RabbitMQ)**:
   ```typescript
   import { Queue } from 'bullmq';

   const hookQueue = new Queue('hooks', {
     connection: { host: 'redis', port: 6379 }
   });

   router.post('/hooks/tool-complete', async (req, res) => {
     await hookQueue.add('process', req.body);
     res.sendStatus(200);
   });

   // Separate worker process
   const worker = new Worker('hooks', async (job) => {
     await processHook(job.data);
   });
   ```

**Recommendation**: Implement async processing with in-memory queue. Add Redis queue at 50+ concurrent sessions.

---

## Reliability & Resilience Gaps

### 1. No Error Recovery for Failed Operations

**Issue**: If workspace creation, git clone, or database insert fails, session is left in inconsistent state.

**Scenario**:
```
POST /api/sessions
→ Workspace created: /tmp/repo-123
→ Database insert fails ❌
Result: Orphaned workspace, no session record
```

**Proposed Solutions**:

1. **Transaction-like Cleanup**:
   ```typescript
   router.post('/sessions', async (req, res) => {
     let workspacePath: string | null = null;

     try {
       // Step 1: Create workspace
       workspacePath = await workspaceManager.prepareWorkspace(req.body);

       // Step 2: Insert to database
       const sessionId = await createSession({
         projectPath: workspacePath,
         ...req.body
       });

       res.status(201).json({ sessionId, workspacePath });

     } catch (error) {
       // Rollback: Clean up workspace if created
       if (workspacePath) {
         await workspaceManager.cleanup(workspacePath);
       }

       res.status(500).json({ error: 'Session creation failed' });
     }
   });
   ```

2. **Idempotency for Retries**:
   ```typescript
   router.post('/sessions', async (req, res) => {
     const { idempotencyKey } = req.body;

     // Check if already processed
     const existing = await pool.query(
       'SELECT * FROM sessions WHERE metadata->\'idempotencyKey\' = $1',
       [idempotencyKey]
     );

     if (existing.rows.length > 0) {
       return res.status(200).json(existing.rows[0]);
     }

     // Create new session...
   });
   ```

3. **Dead Letter Queue for Failed Hooks**:
   ```typescript
   hookQueue.on('failed', async (job, error) => {
     await deadLetterQueue.add({
       originalJob: job.data,
       error: error.message,
       failedAt: new Date(),
       retryCount: job.attemptsMade
     });
   });

   // Manual inspection/retry of failed hooks
   router.get('/admin/failed-hooks', async (req, res) => {
     const failed = await deadLetterQueue.getJobs(['failed']);
     res.json(failed);
   });
   ```

**Recommendation**: Implement transaction-like cleanup for all multi-step operations.

---

### 2. No Circuit Breaker for External Dependencies

**Issue**: If GitHub API is down, all GitHub clone operations fail and block sessions.

**Proposed Solutions**:

1. **Circuit Breaker Pattern**:
   ```typescript
   import CircuitBreaker from 'opossum';

   const cloneRepoBreaker = new CircuitBreaker(
     async (repo: string) => {
       return execSync(`gh repo clone ${repo}`);
     },
     {
       timeout: 60000,        // 60 second timeout
       errorThresholdPercentage: 50,  // Open circuit at 50% errors
       resetTimeout: 30000    // Try again after 30 seconds
     }
   );

   cloneRepoBreaker.fallback(() => {
     throw new Error('GitHub API is currently unavailable');
   });

   cloneRepoBreaker.on('open', () => {
     console.error('Circuit breaker opened - GitHub API issues detected');
   });
   ```

2. **Retry with Exponential Backoff**:
   ```typescript
   async function cloneWithRetry(repo: string, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await cloneRepo(repo);
       } catch (error) {
         if (i === maxRetries - 1) throw error;

         const backoff = Math.pow(2, i) * 1000; // 1s, 2s, 4s
         await sleep(backoff);
       }
     }
   }
   ```

**Recommendation**: Add circuit breakers for all external API calls (GitHub, Slack, E2B).

---

### 3. No Health Checks or Monitoring

**Issue**: No way to know if system is healthy until it fails.

**Proposed Solutions**:

1. **Comprehensive Health Check**:
   ```typescript
   router.get('/health', async (req, res) => {
     const health = {
       status: 'healthy',
       timestamp: new Date().toISOString(),
       checks: {
         database: await checkDatabase(),
         diskSpace: await checkDiskSpace(),
         workspaceCount: await countWorkspaces(),
         activeConnections: pool.totalCount - pool.idleCount
       }
     };

     const isHealthy = Object.values(health.checks).every(check => check.status === 'ok');
     res.status(isHealthy ? 200 : 503).json(health);
   });

   async function checkDatabase() {
     try {
       await pool.query('SELECT 1');
       return { status: 'ok' };
     } catch (error) {
       return { status: 'error', message: error.message };
     }
   }

   async function checkDiskSpace() {
     const stats = await fs.statfs(WORKSPACE_BASE);
     const availableGB = stats.bavail * stats.bsize / 1024 / 1024 / 1024;

     if (availableGB < 5) {
       return { status: 'warning', available: availableGB, unit: 'GB' };
     }
     return { status: 'ok', available: availableGB, unit: 'GB' };
   }
   ```

2. **Prometheus Metrics**:
   ```typescript
   import { register, Counter, Histogram, Gauge } from 'prom-client';

   const hookCounter = new Counter({
     name: 'hooks_received_total',
     help: 'Total hooks received',
     labelNames: ['tool', 'status']
   });

   const sessionGauge = new Gauge({
     name: 'sessions_active',
     help: 'Number of active sessions'
   });

   const apiLatency = new Histogram({
     name: 'api_request_duration_ms',
     help: 'API request latency',
     labelNames: ['route', 'method']
   });

   router.get('/metrics', async (req, res) => {
     res.set('Content-Type', register.contentType);
     res.end(await register.metrics());
   });
   ```

**Recommendation**: Implement health checks + Prometheus metrics. Set up Grafana dashboards.

---

## Security Vulnerabilities

### 1. No Authentication on API Endpoints

**Issue**: Anyone with network access can create sessions, view logs, and control system.

**Attack Scenarios**:
```bash
# Attacker can:
curl -X POST http://api:3001/api/sessions \
  -d '{"projectType":"github","githubRepo":"victim/private-repo",...}'

curl http://api:3001/api/sessions  # View all sessions
curl http://api:3001/api/sessions/123/messages  # Read conversations
```

**Proposed Solutions**:

1. **API Key Authentication**:
   ```typescript
   function apiKeyAuth(req, res, next) {
     const apiKey = req.headers['x-api-key'];

     if (!apiKey) {
       return res.status(401).json({ error: 'API key required' });
     }

     const validKey = await pool.query(
       'SELECT * FROM api_keys WHERE key = $1 AND active = true',
       [apiKey]
     );

     if (validKey.rows.length === 0) {
       return res.status(401).json({ error: 'Invalid API key' });
     }

     req.apiKey = validKey.rows[0];
     next();
   }

   app.use('/api', apiKeyAuth);
   ```

2. **JWT Authentication**:
   ```typescript
   import jwt from 'jsonwebtoken';

   function jwtAuth(req, res, next) {
     const token = req.headers.authorization?.split(' ')[1];

     try {
       const decoded = jwt.verify(token, process.env.JWT_SECRET);
       req.user = decoded;
       next();
     } catch (error) {
       res.status(401).json({ error: 'Invalid token' });
     }
   }
   ```

3. **OAuth 2.0 Integration**:
   ```typescript
   // GitHub OAuth for user authentication
   import passport from 'passport';
   import { Strategy as GitHubStrategy } from 'passport-github2';

   passport.use(new GitHubStrategy({
       clientID: process.env.GITHUB_CLIENT_ID,
       clientSecret: process.env.GITHUB_CLIENT_SECRET,
       callbackURL: "http://localhost:3001/auth/github/callback"
     },
     async (accessToken, refreshToken, profile, done) => {
       const user = await findOrCreateUser(profile);
       return done(null, user);
     }
   ));
   ```

**Recommendation**: Implement API key auth for MVP. Plan OAuth 2.0 for multi-user version.

---

### 2. Path Traversal in Workspace Creation

**Issue**: Malicious input could create workspaces outside intended directory.

**Attack**:
```bash
curl -X POST /api/sessions -d '{
  "projectType": "local",
  "projectPath": "../../etc/passwd"
}'
```

**Proposed Solutions**:

1. **Path Validation**:
   ```typescript
   function validateWorkspacePath(requestedPath: string): string {
     const basePath = path.resolve(WORKSPACE_BASE);
     const resolvedPath = path.resolve(requestedPath);

     // Ensure resolved path is within base directory
     if (!resolvedPath.startsWith(basePath)) {
       throw new Error('Invalid workspace path - outside allowed directory');
     }

     return resolvedPath;
   }
   ```

2. **Allowlist Patterns**:
   ```typescript
   const ALLOWED_PATH_PATTERNS = [
     /^\/tmp\/claude-workspaces\/.+$/,
     /^\/workspace\/.+$/,
   ];

   function isAllowedPath(path: string): boolean {
     return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(path));
   }
   ```

**Recommendation**: Add strict path validation before any workspace operations.

---

### 3. Command Injection in Git Operations

**Issue**: Unsanitized repo names passed to shell commands.

**Attack**:
```bash
curl -X POST /api/sessions -d '{
  "projectType": "github",
  "githubRepo": "user/repo; rm -rf /"
}'

# Executes: gh repo clone user/repo; rm -rf /
```

**Proposed Solutions**:

1. **Input Validation with Regex**:
   ```typescript
   function validateGitHubRepo(repo: string): void {
     // Only allow alphanumeric, hyphens, underscores, and single slash
     if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
       throw new Error('Invalid repository format');
     }

     // Block shell metacharacters
     const dangerous = /[;&|`$(){}[\]<>]/;
     if (dangerous.test(repo)) {
       throw new Error('Repository name contains invalid characters');
     }
   }
   ```

2. **Use Parameterized Commands**:
   ```typescript
   // Instead of shell string concatenation, use spawn with args
   import { spawn } from 'child_process';

   function cloneRepo(repo: string): Promise<void> {
     return new Promise((resolve, reject) => {
       const proc = spawn('gh', ['repo', 'clone', repo, targetPath], {
         stdio: 'pipe'
       });

       proc.on('close', (code) => {
         code === 0 ? resolve() : reject(new Error('Clone failed'));
       });
     });
   }
   ```

**Recommendation**: Always validate input + use spawn instead of execSync with string commands.

---

### 4. Sensitive Data in Logs

**Issue**: Tool results may contain secrets (API keys, passwords, tokens).

**Scenario**:
```bash
# Claude Code executes:
cat .env

# Result logged to database:
{
  "tool": "bash",
  "result": "DATABASE_PASSWORD=super-secret-123\nAPI_KEY=sk-xxx"
}
```

**Proposed Solutions**:

1. **Secret Scrubbing**:
   ```typescript
   const SECRET_PATTERNS = [
     /(?:password|passwd|pwd)[\s:=]+[\S]+/gi,
     /(?:api[_-]?key|apikey)[\s:=]+[\S]+/gi,
     /(?:secret|token)[\s:=]+[\S]+/gi,
     /sk-[a-zA-Z0-9]{20,}/g,  // Stripe/OpenAI keys
     /xox[baprs]-[a-zA-Z0-9-]+/g,  // Slack tokens
   ];

   function scrubSecrets(text: string): string {
     let scrubbed = text;
     for (const pattern of SECRET_PATTERNS) {
       scrubbed = scrubbed.replace(pattern, (match) => {
         const key = match.split(/[:=]/)[0];
         return `${key}=***REDACTED***`;
       });
     }
     return scrubbed;
   }

   // Apply before storing
   const scrubbedResult = scrubSecrets(toolResult);
   ```

2. **Encryption at Rest**:
   ```typescript
   import crypto from 'crypto';

   const algorithm = 'aes-256-gcm';
   const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

   function encrypt(text: string): string {
     const iv = crypto.randomBytes(16);
     const cipher = crypto.createCipheriv(algorithm, key, iv);

     let encrypted = cipher.update(text, 'utf8', 'hex');
     encrypted += cipher.final('hex');

     const authTag = cipher.getAuthTag();
     return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
   }

   // Store encrypted results for sensitive operations
   ```

**Recommendation**: Implement secret scrubbing for all tool results. Add encryption for high-security environments.

---

## Logic Gaps & Edge Cases

### 1. Race Condition in Session Updates

**Issue**: Multiple hooks updating same session simultaneously can cause lost updates.

**Scenario**:
```
Time    Hook A                    Hook B
----    ------                    ------
T0      Read session (updated_at: 10:00)
T1                                Read session (updated_at: 10:00)
T2      Update (updated_at: 10:05)
T3                                Update (updated_at: 10:06)
Result: Hook A's update is overwritten
```

**Proposed Solutions**:

1. **Optimistic Locking**:
   ```typescript
   // Add version column to sessions table
   ALTER TABLE sessions ADD COLUMN version INTEGER DEFAULT 1;

   async function updateSession(id: string, updates: any, expectedVersion: number) {
     const result = await pool.query(
       `UPDATE sessions
        SET status = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2 AND version = $3
        RETURNING version`,
       [updates.status, id, expectedVersion]
     );

     if (result.rowCount === 0) {
       throw new Error('Session was modified by another process');
     }
   }
   ```

2. **Database-Level Locking**:
   ```typescript
   async function updateSessionSafe(id: string, updates: any) {
     const client = await pool.connect();

     try {
       await client.query('BEGIN');

       // Lock the row
       await client.query(
         'SELECT * FROM sessions WHERE id = $1 FOR UPDATE',
         [id]
       );

       // Perform update
       await client.query(
         'UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2',
         [updates.status, id]
       );

       await client.query('COMMIT');
     } catch (error) {
       await client.query('ROLLBACK');
       throw error;
     } finally {
       client.release();
     }
   }
   ```

**Recommendation**: Use optimistic locking with version column for concurrent updates.

---

### 2. Orphaned Claude Code Sessions

**Issue**: If API database is cleared but Claude Code sessions persist in `~/.claude/projects/`, sessions become orphaned.

**Proposed Solutions**:

1. **Session Discovery**:
   ```typescript
   async function discoverOrphanedSessions() {
     const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
     const claudeSessions = await fs.readdir(claudeProjectsDir);

     const dbSessions = await pool.query(
       'SELECT claude_session_id FROM sessions'
     );
     const dbSessionIds = new Set(dbSessions.rows.map(r => r.claude_session_id));

     const orphaned = claudeSessions.filter(id => !dbSessionIds.has(id));
     return orphaned;
   }

   router.get('/admin/orphaned-sessions', async (req, res) => {
     const orphaned = await discoverOrphanedSessions();
     res.json({ orphaned, count: orphaned.length });
   });
   ```

2. **Session Reconciliation**:
   ```typescript
   router.post('/admin/reconcile-sessions', async (req, res) => {
     const orphaned = await discoverOrphanedSessions();

     for (const sessionId of orphaned) {
       // Option 1: Import to database
       await pool.query(
         'INSERT INTO sessions (claude_session_id, status) VALUES ($1, $2)',
         [sessionId, 'orphaned']
       );

       // Option 2: Clean up
       // await cleanupClaudeSession(sessionId);
     }

     res.json({ reconciled: orphaned.length });
   });
   ```

**Recommendation**: Add admin endpoint to discover and reconcile orphaned sessions.

---

### 3. Message Ordering Issues

**Issue**: Messages from different sources (Slack, dashboard, hooks) may arrive out of order.

**Scenario**:
```
T0: User sends "Create API" via Slack
T1: Claude executes tools (hooks fire)
T2: User sends "Add auth" via dashboard (while Claude still working)
T3: Claude's response to "Create API" arrives

Result: Messages in database are out of order
```

**Proposed Solutions**:

1. **Sequence Numbers**:
   ```sql
   ALTER TABLE session_messages ADD COLUMN sequence INTEGER;

   CREATE SEQUENCE message_seq_<session_id>;

   INSERT INTO session_messages (session_id, content, sequence)
   VALUES ($1, $2, nextval('message_seq_' || $1));
   ```

2. **Lamport Timestamps**:
   ```typescript
   // Each session maintains a logical clock
   class SessionClock {
     private counter = 0;

     tick(): number {
       return ++this.counter;
     }

     update(receivedTimestamp: number): number {
       this.counter = Math.max(this.counter, receivedTimestamp) + 1;
       return this.counter;
     }
   }

   // Include in each message
   {
     "content": "...",
     "lamportTimestamp": 42,
     "wallClockTime": "2025-12-12T10:00:00Z"
   }
   ```

**Recommendation**: Use sequence numbers per session for guaranteed message ordering.

---

### 4. No Handling of Long-Running Sessions

**Issue**: Sessions that run for hours/days have unbounded log growth.

**Scenario**:
```
Session starts: 9:00 AM
Still running: 5:00 PM (8 hours later)
Command logs: 10,000 entries
Messages: 500 entries
Database row size: 50MB+
```

**Proposed Solutions**:

1. **Log Rotation**:
   ```typescript
   async function rotateSessionLogs(sessionId: string) {
     // Archive old logs
     const oldLogs = await pool.query(`
       SELECT * FROM command_logs
       WHERE session_id = $1
       AND timestamp < NOW() - INTERVAL '1 hour'
     `, [sessionId]);

     // Move to archive table
     await pool.query(`
       INSERT INTO command_logs_archive
       SELECT * FROM command_logs
       WHERE session_id = $1
       AND timestamp < NOW() - INTERVAL '1 hour'
     `, [sessionId]);

     // Delete from active table
     await pool.query(`
       DELETE FROM command_logs
       WHERE session_id = $1
       AND timestamp < NOW() - INTERVAL '1 hour'
     `, [sessionId]);
   }

   // Run periodically
   cron.schedule('*/30 * * * *', async () => {
     const longRunningSessions = await getLongRunningSessions();
     for (const session of longRunningSessions) {
       await rotateSessionLogs(session.id);
     }
   });
   ```

2. **Session Duration Limits**:
   ```typescript
   async function checkSessionDuration() {
     await pool.query(`
       UPDATE sessions
       SET status = 'timeout',
           metadata = metadata || '{"reason": "exceeded max duration"}'
       WHERE status = 'active'
       AND created_at < NOW() - INTERVAL '24 hours'
     `);
   }
   ```

**Recommendation**: Implement log rotation + session duration limits (configurable per session).

---

## Missing Features

### 1. Session Templates & Presets

**Use Case**: Users want to quickly start sessions with predefined configurations.

**Proposed Feature**:
```typescript
// Session templates
const templates = {
  'code-review': {
    initialPrompt: 'Review this codebase for security vulnerabilities and code quality issues',
    projectType: 'github',
    metadata: {
      tools: ['security-scanner', 'linter'],
      autoClose: true,
      maxDuration: '2 hours'
    }
  },
  'refactor-typescript': {
    initialPrompt: 'Refactor JavaScript code to TypeScript',
    projectType: 'local',
    metadata: {
      tools: ['typescript', 'prettier'],
      autoCommit: false
    }
  }
};

// API endpoint
router.post('/sessions/from-template', async (req, res) => {
  const { templateName, githubRepo } = req.body;
  const template = templates[templateName];

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const session = await createSession({
    ...template,
    githubRepo
  });

  res.json(session);
});

// Usage
curl -X POST /api/sessions/from-template \
  -d '{"templateName":"code-review","githubRepo":"user/repo"}'
```

---

### 2. Session Collaboration & Sharing

**Use Case**: Team members want to share a running session or take over from another user.

**Proposed Feature**:
```typescript
// Session sharing
router.post('/sessions/:id/share', async (req, res) => {
  const { userId, permissions } = req.body;

  await pool.query(
    `INSERT INTO session_shares (session_id, user_id, permissions)
     VALUES ($1, $2, $3)`,
    [req.params.id, userId, JSON.stringify(permissions)]
  );

  const shareLink = generateShareLink(req.params.id, userId);
  res.json({ shareLink });
});

// Permissions
{
  "read": true,      // Can view logs and messages
  "write": true,     // Can send messages
  "control": false   // Can pause/resume/close session
}

// Dashboard: Show shared sessions
router.get('/sessions/shared-with-me', async (req, res) => {
  const shared = await pool.query(`
    SELECT s.*, ss.permissions
    FROM sessions s
    JOIN session_shares ss ON ss.session_id = s.id
    WHERE ss.user_id = $1
  `, [req.user.id]);

  res.json(shared.rows);
});
```

---

### 3. Session Snapshots & Checkpoints

**Use Case**: Save session state at specific points for rollback or branching.

**Proposed Feature**:
```typescript
// Create snapshot
router.post('/sessions/:id/snapshots', async (req, res) => {
  const { name, description } = req.body;

  const session = await getSession(req.params.id);

  // Archive workspace
  const archivePath = await archiveWorkspace(session.project_path);

  // Save snapshot metadata
  const snapshot = await pool.query(
    `INSERT INTO session_snapshots (session_id, name, description, archive_path)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.params.id, name, description, archivePath]
  );

  res.json(snapshot.rows[0]);
});

// Restore from snapshot
router.post('/sessions/:id/restore', async (req, res) => {
  const { snapshotId } = req.body;

  const snapshot = await getSnapshot(snapshotId);

  // Extract archive to workspace
  await extractArchive(snapshot.archive_path, session.project_path);

  res.json({ status: 'restored' });
});
```

---

### 4. Cost Tracking & Budgets

**Use Case**: Track API usage costs and enforce budgets per session/user.

**Proposed Feature**:
```typescript
// Track costs
ALTER TABLE sessions ADD COLUMN estimated_cost DECIMAL(10,2) DEFAULT 0;

// Calculate cost based on tool usage
async function calculateSessionCost(sessionId: string): Promise<number> {
  const logs = await pool.query(
    'SELECT tool, COUNT(*) as count FROM command_logs WHERE session_id = $1 GROUP BY tool',
    [sessionId]
  );

  const costs = {
    'bash': 0.001,      // $0.001 per execution
    'edit_file': 0.002,
    'read_file': 0.001,
    'web_search': 0.01
  };

  let totalCost = 0;
  for (const row of logs.rows) {
    totalCost += (costs[row.tool] || 0.001) * row.count;
  }

  return totalCost;
}

// Update cost periodically
cron.schedule('*/5 * * * *', async () => {
  const activeSessions = await getActiveSessions();
  for (const session of activeSessions) {
    const cost = await calculateSessionCost(session.id);
    await pool.query(
      'UPDATE sessions SET estimated_cost = $1 WHERE id = $2',
      [cost, session.id]
    );
  }
});

// Enforce budget limits
async function checkBudget(sessionId: string) {
  const session = await getSession(sessionId);
  const budget = session.metadata.budget || Infinity;

  if (session.estimated_cost > budget) {
    await updateSession(sessionId, { status: 'budget_exceeded' });
    throw new Error(`Session exceeded budget of $${budget}`);
  }
}
```

---

### 5. Session Diff & Comparison

**Use Case**: Compare changes between two sessions or before/after snapshots.

**Proposed Feature**:
```typescript
router.get('/sessions/compare', async (req, res) => {
  const { sessionA, sessionB } = req.query;

  const [logsA, logsB] = await Promise.all([
    getSessionLogs(sessionA),
    getSessionLogs(sessionB)
  ]);

  const diff = {
    toolsOnlyInA: findUnique(logsA, logsB),
    toolsOnlyInB: findUnique(logsB, logsA),
    commonTools: findCommon(logsA, logsB),
    filesModified: await compareWorkspaces(sessionA, sessionB)
  };

  res.json(diff);
});

async function compareWorkspaces(sessionIdA: string, sessionIdB: string) {
  const sessionA = await getSession(sessionIdA);
  const sessionB = await getSession(sessionIdB);

  const diffOutput = execSync(
    `diff -r ${sessionA.project_path} ${sessionB.project_path}`
  ).toString();

  return parseDiffOutput(diffOutput);
}
```

---

## Operational Challenges

### 1. No Observability into Claude Code Behavior

**Challenge**: When sessions fail or produce unexpected results, hard to debug.

**Proposed Solutions**:

1. **Structured Logging**:
   ```typescript
   import winston from 'winston';

   const logger = winston.createLogger({
     format: winston.format.json(),
     transports: [
       new winston.transports.File({ filename: 'error.log', level: 'error' }),
       new winston.transports.File({ filename: 'combined.log' })
     ]
   });

   // Log every API call
   app.use((req, res, next) => {
     logger.info('API request', {
       method: req.method,
       path: req.path,
       sessionId: req.params.id,
       userId: req.user?.id
     });
     next();
   });

   // Log hook events
   router.post('/hooks/tool-complete', async (req, res) => {
     logger.info('Hook received', {
       session: req.body.session,
       tool: req.body.tool,
       duration: req.body.duration_ms
     });
     // ...
   });
   ```

2. **Distributed Tracing**:
   ```typescript
   import opentelemetry from '@opentelemetry/api';

   const tracer = opentelemetry.trace.getTracer('claude-orchestrator');

   router.post('/sessions', async (req, res) => {
     const span = tracer.startSpan('create_session');

     try {
       span.setAttribute('project_type', req.body.projectType);

       const workspace = await tracer.startSpan('create_workspace', () => {
         return workspaceManager.prepareWorkspace(req.body);
       });

       const sessionId = await tracer.startSpan('insert_db', () => {
         return createSession({ projectPath: workspace, ...req.body });
       });

       span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
       res.json({ sessionId });
     } catch (error) {
       span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
       span.recordException(error);
       throw error;
     } finally {
       span.end();
     }
   });
   ```

---

### 2. Difficulty in Debugging Failed Sessions

**Challenge**: When a session fails, need to know exactly what happened and why.

**Proposed Solutions**:

1. **Session Replay**:
   ```typescript
   // Store every action for replay
   CREATE TABLE session_events (
     id SERIAL PRIMARY KEY,
     session_id UUID REFERENCES sessions(id),
     event_type VARCHAR(50),  -- 'tool_execution', 'message_sent', 'status_change'
     event_data JSONB,
     timestamp TIMESTAMP DEFAULT NOW()
   );

   // Replay session
   router.post('/sessions/:id/replay', async (req, res) => {
     const events = await pool.query(
       'SELECT * FROM session_events WHERE session_id = $1 ORDER BY timestamp',
       [req.params.id]
     );

     // Create new session with same config
     const newSession = await createSession(originalConfig);

     // Replay each event
     for (const event of events.rows) {
       await replayEvent(newSession.id, event);
     }

     res.json({ replaySessionId: newSession.id });
   });
   ```

2. **Debug Mode**:
   ```typescript
   // Enable verbose logging for specific session
   router.patch('/sessions/:id/debug', async (req, res) => {
     await pool.query(
       `UPDATE sessions SET metadata = metadata || '{"debugMode": true}'
        WHERE id = $1`,
       [req.params.id]
     );

     // Hook scripts check for debug mode and log more
     if [ "$DEBUG_MODE" = "true" ]; then
       echo "TOOL_INPUT: $TOOL_INPUT" >> /tmp/debug.log
       echo "TOOL_RESULT: $TOOL_RESULT" >> /tmp/debug.log
     fi
   });
   ```

---

### 3. No Alerting for Critical Issues

**Challenge**: When sessions fail or system has issues, no one is notified.

**Proposed Solutions**:

1. **Alert Rules**:
   ```typescript
   const alerts = {
     sessionFailed: {
       condition: (session) => session.status === 'error',
       action: async (session) => {
         await sendSlackAlert(`Session ${session.id} failed`, {
           project: session.project_path,
           error: session.metadata.error
         });
       }
     },
     diskSpaceLow: {
       condition: async () => {
         const stats = await checkDiskSpace();
         return stats.availableGB < 10;
       },
       action: async () => {
         await sendSlackAlert('Disk space low', { available: stats.availableGB });
       }
     },
     hookDeliveryFailing: {
       condition: async () => {
         const failureRate = await getHookFailureRate();
         return failureRate > 0.1; // 10% failure rate
       },
       action: async () => {
         await sendSlackAlert('Hook delivery failure rate high');
       }
     }
   };

   // Check alerts every minute
   cron.schedule('* * * * *', async () => {
     for (const [name, alert] of Object.entries(alerts)) {
       if (await alert.condition()) {
         await alert.action();
       }
     }
   });
   ```

2. **PagerDuty Integration**:
   ```typescript
   import { EventV2 as PagerDutyEvent } from '@pagerduty/pdjs';

   async function sendPagerDutyAlert(severity: 'critical' | 'error' | 'warning', message: string) {
     const event = new PagerDutyEvent({
       routing_key: process.env.PAGERDUTY_ROUTING_KEY,
       event_action: 'trigger',
       payload: {
         summary: message,
         severity,
         source: 'claude-orchestrator'
       }
     });

     await event.send();
   }
   ```

---

## Future Enhancements

### 1. Multi-Tenant Architecture

**Goal**: Support multiple organizations/teams with data isolation.

**Changes Required**:

```sql
-- Add organization table
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add tenant column to sessions
ALTER TABLE sessions ADD COLUMN organization_id UUID REFERENCES organizations(id);

-- Row-level security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  USING (organization_id = current_setting('app.current_org_id')::uuid);

-- API middleware
app.use((req, res, next) => {
  const orgId = req.user.organizationId;
  req.dbQuery = async (sql, params) => {
    await pool.query('SET app.current_org_id = $1', [orgId]);
    return pool.query(sql, params);
  };
  next();
});
```

---

### 2. AI-Powered Session Suggestions

**Goal**: Suggest next actions based on session history and patterns.

**Implementation**:

```typescript
async function suggestNextActions(sessionId: string): Promise<string[]> {
  const session = await getSession(sessionId);
  const logs = await getSessionLogs(sessionId);

  // Analyze patterns
  const patterns = analyzePatterns(logs);

  // Common patterns:
  // - After npm install, usually run tests
  // - After editing code, usually run linter
  // - After git commit, usually push

  const suggestions = [];

  if (patterns.includes('npm_install_completed') && !patterns.includes('tests_run')) {
    suggestions.push('Run tests with: npm test');
  }

  if (patterns.includes('files_edited') && !patterns.includes('linter_run')) {
    suggestions.push('Run linter to check code quality');
  }

  if (patterns.includes('git_commit') && !patterns.includes('git_push')) {
    suggestions.push('Push commits to remote');
  }

  return suggestions;
}

router.get('/sessions/:id/suggestions', async (req, res) => {
  const suggestions = await suggestNextActions(req.params.id);
  res.json({ suggestions });
});
```

---

### 3. Session Branching & Experimentation

**Goal**: Create branches from a session to try different approaches.

**Implementation**:

```typescript
router.post('/sessions/:id/branch', async (req, res) => {
  const { name, description } = req.body;
  const parentSession = await getSession(req.params.id);

  // Create workspace snapshot
  const snapshot = await createSnapshot(req.params.id);

  // Create new session from snapshot
  const branchSession = await createSession({
    ...parentSession,
    metadata: {
      ...parentSession.metadata,
      parentSessionId: req.params.id,
      branchName: name,
      description
    }
  });

  // Restore snapshot to new workspace
  await restoreSnapshot(branchSession.id, snapshot.id);

  res.json(branchSession);
});

// Visualize session tree
router.get('/sessions/:id/tree', async (req, res) => {
  const tree = await buildSessionTree(req.params.id);
  res.json(tree);
});

/*
Session Tree:
└── main-session (abc-123)
    ├── experiment-auth (def-456)
    │   └── auth-with-jwt (ghi-789)
    └── experiment-database (jkl-012)
*/
```

---

### 4. Integration with CI/CD Pipelines

**Goal**: Trigger sessions from CI/CD events (PR opened, tests failed, etc.)

**Implementation**:

```typescript
// GitHub Actions integration
router.post('/integrations/github/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event === 'pull_request' && payload.action === 'opened') {
    // Trigger code review session
    const session = await createSession({
      projectType: 'github',
      githubRepo: payload.repository.full_name,
      initialPrompt: `Review PR #${payload.pull_request.number}: ${payload.pull_request.title}`,
      metadata: {
        prNumber: payload.pull_request.number,
        autoComment: true
      }
    });

    // Post comment with session link
    await octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.pull_request.number,
      body: `🤖 Claude Code is reviewing this PR. [View session](${DASHBOARD_URL}/sessions/${session.id})`
    });
  }

  if (event === 'workflow_run' && payload.workflow_run.conclusion === 'failure') {
    // Trigger debug session
    const session = await createSession({
      projectType: 'github',
      githubRepo: payload.repository.full_name,
      initialPrompt: 'Debug the failed CI workflow and suggest fixes',
      metadata: {
        workflowRunId: payload.workflow_run.id,
        autoFix: false
      }
    });
  }

  res.sendStatus(200);
});
```

---

## Recommendations & Priorities

### Critical (Do Before Production)

| Priority | Issue | Impact | Effort | Recommendation |
|----------|-------|--------|--------|----------------|
| 🔴 P0 | Hook reliability (fire-and-forget) | High | Medium | Add local event log + retry mechanism |
| 🔴 P0 | No authentication | Critical | Medium | Implement API key auth |
| 🔴 P0 | Path traversal vulnerability | Critical | Low | Add path validation |
| 🔴 P0 | Command injection in git ops | Critical | Low | Use spawn instead of execSync |
| 🔴 P0 | Workspace cleanup missing | High | Medium | Auto-cleanup on session close |

### High Priority (Do Within 1 Month)

| Priority | Issue | Impact | Effort | Recommendation |
|----------|-------|--------|--------|----------------|
| 🟠 P1 | Session state sync | High | Medium | Implement heartbeat + PID tracking |
| 🟠 P1 | Database scalability | High | High | Add blob storage for large results |
| 🟠 P1 | No health checks | Medium | Low | Add /health endpoint + metrics |
| 🟠 P1 | Race conditions | Medium | Medium | Add optimistic locking |
| 🟠 P1 | Secret scrubbing | High | Medium | Scrub secrets from tool results |

### Medium Priority (Do Within 3 Months)

| Priority | Issue | Impact | Effort | Recommendation |
|----------|-------|--------|--------|----------------|
| 🟡 P2 | Polling overhead | Medium | Medium | Implement SSE or WebSocket |
| 🟡 P2 | No error recovery | Medium | Medium | Add transaction-like cleanup |
| 🟡 P2 | Session templates | Low | Low | Add preset configurations |
| 🟡 P2 | Cost tracking | Low | Medium | Track and enforce budgets |
| 🟡 P2 | Alerting | Medium | Medium | Slack/PagerDuty integration |

### Low Priority (Future)

| Priority | Feature | Impact | Effort | Recommendation |
|----------|---------|--------|--------|----------------|
| 🟢 P3 | Multi-tenant support | Low | High | After MVP proven |
| 🟢 P3 | AI suggestions | Low | High | Nice-to-have feature |
| 🟢 P3 | Session branching | Low | Medium | Power user feature |
| 🟢 P3 | CI/CD integration | Medium | Medium | After core stability |

---

## Conclusion

This analysis identified **37 critical issues, gaps, and missing features** across:

- **5 critical architecture issues** requiring immediate attention
- **3 major scalability concerns** for production readiness
- **3 reliability gaps** affecting system resilience
- **4 security vulnerabilities** that must be fixed before public deployment
- **4 logic gaps** causing edge case failures
- **5 missing features** that users will expect
- **3 operational challenges** for day-to-day management
- **4 future enhancements** for competitive advantage

### Top 3 Priorities

1. **Security First**: Fix authentication, path traversal, and command injection before any production deployment
2. **Reliability Second**: Implement hook retry mechanism and workspace cleanup to prevent data loss
3. **Scalability Third**: Add blob storage and connection pool monitoring to handle growth

### Recommended Next Steps

1. Create GitHub issues for all P0 and P1 items
2. Implement security fixes in a dedicated sprint
3. Add comprehensive tests for edge cases
4. Set up monitoring and alerting before production
5. Document operational runbooks for common failure scenarios

This system has great potential but needs these critical fixes before production use.
