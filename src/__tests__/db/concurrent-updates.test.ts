/**
 * Tests for Session Concurrency Control with Optimistic Locking
 *
 * Tests cover:
 * - VersionConflictError error class
 * - updateSessionWithVersion function
 * - touchSessionWithVersion function
 * - Retry logic with exponential backoff
 * - Concurrent update scenarios
 * - Metrics collection
 */

import { Pool } from 'pg';
import {
  VersionConflictError,
  Session,
  SessionStatus,
  SessionUpdatePayload,
  getSessionById,
  updateSessionWithVersion,
  touchSessionWithVersion,
  getSessionByClaudeId,
} from '../../db/queries';
import {
  withOptimisticLockRetry,
  updateSessionWithRetry,
  RetryOptions,
  RetryResult,
  createRetryMetricsCollector,
} from '../../db/retry';

// Mock session data
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'test-session-uuid',
  project_path: '/tmp/test-workspace',
  project_type: 'local',
  status: 'active',
  claude_session_id: 'claude-123',
  metadata: {},
  created_at: new Date(),
  updated_at: new Date(),
  version: 1,
  ...overrides,
});

// Mock Pool for testing
class MockPool {
  private sessions: Map<string, Session> = new Map();
  private queryLog: Array<{ text: string; values: any[] }> = [];
  private simulateConflict: boolean = false;
  private conflictCount: number = 0;
  private maxConflicts: number = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.sessions.clear();
    this.queryLog = [];
    this.simulateConflict = false;
    this.conflictCount = 0;
    this.maxConflicts = 0;
  }

  addSession(session: Session): void {
    this.sessions.set(session.id, { ...session });
    if (session.claude_session_id) {
      // Also index by claude_session_id for lookup
    }
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  setSimulateConflict(conflicts: number): void {
    this.simulateConflict = true;
    this.conflictCount = 0;
    this.maxConflicts = conflicts;
  }

  getQueryLog(): Array<{ text: string; values: any[] }> {
    return this.queryLog;
  }

  async query(text: string, values: any[] = []): Promise<any> {
    this.queryLog.push({ text, values });

    // Handle SELECT session by ID
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('WHERE id')) {
      const id = values[0];
      const session = this.sessions.get(id);
      return { rows: session ? [session] : [] };
    }

    // Handle SELECT session by claude_session_id
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('WHERE claude_session_id')) {
      const claudeId = values[0];
      for (const session of this.sessions.values()) {
        if (session.claude_session_id === claudeId) {
          return { rows: [session] };
        }
      }
      return { rows: [] };
    }

    // Handle UPDATE with version check
    if (text.includes('UPDATE sessions') && text.includes('version')) {
      // Extract id and version from parameters using WHERE clause pattern
      const whereVersionMatch = text.match(/WHERE\s+id\s*=\s*\$(\d+)\s+AND\s+version\s*=\s*\$(\d+)/i);

      if (whereVersionMatch) {
        const idParamIndex = parseInt(whereVersionMatch[1], 10) - 1;
        const versionParamIndex = parseInt(whereVersionMatch[2], 10) - 1;
        const id = values[idParamIndex];
        const expectedVersion = values[versionParamIndex];

        const session = this.sessions.get(id);
        if (!session) {
          return { rows: [] };
        }

        // Simulate conflict if enabled
        if (this.simulateConflict && this.conflictCount < this.maxConflicts) {
          this.conflictCount++;
          return { rows: [] }; // Version mismatch
        }

        // Check version
        if (session.version !== expectedVersion) {
          return { rows: [] }; // Version mismatch
        }

        // Update the session
        session.version++;
        session.updated_at = new Date();

        // Apply other updates based on SET clauses
        // Look for "status = $N" pattern
        const statusMatch = text.match(/SET[^W]*status\s*=\s*\$(\d+)/i);
        if (statusMatch) {
          const statusIndex = parseInt(statusMatch[1], 10) - 1;
          session.status = values[statusIndex] as SessionStatus;
        }

        // Look for "claude_session_id = $N" pattern
        const claudeIdMatch = text.match(/SET[^W]*claude_session_id\s*=\s*\$(\d+)/i);
        if (claudeIdMatch) {
          const claudeIdIndex = parseInt(claudeIdMatch[1], 10) - 1;
          session.claude_session_id = values[claudeIdIndex];
        }

        return { rows: [{ version: session.version }] };
      }
    }

    // Handle UPDATE without version (legacy)
    if (text.includes('UPDATE sessions') && !text.includes('AND version =')) {
      const idMatch = text.match(/id = \$(\d+)/);
      if (idMatch) {
        const idParamIndex = parseInt(idMatch[1], 10) - 1;
        const id = values[idParamIndex];
        const session = this.sessions.get(id);
        if (session) {
          session.version++;
          session.updated_at = new Date();
          return { rows: [{ id: session.id }] };
        }
      }
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe('VersionConflictError', () => {
  it('should create error with correct properties', () => {
    const error = new VersionConflictError('test-session-id', 5);

    expect(error.name).toBe('VersionConflictError');
    expect(error.sessionId).toBe('test-session-id');
    expect(error.expectedVersion).toBe(5);
    expect(error.message).toContain('test-session-id');
    expect(error.message).toContain('5');
  });

  it('should be instanceof Error', () => {
    const error = new VersionConflictError('test', 1);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof VersionConflictError).toBe(true);
  });
});

describe('getSessionById', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should return session with version field', async () => {
    const mockSession = createMockSession({ version: 5 });
    mockDb.addSession(mockSession);

    const session = await getSessionById(mockDb as unknown as Pool, mockSession.id);

    expect(session).not.toBeNull();
    expect(session?.version).toBe(5);
    expect(session?.id).toBe(mockSession.id);
  });

  it('should return null for non-existent session', async () => {
    const session = await getSessionById(mockDb as unknown as Pool, 'non-existent');

    expect(session).toBeNull();
  });
});

describe('getSessionByClaudeId', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should return session with version field', async () => {
    const mockSession = createMockSession({
      claude_session_id: 'claude-test-123',
      version: 3,
    });
    mockDb.addSession(mockSession);

    const session = await getSessionByClaudeId(
      mockDb as unknown as Pool,
      'claude-test-123'
    );

    expect(session).not.toBeNull();
    expect(session?.version).toBe(3);
    expect(session?.claude_session_id).toBe('claude-test-123');
  });

  it('should return null for non-existent claude_session_id', async () => {
    const session = await getSessionByClaudeId(
      mockDb as unknown as Pool,
      'non-existent'
    );

    expect(session).toBeNull();
  });
});

describe('updateSessionWithVersion', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should update session and return new version', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    const newVersion = await updateSessionWithVersion(
      mockDb as unknown as Pool,
      mockSession.id,
      { status: 'completed' },
      1
    );

    expect(newVersion).toBe(2);

    // Verify session was updated
    const updated = mockDb.getSession(mockSession.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.version).toBe(2);
  });

  it('should throw VersionConflictError on version mismatch', async () => {
    const mockSession = createMockSession({ version: 5 });
    mockDb.addSession(mockSession);

    await expect(
      updateSessionWithVersion(
        mockDb as unknown as Pool,
        mockSession.id,
        { status: 'completed' },
        3 // Wrong version
      )
    ).rejects.toThrow(VersionConflictError);
  });

  it('should throw VersionConflictError with correct properties', async () => {
    const mockSession = createMockSession({ version: 5 });
    mockDb.addSession(mockSession);

    try {
      await updateSessionWithVersion(
        mockDb as unknown as Pool,
        mockSession.id,
        { status: 'completed' },
        3
      );
      fail('Should have thrown');
    } catch (error) {
      expect(error instanceof VersionConflictError).toBe(true);
      const vce = error as VersionConflictError;
      expect(vce.sessionId).toBe(mockSession.id);
      expect(vce.expectedVersion).toBe(3);
    }
  });

  it('should handle multiple field updates', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    // Update status first
    const newVersion = await updateSessionWithVersion(
      mockDb as unknown as Pool,
      mockSession.id,
      { status: 'completed' },
      1
    );

    expect(newVersion).toBe(2);

    // Then update claude_session_id
    const newVersion2 = await updateSessionWithVersion(
      mockDb as unknown as Pool,
      mockSession.id,
      { claude_session_id: 'new-claude-id' },
      2
    );

    expect(newVersion2).toBe(3);
  });

  it('should return current version when no updates provided and version matches', async () => {
    const mockSession = createMockSession({ version: 5 });
    mockDb.addSession(mockSession);

    const version = await updateSessionWithVersion(
      mockDb as unknown as Pool,
      mockSession.id,
      {}, // No updates
      5
    );

    expect(version).toBe(5);
  });

  it('should throw VersionConflictError when no updates provided but version mismatches', async () => {
    const mockSession = createMockSession({ version: 5 });
    mockDb.addSession(mockSession);

    // Even with no updates, a stale version should fail
    await expect(
      updateSessionWithVersion(
        mockDb as unknown as Pool,
        mockSession.id,
        {}, // No updates
        3  // Stale version
      )
    ).rejects.toThrow(VersionConflictError);
  });
});

describe('touchSessionWithVersion', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should update timestamp and return new version', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    const newVersion = await touchSessionWithVersion(
      mockDb as unknown as Pool,
      mockSession.id,
      1
    );

    expect(newVersion).toBe(2);
  });

  it('should throw VersionConflictError on version mismatch', async () => {
    const mockSession = createMockSession({ version: 3 });
    mockDb.addSession(mockSession);

    await expect(
      touchSessionWithVersion(mockDb as unknown as Pool, mockSession.id, 1)
    ).rejects.toThrow(VersionConflictError);
  });
});

describe('withOptimisticLockRetry', () => {
  it('should return success on first attempt', async () => {
    const result = await withOptimisticLockRetry(async () => 'success');

    expect(result.success).toBe(true);
    expect(result.value).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.retriesExhausted).toBe(false);
  });

  it('should retry on VersionConflictError', async () => {
    let attempts = 0;

    const result = await withOptimisticLockRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new VersionConflictError('test', attempts);
        }
        return 'success';
      },
      { maxRetries: 5, baseDelayMs: 10 }
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe('success');
    expect(result.attempts).toBe(3);
    expect(attempts).toBe(3);
  });

  it('should exhaust retries and fail', async () => {
    const result = await withOptimisticLockRetry(
      async () => {
        throw new VersionConflictError('test', 1);
      },
      { maxRetries: 2, baseDelayMs: 10 }
    );

    expect(result.success).toBe(false);
    expect(result.retriesExhausted).toBe(true);
    expect(result.attempts).toBe(3); // Initial + 2 retries
    expect(result.error).toBeInstanceOf(VersionConflictError);
  });

  it('should not retry on non-VersionConflictError', async () => {
    const result = await withOptimisticLockRetry(
      async () => {
        throw new Error('Other error');
      },
      { maxRetries: 3, baseDelayMs: 10 }
    );

    expect(result.success).toBe(false);
    expect(result.retriesExhausted).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error?.message).toBe('Other error');
  });

  it('should respect maxRetries option', async () => {
    let attempts = 0;

    const result = await withOptimisticLockRetry(
      async () => {
        attempts++;
        throw new VersionConflictError('test', attempts);
      },
      { maxRetries: 5, baseDelayMs: 10 }
    );

    expect(result.attempts).toBe(6); // Initial + 5 retries
    expect(attempts).toBe(6);
  });

  it('should apply exponential backoff', async () => {
    const startTime = Date.now();
    let attempts = 0;

    await withOptimisticLockRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new VersionConflictError('test', attempts);
        }
        return 'success';
      },
      { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 500, jitterFactor: 0 }
    );

    const elapsed = Date.now() - startTime;
    // Should have delays: 50ms (2^0 * 50) + 100ms (2^1 * 50) = ~150ms
    expect(elapsed).toBeGreaterThan(100);
  });
});

describe('updateSessionWithRetry', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should update session successfully', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    const result = await updateSessionWithRetry(
      mockDb as unknown as Pool,
      mockSession.id,
      { status: 'completed' },
      { maxRetries: 3, baseDelayMs: 10 }
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(2); // New version
    expect(result.attempts).toBe(1);
  });

  it('should retry and succeed after conflicts', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    // Simulate 2 conflicts before success
    mockDb.setSimulateConflict(2);

    const result = await updateSessionWithRetry(
      mockDb as unknown as Pool,
      mockSession.id,
      { status: 'completed' },
      { maxRetries: 5, baseDelayMs: 10 }
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3); // 2 failures + 1 success
  });

  it('should fail for non-existent session', async () => {
    const result = await updateSessionWithRetry(
      mockDb as unknown as Pool,
      'non-existent',
      { status: 'completed' },
      { maxRetries: 1, baseDelayMs: 10 }
    );

    expect(result.success).toBe(false);
    expect(result.retriesExhausted).toBe(false);
    expect(result.error?.message).toContain('not found');
  });
});

describe('RetryMetricsCollector', () => {
  it('should track successful first attempts', () => {
    const collector = createRetryMetricsCollector();

    collector.record({
      success: true,
      value: 1,
      attempts: 1,
      retriesExhausted: false,
    });

    const metrics = collector.getMetrics();
    expect(metrics.successfulFirstAttempts).toBe(1);
    expect(metrics.totalAttempts).toBe(1);
  });

  it('should track successful retries', () => {
    const collector = createRetryMetricsCollector();

    collector.record({
      success: true,
      value: 1,
      attempts: 3,
      retriesExhausted: false,
    });

    const metrics = collector.getMetrics();
    expect(metrics.successfulRetries).toBe(1);
    expect(metrics.totalAttempts).toBe(3);
  });

  it('should track failed after retries', () => {
    const collector = createRetryMetricsCollector();

    collector.record({
      success: false,
      attempts: 4,
      retriesExhausted: true,
      error: new VersionConflictError('test', 1),
    });

    const metrics = collector.getMetrics();
    expect(metrics.failedAfterRetries).toBe(1);
    expect(metrics.totalAttempts).toBe(4);
  });

  it('should track non-retryable errors', () => {
    const collector = createRetryMetricsCollector();

    collector.record({
      success: false,
      attempts: 1,
      retriesExhausted: false,
      error: new Error('Other error'),
    });

    const metrics = collector.getMetrics();
    expect(metrics.nonRetryableErrors).toBe(1);
  });

  it('should reset metrics', () => {
    const collector = createRetryMetricsCollector();

    collector.record({
      success: true,
      value: 1,
      attempts: 1,
      retriesExhausted: false,
    });

    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.totalAttempts).toBe(0);
    expect(metrics.successfulFirstAttempts).toBe(0);
  });

  it('should aggregate multiple records', () => {
    const collector = createRetryMetricsCollector();

    // Record various outcomes
    collector.record({ success: true, value: 1, attempts: 1, retriesExhausted: false });
    collector.record({ success: true, value: 2, attempts: 2, retriesExhausted: false });
    collector.record({ success: true, value: 3, attempts: 3, retriesExhausted: false });
    collector.record({ success: false, attempts: 4, retriesExhausted: true });
    collector.record({ success: false, attempts: 1, retriesExhausted: false });

    const metrics = collector.getMetrics();
    expect(metrics.totalAttempts).toBe(1 + 2 + 3 + 4 + 1);
    expect(metrics.successfulFirstAttempts).toBe(1);
    expect(metrics.successfulRetries).toBe(2);
    expect(metrics.failedAfterRetries).toBe(1);
    expect(metrics.nonRetryableErrors).toBe(1);
  });
});

describe('Concurrent Update Simulation', () => {
  let mockDb: MockPool;

  beforeEach(() => {
    mockDb = new MockPool();
  });

  it('should handle simulated concurrent updates', async () => {
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    // Simulate 10 concurrent updates
    const updatePromises = Array.from({ length: 10 }, (_, i) =>
      updateSessionWithRetry(
        mockDb as unknown as Pool,
        mockSession.id,
        { status: i % 2 === 0 ? 'active' : 'completed' },
        { maxRetries: 10, baseDelayMs: 5 }
      )
    );

    const results = await Promise.all(updatePromises);

    // All should eventually succeed
    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBe(10);

    // Final version should be 11 (started at 1, 10 updates)
    const finalSession = mockDb.getSession(mockSession.id);
    expect(finalSession?.version).toBe(11);
  });

  it('should track total attempts across concurrent updates', async () => {
    const collector = createRetryMetricsCollector();
    const mockSession = createMockSession({ version: 1 });
    mockDb.addSession(mockSession);

    // Run concurrent updates and collect metrics
    const updatePromises = Array.from({ length: 5 }, () =>
      updateSessionWithRetry(
        mockDb as unknown as Pool,
        mockSession.id,
        { status: 'active' },
        { maxRetries: 10, baseDelayMs: 5 }
      ).then((result) => {
        collector.record(result);
        return result;
      })
    );

    await Promise.all(updatePromises);

    const metrics = collector.getMetrics();
    // At least 5 successful operations
    expect(metrics.successfulFirstAttempts + metrics.successfulRetries).toBe(5);
    // Total attempts should be >= 5 (some may have retried)
    expect(metrics.totalAttempts).toBeGreaterThanOrEqual(5);
  });
});
