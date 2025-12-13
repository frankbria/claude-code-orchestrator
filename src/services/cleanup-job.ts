/**
 * Scheduled Cleanup Job Service
 *
 * Provides automatic cleanup of orphaned workspaces and stale sessions
 * using node-cron for scheduling. Handles:
 * - Periodic cleanup of completed/error sessions
 * - Workspace directory removal with optional archival
 * - Session record cleanup (deletion or marking as cleaned)
 * - Cleanup statistics logging
 *
 * @module services/cleanup-job
 */

import cron, { ScheduledTask } from 'node-cron';
import { Pool } from 'pg';
import { WorkspaceManager } from './workspace';
import { getCleanupConfig, CleanupConfig } from '../config/cleanup';
import {
  getStaleSessionsForCleanup,
  deleteSession,
  markSessionCleaned,
  getSessionStatusCounts,
  SessionForCleanup,
} from '../db/queries';
import { createLogger } from '../utils/logger';

const logger = createLogger('cleanup-job');

/**
 * Cleanup job statistics
 */
export interface CleanupStats {
  /** Total sessions processed */
  sessionsProcessed: number;
  /** Workspaces successfully deleted */
  workspacesDeleted: number;
  /** Sessions deleted from database */
  sessionsDeleted: number;
  /** Sessions marked as cleaned */
  sessionsMarkedCleaned: number;
  /** Errors encountered during cleanup */
  errors: number;
  /** Duration of cleanup run in milliseconds */
  durationMs: number;
  /** Timestamp of last run */
  lastRun: Date | null;
}

/**
 * CleanupJob class manages the scheduled cleanup of workspaces
 */
export class CleanupJob {
  private task: ScheduledTask | null = null;
  private db: Pool;
  private workspaceManager: WorkspaceManager;
  private config: CleanupConfig;
  private stats: CleanupStats = {
    sessionsProcessed: 0,
    workspacesDeleted: 0,
    sessionsDeleted: 0,
    sessionsMarkedCleaned: 0,
    errors: 0,
    durationMs: 0,
    lastRun: null,
  };

  // Mutex for preventing concurrent cleanup runs
  private lockPromise: Promise<void> | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(db: Pool, workspaceManager?: WorkspaceManager) {
    this.db = db;
    this.config = getCleanupConfig();
    this.workspaceManager = workspaceManager || new WorkspaceManager();
  }

  /**
   * Try to acquire the cleanup lock atomically.
   * Returns true if lock was acquired, false if already held.
   */
  private tryAcquireLock(): boolean {
    if (this.lockPromise !== null) {
      return false;
    }

    // Create a new lock - this is atomic because JS is single-threaded
    // for synchronous operations
    this.lockPromise = new Promise<void>((resolve) => {
      this.releaseLock = resolve;
    });

    return true;
  }

  /**
   * Release the cleanup lock
   */
  private doReleaseLock(): void {
    if (this.releaseLock) {
      this.releaseLock();
    }
    this.lockPromise = null;
    this.releaseLock = null;
  }

  /**
   * Start the scheduled cleanup job
   */
  start(): void {
    if (this.task) {
      logger.warn('Cleanup job already started');
      return;
    }

    if (!this.config.enableScheduledCleanup) {
      logger.info('Scheduled cleanup is disabled');
      return;
    }

    this.task = cron.schedule(this.config.cleanupCronExpression, async () => {
      await this.runCleanup();
    });

    logger.info('Cleanup job started', {
      cronExpression: this.config.cleanupCronExpression,
      cleanupIntervalHours: this.config.cleanupIntervalHours,
      deleteSessionRecords: this.config.cleanupDeleteSessions,
      archiveWorkspaces: this.config.archiveWorkspaces,
    });
  }

  /**
   * Stop the scheduled cleanup job
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Cleanup job stopped');
    }
  }

  /**
   * Check if cleanup job is currently running
   */
  isCleanupRunning(): boolean {
    return this.lockPromise !== null;
  }

  /**
   * Get cleanup statistics
   */
  getStats(): CleanupStats {
    return { ...this.stats };
  }

  /**
   * Run cleanup manually (also called by cron schedule)
   */
  async runCleanup(): Promise<CleanupStats> {
    // Atomically try to acquire the lock
    if (!this.tryAcquireLock()) {
      logger.warn('Cleanup already in progress, skipping');
      return this.stats;
    }

    const startTime = Date.now();

    // Reset stats for this run
    const runStats: CleanupStats = {
      sessionsProcessed: 0,
      workspacesDeleted: 0,
      sessionsDeleted: 0,
      sessionsMarkedCleaned: 0,
      errors: 0,
      durationMs: 0,
      lastRun: new Date(),
    };

    try {
      logger.info('Starting scheduled cleanup', {
        cleanupIntervalHours: this.config.cleanupIntervalHours,
        timestamp: new Date().toISOString(),
      });

      // Get sessions eligible for cleanup
      const sessions = await getStaleSessionsForCleanup(
        this.db,
        this.config.cleanupIntervalHours,
        100 // Process up to 100 sessions per run
      );

      logger.info(`Found ${sessions.length} sessions for cleanup`);

      // Process each session
      for (const session of sessions) {
        runStats.sessionsProcessed++;

        try {
          await this.cleanupSession(session, runStats);
        } catch (error) {
          runStats.errors++;
          logger.error('Failed to cleanup session', {
            sessionId: session.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          });
        }
      }

      runStats.durationMs = Date.now() - startTime;
      this.stats = runStats;

      // Log summary
      logger.info('Cleanup completed', {
        sessionsProcessed: runStats.sessionsProcessed,
        workspacesDeleted: runStats.workspacesDeleted,
        sessionsDeleted: runStats.sessionsDeleted,
        sessionsMarkedCleaned: runStats.sessionsMarkedCleaned,
        errors: runStats.errors,
        durationMs: runStats.durationMs,
        timestamp: new Date().toISOString(),
      });

      // Log session status counts after cleanup
      try {
        const statusCounts = await getSessionStatusCounts(this.db);
        logger.info('Session status counts after cleanup', statusCounts);
      } catch (error) {
        // Non-critical, just log
        logger.warn('Failed to get session status counts', {
          error: (error as Error).message,
        });
      }

    } catch (error) {
      runStats.errors++;
      runStats.durationMs = Date.now() - startTime;
      this.stats = runStats;

      logger.error('Cleanup job failed', {
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    } finally {
      // Always release the lock
      this.doReleaseLock();
    }

    return runStats;
  }

  /**
   * Cleanup a single session
   */
  private async cleanupSession(
    session: SessionForCleanup,
    stats: CleanupStats
  ): Promise<void> {
    const requestId = `cleanup-${session.id}`;

    logger.info('Cleaning up session', {
      sessionId: session.id,
      projectPath: session.project_path,
      status: session.status,
      updatedAt: session.updated_at,
    });

    // Skip E2B sandboxes (no local workspace to clean)
    if (session.project_path.startsWith('e2b://')) {
      logger.info('Skipping E2B sandbox cleanup', {
        sessionId: session.id,
      });
      // Still mark/delete the session record
    } else {
      // Clean up workspace directory
      try {
        await this.workspaceManager.cleanup(session.project_path, requestId);
        stats.workspacesDeleted++;
      } catch (error) {
        // Workspace might already be deleted or never existed
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode !== 'ENOENT') {
          logger.warn('Workspace cleanup failed', {
            sessionId: session.id,
            error: (error as Error).message,
          });
        }
      }
    }

    // Handle session record
    if (this.config.cleanupDeleteSessions) {
      // Delete session record
      const deleted = await deleteSession(this.db, session.id);
      if (deleted) {
        stats.sessionsDeleted++;
        logger.info('Session record deleted', {
          sessionId: session.id,
        });
      }
    } else {
      // Mark session as cleaned (preserve for auditing)
      const marked = await markSessionCleaned(this.db, session.id);
      if (marked) {
        stats.sessionsMarkedCleaned++;
        logger.info('Session marked as cleaned', {
          sessionId: session.id,
        });
      }
    }
  }
}

// Singleton instance
let cleanupJobInstance: CleanupJob | null = null;

/**
 * Start the cleanup job daemon
 *
 * @param db Database pool
 * @param workspaceManager Optional workspace manager instance
 */
export function startCleanupJob(db: Pool, workspaceManager?: WorkspaceManager): CleanupJob {
  if (cleanupJobInstance) {
    logger.warn('Cleanup job already exists, returning existing instance');
    return cleanupJobInstance;
  }

  cleanupJobInstance = new CleanupJob(db, workspaceManager);
  cleanupJobInstance.start();

  return cleanupJobInstance;
}

/**
 * Stop the cleanup job daemon
 */
export function stopCleanupJob(): void {
  if (cleanupJobInstance) {
    cleanupJobInstance.stop();
    cleanupJobInstance = null;
  }
}

/**
 * Get the cleanup job instance
 */
export function getCleanupJob(): CleanupJob | null {
  return cleanupJobInstance;
}

/**
 * Run cleanup manually (useful for testing or on-demand cleanup)
 *
 * If a singleton CleanupJob exists (from startCleanupJob), reuses it to
 * prevent concurrent cleanup runs. Otherwise creates a temporary instance.
 */
export async function runManualCleanup(
  db: Pool,
  workspaceManager?: WorkspaceManager
): Promise<CleanupStats> {
  // Reuse singleton to prevent concurrent cleanup runs
  if (cleanupJobInstance) {
    return cleanupJobInstance.runCleanup();
  }

  // No singleton exists - create temporary instance for one-off cleanup
  const job = new CleanupJob(db, workspaceManager);
  return job.runCleanup();
}
