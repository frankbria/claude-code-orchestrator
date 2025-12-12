# Product Backlog - P2 & P3 Issues

**Version**: 1.0
**Date**: December 12, 2025
**Status**: Backlog

This document tracks medium and low priority issues identified during architecture analysis. These will be addressed after P0 and P1 critical items are completed.

---

## Table of Contents

- [P2 - Medium Priority (3 Months)](#p2---medium-priority-3-months)
- [P3 - Low Priority (Future)](#p3---low-priority-future)
- [Conversion to GitHub Issues](#conversion-to-github-issues)

---

## P2 - Medium Priority (3 Months)

### P2-1: Reduce Dashboard Polling Overhead

**Issue**: Dashboard polls every 3 seconds. With 100 dashboards, creates 67 req/s load.

**Impact**: Medium - Database load increases with concurrent dashboards

**Math**:
```
Dashboards: 100
Polling interval: 3 seconds
Endpoints per dashboard: 2 (logs + messages)
Requests per second: (100 * 2) / 3 = 67 req/s
Database queries per second: 134 queries/s
```

**Proposed Solutions**:

1. **Dynamic Polling Interval**:
   ```typescript
   const usePolling = (fetchFn, options) => {
     const [interval, setInterval] = useState(3000);

     useEffect(() => {
       // If no changes for 30 seconds, slow down
       if (unchangedDuration > 30000) {
         setInterval(10000); // Poll every 10s instead
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
   const eventSource = new EventSource(`/api/sessions/${id}/stream`);
   eventSource.onmessage = (event) => {
     setLogs(JSON.parse(event.data));
   };
   ```

3. **WebSocket (if needed)**:
   ```typescript
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

**Acceptance Criteria**:
- [ ] Implement dynamic polling intervals
- [ ] Add SSE endpoint for real-time updates
- [ ] Dashboard supports both polling and SSE
- [ ] Performance testing with 50+ dashboards
- [ ] Documentation for SSE configuration

**Estimated Effort**: 1-2 weeks

**References**: [BRAINSTORM.md - Scalability Concerns #2](../BRAINSTORM.md#2-polling-overhead-at-scale)

---

### P2-2: Transaction-like Error Recovery

**Issue**: Multi-step operations (workspace creation + DB insert) can fail partially, leaving system in inconsistent state.

**Impact**: Medium - Orphaned resources, manual cleanup required

**Scenario**:
```
POST /api/sessions
→ Workspace created: /tmp/repo-123
→ Database insert fails ❌
Result: Orphaned workspace, no session record
```

**Proposed Solution**:

```typescript
router.post('/sessions', async (req, res) => {
  let workspacePath: string | null = null;
  let sessionId: string | null = null;

  try {
    // Step 1: Create workspace
    workspacePath = await workspaceManager.prepareWorkspace(req.body);

    // Step 2: Insert to database
    sessionId = await createSession({
      projectPath: workspacePath,
      ...req.body
    });

    res.status(201).json({ sessionId, workspacePath });

  } catch (error) {
    // Rollback: Clean up workspace if created
    if (workspacePath && !sessionId) {
      await workspaceManager.cleanup(workspacePath).catch(err => {
        console.error('Cleanup failed:', err);
      });
    }

    res.status(500).json({
      error: 'Session creation failed',
      details: error.message
    });
  }
});
```

**Idempotency Support**:
```typescript
router.post('/sessions', async (req, res) => {
  const { idempotencyKey } = req.body;

  if (idempotencyKey) {
    // Check if already processed
    const existing = await pool.query(
      `SELECT * FROM sessions
       WHERE metadata->>'idempotencyKey' = $1`,
      [idempotencyKey]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json(existing.rows[0]);
    }
  }

  // Create new session...
});
```

**Acceptance Criteria**:
- [ ] All multi-step operations have rollback logic
- [ ] Idempotency keys supported
- [ ] Tests for partial failures
- [ ] Cleanup tracked in logs
- [ ] Retry-safe operations

**Estimated Effort**: 1 week

**References**: [BRAINSTORM.md - Reliability Gaps #1](../BRAINSTORM.md#1-no-error-recovery-for-failed-operations)

---

### P2-3: Session Templates & Presets

**Issue**: Users want to quickly start sessions with predefined configurations.

**Impact**: Low - Quality of life improvement

**Proposed Feature**:

```typescript
// Session templates
const templates = {
  'code-review': {
    name: 'Code Review',
    description: 'Review codebase for security and quality',
    initialPrompt: 'Review this codebase for security vulnerabilities and code quality issues',
    projectType: 'github',
    metadata: {
      tools: ['security-scanner', 'linter'],
      autoClose: true,
      maxDuration: '2 hours'
    }
  },
  'refactor-typescript': {
    name: 'JavaScript to TypeScript Migration',
    description: 'Convert JavaScript code to TypeScript',
    initialPrompt: 'Refactor JavaScript code to TypeScript with proper types',
    projectType: 'local',
    metadata: {
      tools: ['typescript', 'prettier'],
      autoCommit: false
    }
  },
  'dependency-update': {
    name: 'Update Dependencies',
    description: 'Update npm dependencies safely',
    initialPrompt: 'Update npm dependencies, run tests, and fix breaking changes',
    projectType: 'github',
    metadata: {
      tools: ['npm', 'test-runner'],
      createPR: true
    }
  }
};

// API endpoint
router.get('/templates', async (req, res) => {
  res.json(Object.entries(templates).map(([id, template]) => ({
    id,
    ...template
  })));
});

router.post('/sessions/from-template', async (req, res) => {
  const { templateId, githubRepo, overrides } = req.body;
  const template = templates[templateId];

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const session = await createSession({
    ...template,
    githubRepo,
    ...overrides
  });

  res.json(session);
});
```

**Template Storage**:
```sql
CREATE TABLE session_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  config JSONB NOT NULL,
  created_by UUID,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Dashboard UI**:
```typescript
// Template selector
<select onChange={(e) => setSelectedTemplate(e.target.value)}>
  {templates.map(t => (
    <option key={t.id} value={t.id}>
      {t.name} - {t.description}
    </option>
  ))}
</select>

<button onClick={() => createSessionFromTemplate(selectedTemplate)}>
  Start Session
</button>
```

**Acceptance Criteria**:
- [ ] Template CRUD API endpoints
- [ ] Pre-defined templates for common workflows
- [ ] Template storage in database
- [ ] Dashboard template selector
- [ ] Template override support
- [ ] User-created templates (future)

**Estimated Effort**: 1-2 weeks

**References**: [BRAINSTORM.md - Missing Features #1](../BRAINSTORM.md#1-session-templates--presets)

---

### P2-4: Cost Tracking & Budget Enforcement

**Issue**: No visibility into API usage costs or budget limits.

**Impact**: Medium - Important for production cost control

**Proposed Feature**:

```sql
-- Cost tracking schema
ALTER TABLE sessions ADD COLUMN estimated_cost DECIMAL(10,2) DEFAULT 0;
ALTER TABLE sessions ADD COLUMN budget_limit DECIMAL(10,2);

CREATE TABLE cost_rates (
  tool VARCHAR(100) PRIMARY KEY,
  cost_per_execution DECIMAL(10,6) NOT NULL,
  cost_per_kb DECIMAL(10,6),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Initial cost rates
INSERT INTO cost_rates (tool, cost_per_execution) VALUES
  ('bash', 0.001),
  ('edit_file', 0.002),
  ('read_file', 0.001),
  ('web_search', 0.01),
  ('grep', 0.0005);
```

**Cost Calculation**:
```typescript
async function calculateSessionCost(sessionId: string): Promise<number> {
  const logs = await pool.query(`
    SELECT cl.tool, COUNT(*) as count,
           SUM(LENGTH(cl.result)) as total_bytes
    FROM command_logs cl
    WHERE cl.session_id = $1
    GROUP BY cl.tool
  `, [sessionId]);

  let totalCost = 0;

  for (const row of logs.rows) {
    const rate = await getCostRate(row.tool);
    totalCost += rate.cost_per_execution * row.count;

    if (rate.cost_per_kb && row.total_bytes) {
      totalCost += (row.total_bytes / 1024) * rate.cost_per_kb;
    }
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
```

**Budget Enforcement**:
```typescript
async function checkBudget(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  const budget = session.budget_limit || session.metadata.budget;

  if (!budget) return;

  if (session.estimated_cost > budget) {
    await updateSession(sessionId, {
      status: 'budget_exceeded',
      metadata: {
        ...session.metadata,
        budgetExceededAt: new Date(),
        finalCost: session.estimated_cost
      }
    });

    throw new Error(`Session exceeded budget of $${budget}`);
  }
}

// Check budget in hook handler
router.post('/hooks/tool-complete', async (req, res) => {
  // ... log tool execution

  await checkBudget(sessionId);

  res.sendStatus(200);
});
```

**Dashboard Widget**:
```typescript
<div className="cost-meter">
  <h3>Session Cost</h3>
  <div className="progress-bar">
    <div style={{ width: `${(cost / budget) * 100}%` }}>
      ${cost.toFixed(2)} / ${budget.toFixed(2)}
    </div>
  </div>
  {cost > budget * 0.8 && (
    <div className="warning">⚠️ Approaching budget limit</div>
  )}
</div>
```

**Acceptance Criteria**:
- [ ] Cost tracking schema
- [ ] Cost rate configuration
- [ ] Automatic cost calculation
- [ ] Budget limit enforcement
- [ ] Dashboard cost display
- [ ] Cost reports and analytics
- [ ] Configurable cost rates

**Estimated Effort**: 2 weeks

**References**: [BRAINSTORM.md - Missing Features #4](../BRAINSTORM.md#4-cost-tracking--budgets)

---

### P2-5: Alerting & Notifications

**Issue**: No alerts when sessions fail or system has issues.

**Impact**: Medium - Operations need proactive notification

**Proposed Solution**:

```typescript
// Alert configuration
interface AlertRule {
  name: string;
  condition: () => Promise<boolean>;
  action: (context?: any) => Promise<void>;
  throttle?: number; // Minutes between alerts
}

const alertRules: AlertRule[] = [
  {
    name: 'session_failed',
    condition: async () => {
      const failed = await pool.query(`
        SELECT COUNT(*) FROM sessions
        WHERE status = 'error'
        AND updated_at > NOW() - INTERVAL '5 minutes'
      `);
      return parseInt(failed.rows[0].count) > 0;
    },
    action: async () => {
      const sessions = await getFailedSessions();
      await sendSlackAlert('Sessions Failed', {
        count: sessions.length,
        sessions: sessions.map(s => s.id)
      });
    },
    throttle: 15
  },
  {
    name: 'disk_space_low',
    condition: async () => {
      const stats = await checkDiskSpace();
      return stats.availableGB < 10;
    },
    action: async () => {
      const stats = await checkDiskSpace();
      await sendSlackAlert('⚠️ Disk Space Low', {
        available: `${stats.availableGB.toFixed(2)} GB`,
        usage: stats.usagePercent
      });
      await sendPagerDutyAlert('warning', 'Disk space below 10GB');
    },
    throttle: 60
  },
  {
    name: 'hook_delivery_failing',
    condition: async () => {
      const failureRate = await getHookFailureRate();
      return failureRate > 0.1; // 10%
    },
    action: async () => {
      await sendSlackAlert('Hook Delivery Issues', {
        failureRate: `${(failureRate * 100).toFixed(1)}%`
      });
    },
    throttle: 30
  },
  {
    name: 'high_session_count',
    condition: async () => {
      const count = await getActiveSessionCount();
      return count > 50;
    },
    action: async () => {
      await sendSlackAlert('High Session Count', {
        active: count,
        limit: 50
      });
    },
    throttle: 60
  }
];

// Alert engine
class AlertEngine {
  private lastAlerted = new Map<string, number>();

  async checkAlerts() {
    for (const rule of alertRules) {
      try {
        if (await rule.condition()) {
          await this.triggerAlert(rule);
        }
      } catch (error) {
        console.error(`Alert check failed: ${rule.name}`, error);
      }
    }
  }

  private async triggerAlert(rule: AlertRule) {
    const now = Date.now();
    const lastTime = this.lastAlerted.get(rule.name) || 0;
    const throttleMs = (rule.throttle || 0) * 60 * 1000;

    if (now - lastTime < throttleMs) {
      return; // Throttled
    }

    await rule.action();
    this.lastAlerted.set(rule.name, now);
  }
}

// Run every minute
cron.schedule('* * * * *', async () => {
  await alertEngine.checkAlerts();
});
```

**Slack Integration**:
```typescript
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function sendSlackAlert(title: string, details: any) {
  await slack.chat.postMessage({
    channel: process.env.SLACK_ALERT_CHANNEL,
    text: title,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🚨 ${title}` }
      },
      {
        type: 'section',
        fields: Object.entries(details).map(([key, value]) => ({
          type: 'mrkdwn',
          text: `*${key}:*\n${value}`
        }))
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `<!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|now>`
        }]
      }
    ]
  });
}
```

**PagerDuty Integration**:
```typescript
import { EventV2 } from '@pagerduty/pdjs';

async function sendPagerDutyAlert(
  severity: 'critical' | 'error' | 'warning',
  message: string,
  details?: any
) {
  const event = new EventV2({
    routing_key: process.env.PAGERDUTY_ROUTING_KEY,
    event_action: 'trigger',
    payload: {
      summary: message,
      severity,
      source: 'claude-orchestrator',
      custom_details: details
    }
  });

  await event.send();
}
```

**Acceptance Criteria**:
- [ ] Alert rule configuration system
- [ ] Alert engine with throttling
- [ ] Slack integration
- [ ] PagerDuty integration (optional)
- [ ] Email integration (optional)
- [ ] Alert history/logs
- [ ] Configurable alert rules
- [ ] Testing for alert conditions

**Estimated Effort**: 2 weeks

**References**: [BRAINSTORM.md - Operational Challenges #3](../BRAINSTORM.md#3-no-alerting-for-critical-issues)

---

## P3 - Low Priority (Future)

### P3-1: Multi-Tenant Architecture

**Issue**: System is single-tenant. Need to support multiple organizations with data isolation.

**Impact**: Low - Required for SaaS offering

**Proposed Changes**:

```sql
-- Organization table
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  role VARCHAR(50), -- 'admin', 'user', 'viewer'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add tenant column to sessions
ALTER TABLE sessions ADD COLUMN organization_id UUID REFERENCES organizations(id);
CREATE INDEX idx_sessions_org ON sessions(organization_id);

-- Row-level security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  USING (organization_id = current_setting('app.current_org_id')::uuid);

-- Same for other tables
ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_logs ENABLE ROW LEVEL SECURITY;
```

**API Middleware**:
```typescript
app.use(async (req, res, next) => {
  const orgId = req.user.organizationId;

  // Set organization context for RLS
  req.dbQuery = async (sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('SET app.current_org_id = $1', [orgId]);
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  };

  next();
});
```

**Organization Quota Management**:
```typescript
interface OrganizationLimits {
  maxSessions: number;
  maxWorkspaces: number;
  maxStorageGB: number;
  maxCostPerMonth: number;
}

async function checkOrganizationQuota(orgId: string): Promise<void> {
  const limits = await getOrganizationLimits(orgId);
  const usage = await getOrganizationUsage(orgId);

  if (usage.activeSessions >= limits.maxSessions) {
    throw new Error('Organization session limit exceeded');
  }

  if (usage.storageGB >= limits.maxStorageGB) {
    throw new Error('Organization storage limit exceeded');
  }
}
```

**Acceptance Criteria**:
- [ ] Organization and user tables
- [ ] Row-level security policies
- [ ] Organization context middleware
- [ ] Quota enforcement
- [ ] Organization dashboard
- [ ] User management UI
- [ ] Organization settings

**Estimated Effort**: 4-6 weeks

**References**: [BRAINSTORM.md - Future Enhancements #1](../BRAINSTORM.md#1-multi-tenant-architecture)

---

### P3-2: AI-Powered Session Suggestions

**Issue**: No guidance on next actions based on session context.

**Impact**: Low - Quality of life improvement

**Proposed Feature**:

```typescript
interface SessionPattern {
  name: string;
  detect: (logs: CommandLog[]) => boolean;
  suggestion: string;
  priority: number;
}

const patterns: SessionPattern[] = [
  {
    name: 'npm_install_no_test',
    detect: (logs) => {
      const hasNpmInstall = logs.some(l =>
        l.tool === 'bash' && l.input.command?.includes('npm install')
      );
      const hasTest = logs.some(l =>
        l.tool === 'bash' && l.input.command?.includes('npm test')
      );
      return hasNpmInstall && !hasTest;
    },
    suggestion: 'Run tests after installing dependencies: npm test',
    priority: 8
  },
  {
    name: 'files_edited_no_lint',
    detect: (logs) => {
      const hasEdit = logs.some(l => l.tool === 'edit_file');
      const hasLint = logs.some(l =>
        l.tool === 'bash' && l.input.command?.includes('lint')
      );
      return hasEdit && !hasLint;
    },
    suggestion: 'Run linter to check code quality',
    priority: 6
  },
  {
    name: 'git_commit_no_push',
    detect: (logs) => {
      const hasCommit = logs.some(l =>
        l.tool === 'bash' && l.input.command?.includes('git commit')
      );
      const hasPush = logs.some(l =>
        l.tool === 'bash' && l.input.command?.includes('git push')
      );
      return hasCommit && !hasPush;
    },
    suggestion: 'Push commits to remote repository',
    priority: 7
  }
];

async function suggestNextActions(sessionId: string): Promise<string[]> {
  const logs = await getSessionLogs(sessionId);

  const suggestions = patterns
    .filter(pattern => pattern.detect(logs))
    .sort((a, b) => b.priority - a.priority)
    .map(pattern => pattern.suggestion);

  return suggestions;
}

router.get('/sessions/:id/suggestions', async (req, res) => {
  const suggestions = await suggestNextActions(req.params.id);
  res.json({ suggestions });
});
```

**Dashboard Integration**:
```typescript
<div className="suggestions">
  {suggestions.map((suggestion, i) => (
    <div key={i} className="suggestion-card">
      <span className="icon">💡</span>
      <span>{suggestion}</span>
      <button onClick={() => applySuggestion(suggestion)}>
        Apply
      </button>
    </div>
  ))}
</div>
```

**Acceptance Criteria**:
- [ ] Pattern detection engine
- [ ] Configurable suggestion patterns
- [ ] API endpoint for suggestions
- [ ] Dashboard suggestion display
- [ ] One-click suggestion application
- [ ] Machine learning improvements (future)

**Estimated Effort**: 2-3 weeks

**References**: [BRAINSTORM.md - Future Enhancements #2](../BRAINSTORM.md#2-ai-powered-session-suggestions)

---

### P3-3: Session Branching & Experimentation

**Issue**: Cannot easily try different approaches from same starting point.

**Impact**: Low - Power user feature

**Proposed Feature**:

```typescript
// Create branch from session
router.post('/sessions/:id/branch', async (req, res) => {
  const { name, description } = req.body;
  const parentSession = await getSession(req.params.id);

  // Create workspace snapshot
  const snapshot = await createSnapshot(req.params.id);

  // Create new session
  const branchSession = await createSession({
    projectType: parentSession.project_type,
    projectPath: `${parentSession.project_path}-branch-${Date.now()}`,
    metadata: {
      parentSessionId: req.params.id,
      branchName: name,
      description,
      snapshotId: snapshot.id
    }
  });

  // Restore snapshot to new workspace
  await restoreSnapshot(branchSession.id, snapshot.id);

  res.json(branchSession);
});

// Get session tree
router.get('/sessions/:id/tree', async (req, res) => {
  const tree = await buildSessionTree(req.params.id);
  res.json(tree);
});

async function buildSessionTree(rootSessionId: string) {
  const root = await getSession(rootSessionId);
  const children = await pool.query(
    `SELECT * FROM sessions WHERE metadata->>'parentSessionId' = $1`,
    [rootSessionId]
  );

  return {
    session: root,
    branches: await Promise.all(
      children.rows.map(child => buildSessionTree(child.id))
    )
  };
}
```

**Tree Visualization**:
```typescript
<div className="session-tree">
  <SessionNode session={root} />
  {branches.map(branch => (
    <div className="branch">
      <div className="branch-line" />
      <SessionTreeView {...branch} />
    </div>
  ))}
</div>
```

**Acceptance Criteria**:
- [ ] Branch creation API
- [ ] Snapshot/restore functionality
- [ ] Session tree API
- [ ] Tree visualization UI
- [ ] Branch comparison
- [ ] Merge branches (advanced)

**Estimated Effort**: 3-4 weeks

**References**: [BRAINSTORM.md - Future Enhancements #3](../BRAINSTORM.md#3-session-branching--experimentation)

---

### P3-4: CI/CD Pipeline Integration

**Issue**: Cannot trigger sessions from CI/CD events automatically.

**Impact**: Medium - Useful for automated code review and testing

**Proposed Feature**:

```typescript
// GitHub webhook handler
router.post('/integrations/github/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  // Verify signature
  if (!verifyGitHubSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (event === 'pull_request' && payload.action === 'opened') {
    // Trigger code review session
    const session = await createSession({
      projectType: 'github',
      githubRepo: payload.repository.full_name,
      initialPrompt: `Review PR #${payload.pull_request.number}: ${payload.pull_request.title}`,
      metadata: {
        prNumber: payload.pull_request.number,
        prUrl: payload.pull_request.html_url,
        autoComment: true,
        trigger: 'github_webhook'
      }
    });

    // Post comment on PR
    await octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.pull_request.number,
      body: `🤖 Claude Code is reviewing this PR.\n\n[View session](${DASHBOARD_URL}/sessions/${session.id})`
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
        workflowUrl: payload.workflow_run.html_url,
        trigger: 'ci_failure'
      }
    });
  }

  res.sendStatus(200);
});

// Post results back to PR
async function postSessionResultsToPR(sessionId: string) {
  const session = await getSession(sessionId);
  const messages = await getSessionMessages(sessionId);

  const summary = messages
    .filter(m => m.direction === 'assistant')
    .map(m => m.content)
    .join('\n\n');

  await octokit.issues.createComment({
    owner: session.metadata.owner,
    repo: session.metadata.repo,
    issue_number: session.metadata.prNumber,
    body: `## Claude Code Review Results\n\n${summary}\n\n[Full session](${DASHBOARD_URL}/sessions/${sessionId})`
  });
}
```

**GitLab Integration**:
```typescript
router.post('/integrations/gitlab/webhook', async (req, res) => {
  const event = req.headers['x-gitlab-event'];
  const payload = req.body;

  if (event === 'Merge Request Hook' && payload.object_attributes.action === 'open') {
    // Similar to GitHub PR handling
  }

  res.sendStatus(200);
});
```

**Acceptance Criteria**:
- [ ] GitHub webhook integration
- [ ] GitLab webhook integration
- [ ] Webhook signature verification
- [ ] Auto-comment on PRs
- [ ] CI failure triggers
- [ ] Configuration UI for integrations
- [ ] Documentation for setup

**Estimated Effort**: 2-3 weeks

**References**: [BRAINSTORM.md - Future Enhancements #4](../BRAINSTORM.md#4-integration-with-cicd-pipelines)

---

### P3-5: Session Collaboration & Sharing

**Issue**: Cannot share running sessions with team members.

**Impact**: Low - Team collaboration feature

**Proposed Feature**:

```sql
CREATE TABLE session_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  permissions JSONB DEFAULT '{"read": true, "write": false, "control": false}',
  shared_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);
```

```typescript
// Share session
router.post('/sessions/:id/share', async (req, res) => {
  const { userId, permissions, expiresInHours } = req.body;

  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
    : null;

  await pool.query(
    `INSERT INTO session_shares (session_id, user_id, permissions, shared_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.params.id, userId, JSON.stringify(permissions), req.user.id, expiresAt]
  );

  const shareLink = generateShareLink(req.params.id, userId);

  // Send notification
  await sendShareNotification(userId, req.params.id, shareLink);

  res.json({ shareLink });
});

// Get shared sessions
router.get('/sessions/shared-with-me', async (req, res) => {
  const shared = await pool.query(`
    SELECT s.*, ss.permissions, ss.shared_by
    FROM sessions s
    JOIN session_shares ss ON ss.session_id = s.id
    WHERE ss.user_id = $1
    AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
  `, [req.user.id]);

  res.json(shared.rows);
});

// Check permissions
async function checkSessionPermission(
  sessionId: string,
  userId: string,
  permission: 'read' | 'write' | 'control'
): Promise<boolean> {
  const share = await pool.query(
    `SELECT permissions FROM session_shares
     WHERE session_id = $1 AND user_id = $2
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId, userId]
  );

  if (share.rows.length === 0) return false;
  return share.rows[0].permissions[permission] === true;
}
```

**Real-time Collaboration**:
```typescript
// WebSocket for live updates
io.on('connection', (socket) => {
  socket.on('join-session', async ({ sessionId, userId }) => {
    if (!await checkSessionPermission(sessionId, userId, 'read')) {
      socket.emit('error', 'Permission denied');
      return;
    }

    socket.join(`session-${sessionId}`);

    // Notify others
    socket.to(`session-${sessionId}`).emit('user-joined', { userId });
  });

  socket.on('send-message', async ({ sessionId, message }) => {
    // Broadcast to all watchers
    io.to(`session-${sessionId}`).emit('new-message', message);
  });
});
```

**Acceptance Criteria**:
- [ ] Share session API
- [ ] Permission levels (read/write/control)
- [ ] Share link generation
- [ ] Expiring shares
- [ ] List shared sessions
- [ ] Real-time collaboration (WebSocket)
- [ ] Dashboard UI for sharing

**Estimated Effort**: 3-4 weeks

**References**: [BRAINSTORM.md - Missing Features #2](../BRAINSTORM.md#2-session-collaboration--sharing)

---

### P3-6: Session Snapshots & Checkpoints

**Issue**: Cannot save/restore session state at specific points.

**Impact**: Low - Advanced feature for experimentation

**Proposed Feature**:

```sql
CREATE TABLE session_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  archive_path VARCHAR(500) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);
```

```typescript
// Create snapshot
router.post('/sessions/:id/snapshots', async (req, res) => {
  const { name, description } = req.body;
  const session = await getSession(req.params.id);

  // Archive workspace
  const archivePath = await archiveWorkspace(session.project_path, {
    name: `${session.id}-${Date.now()}`,
    compress: true
  });

  // Save snapshot metadata
  const snapshot = await pool.query(
    `INSERT INTO session_snapshots (session_id, name, description, archive_path)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.params.id, name, description, archivePath]
  );

  res.json(snapshot.rows[0]);
});

// List snapshots
router.get('/sessions/:id/snapshots', async (req, res) => {
  const snapshots = await pool.query(
    'SELECT * FROM session_snapshots WHERE session_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );

  res.json(snapshots.rows);
});

// Restore snapshot
router.post('/sessions/:id/restore', async (req, res) => {
  const { snapshotId } = req.body;

  const snapshot = await pool.query(
    'SELECT * FROM session_snapshots WHERE id = $1',
    [snapshotId]
  );

  if (snapshot.rows.length === 0) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  const session = await getSession(req.params.id);

  // Extract archive to workspace
  await extractArchive(snapshot.rows[0].archive_path, session.project_path);

  res.json({ status: 'restored', snapshot: snapshot.rows[0] });
});
```

**Acceptance Criteria**:
- [ ] Snapshot creation API
- [ ] Workspace archival (tar.gz)
- [ ] Snapshot restoration
- [ ] List snapshots
- [ ] Delete snapshots
- [ ] Dashboard snapshot UI
- [ ] Automatic snapshots (optional)

**Estimated Effort**: 2 weeks

**References**: [BRAINSTORM.md - Missing Features #3](../BRAINSTORM.md#3-session-snapshots--checkpoints)

---

### P3-7: Session Diff & Comparison

**Issue**: Cannot easily compare changes between sessions or snapshots.

**Impact**: Low - Analysis feature

**Proposed Feature**:

```typescript
router.get('/sessions/compare', async (req, res) => {
  const { sessionA, sessionB } = req.query;

  const [logsA, logsB] = await Promise.all([
    getSessionLogs(sessionA),
    getSessionLogs(sessionB)
  ]);

  const diff = {
    toolsOnlyInA: findUnique(logsA, logsB, 'tool'),
    toolsOnlyInB: findUnique(logsB, logsA, 'tool'),
    commonTools: findCommon(logsA, logsB, 'tool'),
    filesModified: await compareWorkspaces(sessionA, sessionB),
    costDifference: await compareCosts(sessionA, sessionB),
    timeDifference: await compareDurations(sessionA, sessionB)
  };

  res.json(diff);
});

async function compareWorkspaces(sessionIdA: string, sessionIdB: string) {
  const sessionA = await getSession(sessionIdA);
  const sessionB = await getSession(sessionIdB);

  // Use git diff if both are git repos
  try {
    const diffOutput = execSync(
      `diff -r ${sessionA.project_path} ${sessionB.project_path}`,
      { encoding: 'utf-8' }
    );

    return parseDiffOutput(diffOutput);
  } catch (error) {
    // Diff returns non-zero if differences found
    return parseDiffOutput(error.stdout);
  }
}

function parseDiffOutput(diffText: string) {
  const files = {
    added: [],
    removed: [],
    modified: []
  };

  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('Only in')) {
      // Parse added/removed files
    } else if (line.startsWith('diff')) {
      // Parse modified files
    }
  }

  return files;
}
```

**Dashboard UI**:
```typescript
<div className="session-comparison">
  <div className="comparison-header">
    <SessionSelector value={sessionA} onChange={setSessionA} />
    <span className="vs">vs</span>
    <SessionSelector value={sessionB} onChange={setSessionB} />
  </div>

  <div className="comparison-results">
    <DiffView diff={diff} />
    <FileChanges files={diff.filesModified} />
    <MetricComparison
      costA={diff.costA}
      costB={diff.costB}
      durationA={diff.durationA}
      durationB={diff.durationB}
    />
  </div>
</div>
```

**Acceptance Criteria**:
- [ ] Session comparison API
- [ ] Tool usage diff
- [ ] Workspace file diff
- [ ] Cost comparison
- [ ] Duration comparison
- [ ] Dashboard comparison UI
- [ ] Export comparison report

**Estimated Effort**: 2-3 weeks

**References**: [BRAINSTORM.md - Missing Features #5](../BRAINSTORM.md#5-session-diff--comparison)

---

## Conversion to GitHub Issues

When ready to implement these features, use the following process:

### Creating Issues from Backlog

```bash
# For P2 items:
gh issue create \
  --title "[P2] <Issue Title>" \
  --body "<Full description from this document>" \
  --label "enhancement,P2"

# For P3 items:
gh issue create \
  --title "[P3] <Issue Title>" \
  --body "<Full description from this document>" \
  --label "enhancement,P3,future"
```

### Priority Guidelines

**P2 (Medium Priority)**:
- Implement after all P0 and P1 items are complete
- Focus on operational improvements and user experience
- Target: 3-6 months from P0/P1 completion

**P3 (Low Priority)**:
- Implement based on user demand
- Focus on advanced features and nice-to-haves
- Target: 6-12 months or later

---

## Summary

### P2 Items (5 total)

| ID | Item | Impact | Effort | Priority |
|----|------|--------|--------|----------|
| P2-1 | Dashboard polling optimization | Medium | 1-2 weeks | After P1 |
| P2-2 | Error recovery | Medium | 1 week | After P1 |
| P2-3 | Session templates | Low | 1-2 weeks | Nice-to-have |
| P2-4 | Cost tracking | Medium | 2 weeks | Production ops |
| P2-5 | Alerting | Medium | 2 weeks | Production ops |

**Total P2 Effort**: ~7-10 weeks

### P3 Items (7 total)

| ID | Item | Impact | Effort | Priority |
|----|------|--------|--------|----------|
| P3-1 | Multi-tenant architecture | Low | 4-6 weeks | SaaS required |
| P3-2 | AI suggestions | Low | 2-3 weeks | UX enhancement |
| P3-3 | Session branching | Low | 3-4 weeks | Power users |
| P3-4 | CI/CD integration | Medium | 2-3 weeks | DevOps teams |
| P3-5 | Session collaboration | Low | 3-4 weeks | Team features |
| P3-6 | Snapshots | Low | 2 weeks | Experimentation |
| P3-7 | Session diff | Low | 2-3 weeks | Analysis |

**Total P3 Effort**: ~18-27 weeks

---

## Maintenance

This backlog should be reviewed quarterly to:
- Re-prioritize items based on user feedback
- Add new features discovered during development
- Remove items that are no longer relevant
- Update effort estimates based on team velocity

**Last Updated**: December 12, 2025
**Next Review**: March 12, 2026
