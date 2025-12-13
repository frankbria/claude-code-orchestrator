/**
 * Tests for Workspace Cleanup Functionality
 *
 * Tests cover:
 * - WorkspaceManager quota checks and archival
 * - Cleanup job scheduling and execution
 * - Database query helpers for cleanup
 * - Configuration loading and validation
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { Pool } from 'pg';
import { WorkspaceManager, DiskSpaceInfo, WorkspaceQuotaInfo } from '../../services/workspace';
import { CleanupJob, CleanupStats } from '../../services/cleanup-job';
import {
  loadCleanupConfig,
  validateCleanupConfig,
  resetCleanupConfig,
  CleanupConfig,
} from '../../config/cleanup';

// Test workspace base directory
const TEST_WORKSPACE_BASE = `/tmp/claude-workspaces/test-cleanup-${crypto.randomUUID().slice(0, 8)}`;

// Mock database pool
class MockPool {
  private mockData: {
    sessions: any[];
  };

  constructor() {
    this.mockData = {
      sessions: [],
    };
  }

  async query(text: string, values?: any[]): Promise<any> {
    // Mock SELECT sessions for cleanup
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('status IN')) {
      return { rows: this.mockData.sessions.filter(s =>
        ['completed', 'error', 'stale'].includes(s.status)
      )};
    }

    // Mock SELECT session by ID
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('WHERE id')) {
      const session = this.mockData.sessions.find(s => s.id === values?.[0]);
      return { rows: session ? [session] : [] };
    }

    // Mock DELETE session
    if (text.includes('DELETE FROM sessions')) {
      const idx = this.mockData.sessions.findIndex(s => s.id === values?.[0]);
      if (idx !== -1) {
        this.mockData.sessions.splice(idx, 1);
        return { rows: [{ id: values?.[0] }] };
      }
      return { rows: [] };
    }

    // Mock DELETE session_messages/command_logs
    if (text.includes('DELETE FROM session_messages') || text.includes('DELETE FROM command_logs')) {
      return { rows: [] };
    }

    // Mock UPDATE session
    if (text.includes('UPDATE sessions')) {
      return { rows: [{ id: values?.[values.length - 1] }] };
    }

    // Mock SELECT status counts
    if (text.includes('SELECT status, COUNT(*)')) {
      return { rows: [] };
    }

    return { rows: [] };
  }

  // Test helpers
  addSession(session: any): void {
    this.mockData.sessions.push(session);
  }

  clearSessions(): void {
    this.mockData.sessions = [];
  }

  getSessions(): any[] {
    return this.mockData.sessions;
  }
}

describe('Cleanup Configuration', () => {
  beforeEach(() => {
    // Reset config singleton
    resetCleanupConfig();

    // Clear environment variables
    delete process.env.ARCHIVE_WORKSPACES;
    delete process.env.ARCHIVE_DIR;
    delete process.env.MAX_WORKSPACES;
    delete process.env.MIN_DISK_SPACE_GB;
    delete process.env.CLEANUP_INTERVAL_HOURS;
    delete process.env.CLEANUP_CRON_EXPRESSION;
    delete process.env.CLEANUP_DELETE_SESSIONS;
    delete process.env.ENABLE_AUTO_CLEANUP;
    delete process.env.ENABLE_SCHEDULED_CLEANUP;
  });

  it('should load default configuration values', () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;

    const config = loadCleanupConfig();

    expect(config.workspaceBase).toBe(TEST_WORKSPACE_BASE);
    expect(config.archiveWorkspaces).toBe(false);
    expect(config.maxWorkspaces).toBe(100);
    expect(config.minDiskSpaceGB).toBe(5);
    expect(config.cleanupIntervalHours).toBe(24);
    expect(config.cleanupDeleteSessions).toBe(false);
    expect(config.enableAutoCleanup).toBe(true);
    expect(config.enableScheduledCleanup).toBe(true);
  });

  it('should load configuration from environment variables', () => {
    process.env.WORKSPACE_BASE = '/custom/workspace';
    process.env.ARCHIVE_WORKSPACES = 'true';
    process.env.ARCHIVE_DIR = '/custom/archive';
    process.env.MAX_WORKSPACES = '50';
    process.env.MIN_DISK_SPACE_GB = '10';
    process.env.CLEANUP_INTERVAL_HOURS = '12';
    process.env.CLEANUP_DELETE_SESSIONS = 'true';
    process.env.ENABLE_AUTO_CLEANUP = 'false';
    process.env.ENABLE_SCHEDULED_CLEANUP = 'false';

    const config = loadCleanupConfig();

    expect(config.workspaceBase).toBe('/custom/workspace');
    expect(config.archiveWorkspaces).toBe(true);
    expect(config.archiveDir).toBe('/custom/archive');
    expect(config.maxWorkspaces).toBe(50);
    expect(config.minDiskSpaceGB).toBe(10);
    expect(config.cleanupIntervalHours).toBe(12);
    expect(config.cleanupDeleteSessions).toBe(true);
    expect(config.enableAutoCleanup).toBe(false);
    expect(config.enableScheduledCleanup).toBe(false);
  });

  it('should validate configuration and return false for missing workspace base', () => {
    delete process.env.WORKSPACE_BASE;

    const config = loadCleanupConfig();
    config.workspaceBase = '';

    const isValid = validateCleanupConfig(config);

    expect(isValid).toBe(false);
  });

  it('should handle invalid integer values gracefully', () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;
    process.env.MAX_WORKSPACES = 'not-a-number';
    process.env.MIN_DISK_SPACE_GB = '-5'; // Below min

    const config = loadCleanupConfig();

    // Should fall back to defaults
    expect(config.maxWorkspaces).toBe(100);
    expect(config.minDiskSpaceGB).toBe(5);
  });

  it('should handle boolean parsing correctly', () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;

    // Test various boolean formats
    process.env.ARCHIVE_WORKSPACES = '1';
    let config = loadCleanupConfig();
    expect(config.archiveWorkspaces).toBe(true);

    resetCleanupConfig();
    process.env.ARCHIVE_WORKSPACES = 'TRUE';
    config = loadCleanupConfig();
    expect(config.archiveWorkspaces).toBe(true);

    resetCleanupConfig();
    process.env.ARCHIVE_WORKSPACES = 'false';
    config = loadCleanupConfig();
    expect(config.archiveWorkspaces).toBe(false);

    resetCleanupConfig();
    process.env.ARCHIVE_WORKSPACES = '0';
    config = loadCleanupConfig();
    expect(config.archiveWorkspaces).toBe(false);
  });
});

describe('WorkspaceManager Quota Checks', () => {
  let workspaceManager: WorkspaceManager;
  let createdWorkspaces: string[] = [];

  beforeAll(async () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;
    resetCleanupConfig();

    // Create test workspace base directory
    if (!fsSync.existsSync(TEST_WORKSPACE_BASE)) {
      await fs.mkdir(TEST_WORKSPACE_BASE, { recursive: true, mode: 0o750 });
    }

    workspaceManager = new WorkspaceManager(TEST_WORKSPACE_BASE);
  });

  afterEach(async () => {
    // Clean up created workspaces
    for (const workspace of createdWorkspaces) {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    createdWorkspaces = [];
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_WORKSPACE_BASE, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should check disk space', async () => {
    const diskInfo = await workspaceManager.checkDiskSpace('test-request');

    expect(diskInfo).toHaveProperty('availableGB');
    expect(diskInfo).toHaveProperty('totalGB');
    expect(diskInfo).toHaveProperty('usedGB');
    expect(diskInfo).toHaveProperty('usagePercent');
    expect(typeof diskInfo.availableGB).toBe('number');
    expect(diskInfo.availableGB).toBeGreaterThan(0);
  });

  it('should count workspaces', async () => {
    // Create some test workspaces
    const ws1 = path.join(TEST_WORKSPACE_BASE, 'gh-test-1');
    const ws2 = path.join(TEST_WORKSPACE_BASE, 'wt-test-2');
    const inClaudeWorkspaces = path.join(TEST_WORKSPACE_BASE, 'other-dir');

    await fs.mkdir(ws1, { recursive: true });
    await fs.mkdir(ws2, { recursive: true });
    await fs.mkdir(inClaudeWorkspaces, { recursive: true });

    createdWorkspaces.push(ws1, ws2, inClaudeWorkspaces);

    const quotaInfo = await workspaceManager.countWorkspaces('test-request');

    // Counts: gh- prefixed, wt- prefixed, and dirs within claude-workspaces path
    expect(quotaInfo.count).toBe(3);
    expect(quotaInfo.quota).toBeGreaterThan(0);
    expect(quotaInfo.exceeded).toBe(false);
  });

  it('should return 0 count when directory is empty', async () => {
    const quotaInfo = await workspaceManager.countWorkspaces('test-request');

    expect(quotaInfo.count).toBe(0);
    expect(quotaInfo.exceeded).toBe(false);
  });

  it('should return getBaseDir correctly', () => {
    const baseDir = workspaceManager.getBaseDir();
    expect(baseDir).toBe(TEST_WORKSPACE_BASE);
  });
});

describe('WorkspaceManager Archival', () => {
  let workspaceManager: WorkspaceManager;
  let archiveDir: string;

  beforeAll(async () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;
    archiveDir = path.join(TEST_WORKSPACE_BASE, 'archives');
    process.env.ARCHIVE_WORKSPACES = 'true';
    process.env.ARCHIVE_DIR = archiveDir;
    resetCleanupConfig();

    // Create test directories
    if (!fsSync.existsSync(TEST_WORKSPACE_BASE)) {
      await fs.mkdir(TEST_WORKSPACE_BASE, { recursive: true, mode: 0o750 });
    }

    workspaceManager = new WorkspaceManager(TEST_WORKSPACE_BASE);
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_WORKSPACE_BASE, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    delete process.env.ARCHIVE_WORKSPACES;
    delete process.env.ARCHIVE_DIR;
    resetCleanupConfig();
  });

  it('should archive workspace before cleanup when enabled', async () => {
    // Create a test workspace
    const testWorkspace = path.join(TEST_WORKSPACE_BASE, 'gh-archive-test');
    await fs.mkdir(testWorkspace, { recursive: true });
    await fs.writeFile(path.join(testWorkspace, 'test.txt'), 'test content');

    // Archive the workspace
    const archivePath = await workspaceManager.archiveWorkspace(testWorkspace, 'test-request');

    expect(archivePath).not.toBeNull();
    expect(archivePath).toContain('.tar.gz');

    // Verify archive was created
    if (archivePath) {
      const archiveExists = fsSync.existsSync(archivePath);
      expect(archiveExists).toBe(true);

      // Clean up
      await fs.rm(archivePath, { force: true });
    }

    await fs.rm(testWorkspace, { recursive: true, force: true });
  });

  it('should return null when archiving is disabled', async () => {
    process.env.ARCHIVE_WORKSPACES = 'false';
    resetCleanupConfig();

    const testWorkspace = path.join(TEST_WORKSPACE_BASE, 'gh-no-archive-test');
    await fs.mkdir(testWorkspace, { recursive: true });

    const localManager = new WorkspaceManager(TEST_WORKSPACE_BASE);
    const archivePath = await localManager.archiveWorkspace(testWorkspace, 'test-request');

    expect(archivePath).toBeNull();

    await fs.rm(testWorkspace, { recursive: true, force: true });

    // Restore
    process.env.ARCHIVE_WORKSPACES = 'true';
    resetCleanupConfig();
  });
});

describe('CleanupJob', () => {
  let mockDb: MockPool;
  let workspaceManager: WorkspaceManager;
  let cleanupJob: CleanupJob;

  beforeAll(async () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;
    process.env.ENABLE_SCHEDULED_CLEANUP = 'false'; // Don't auto-start
    process.env.CLEANUP_DELETE_SESSIONS = 'true';
    resetCleanupConfig();

    // Create test workspace base directory
    if (!fsSync.existsSync(TEST_WORKSPACE_BASE)) {
      await fs.mkdir(TEST_WORKSPACE_BASE, { recursive: true, mode: 0o750 });
    }

    workspaceManager = new WorkspaceManager(TEST_WORKSPACE_BASE);
  });

  beforeEach(() => {
    mockDb = new MockPool();
    cleanupJob = new CleanupJob(mockDb as unknown as Pool, workspaceManager);
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_WORKSPACE_BASE, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    delete process.env.ENABLE_SCHEDULED_CLEANUP;
    delete process.env.CLEANUP_DELETE_SESSIONS;
    resetCleanupConfig();
  });

  it('should run cleanup and process sessions', async () => {
    // Create a test workspace
    const testWorkspace = path.join(TEST_WORKSPACE_BASE, 'gh-cleanup-job-test');
    await fs.mkdir(testWorkspace, { recursive: true });

    // Add a session to cleanup
    mockDb.addSession({
      id: 'test-session-1',
      project_path: testWorkspace,
      status: 'completed',
      updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48 hours ago
    });

    const stats = await cleanupJob.runCleanup();

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.workspacesDeleted).toBe(1);
    expect(stats.errors).toBe(0);
    expect(stats.lastRun).not.toBeNull();
  });

  it('should skip E2B sandbox workspaces', async () => {
    mockDb.addSession({
      id: 'test-session-e2b',
      project_path: 'e2b://sandbox-123',
      status: 'completed',
      updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    const stats = await cleanupJob.runCleanup();

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.workspacesDeleted).toBe(0); // No workspace deleted for E2B
    expect(stats.sessionsDeleted).toBe(1); // Session record should still be deleted
  });

  it('should handle missing workspaces gracefully', async () => {
    mockDb.addSession({
      id: 'test-session-missing',
      project_path: path.join(TEST_WORKSPACE_BASE, 'gh-nonexistent-workspace'),
      status: 'error',
      updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    const stats = await cleanupJob.runCleanup();

    // Should not count as error since ENOENT is expected
    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it('should not run if already running', async () => {
    // Simulate lock being held by setting lockPromise
    (cleanupJob as any).lockPromise = new Promise(() => {});

    const stats = await cleanupJob.runCleanup();

    // Should return existing stats without processing
    expect(stats.sessionsProcessed).toBe(0);

    // Clean up the mock lock
    (cleanupJob as any).lockPromise = null;
  });

  it('should report cleanup stats correctly', () => {
    const stats = cleanupJob.getStats();

    expect(stats).toHaveProperty('sessionsProcessed');
    expect(stats).toHaveProperty('workspacesDeleted');
    expect(stats).toHaveProperty('sessionsDeleted');
    expect(stats).toHaveProperty('sessionsMarkedCleaned');
    expect(stats).toHaveProperty('errors');
    expect(stats).toHaveProperty('durationMs');
    expect(stats).toHaveProperty('lastRun');
  });

  it('should track running state correctly', () => {
    expect(cleanupJob.isCleanupRunning()).toBe(false);
  });
});

describe('Cleanup Job Start/Stop', () => {
  let mockDb: MockPool;
  let cleanupJob: CleanupJob;

  beforeAll(async () => {
    process.env.WORKSPACE_BASE = TEST_WORKSPACE_BASE;
    process.env.ENABLE_SCHEDULED_CLEANUP = 'true';
    process.env.CLEANUP_CRON_EXPRESSION = '0 * * * *';
    resetCleanupConfig();

    // Create test workspace base directory for start/stop tests
    if (!fsSync.existsSync(TEST_WORKSPACE_BASE)) {
      await fs.mkdir(TEST_WORKSPACE_BASE, { recursive: true, mode: 0o750 });
    }
  });

  beforeEach(() => {
    mockDb = new MockPool();
  });

  afterAll(async () => {
    delete process.env.ENABLE_SCHEDULED_CLEANUP;
    delete process.env.CLEANUP_CRON_EXPRESSION;
    resetCleanupConfig();

    // Clean up test directory
    try {
      await fs.rm(TEST_WORKSPACE_BASE, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should start and stop cleanup job', () => {
    cleanupJob = new CleanupJob(mockDb as unknown as Pool);

    cleanupJob.start();
    expect((cleanupJob as any).task).not.toBeNull();

    cleanupJob.stop();
    expect((cleanupJob as any).task).toBeNull();
  });

  it('should not start twice', () => {
    cleanupJob = new CleanupJob(mockDb as unknown as Pool);

    cleanupJob.start();
    const firstTask = (cleanupJob as any).task;

    cleanupJob.start(); // Second start
    const secondTask = (cleanupJob as any).task;

    expect(firstTask).toBe(secondTask); // Same task

    cleanupJob.stop();
  });

  it('should not start when disabled', () => {
    process.env.ENABLE_SCHEDULED_CLEANUP = 'false';
    resetCleanupConfig();

    cleanupJob = new CleanupJob(mockDb as unknown as Pool);
    cleanupJob.start();

    expect((cleanupJob as any).task).toBeNull();

    process.env.ENABLE_SCHEDULED_CLEANUP = 'true';
    resetCleanupConfig();
  });
});
