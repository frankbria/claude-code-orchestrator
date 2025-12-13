// src/index.ts
import express from 'express';
import { Pool } from 'pg';
import { createRouter } from './api/routes';
import { createHookRouter } from './api/hooks';
import { createApiKeyAuth, createHookAuth } from './middleware/auth';
import { startRetryDaemon, stopRetryDaemon, getRetryDaemon } from './services/retryDaemon';
import { startCleanupJob, stopCleanupJob, getCleanupJob } from './services/cleanup-job';
import { WorkspaceManager } from './services/workspace';
import { getCleanupConfig, validateCleanupConfig, isTarAvailable } from './config/cleanup';
import { createLogger } from './utils/logger';

// Load environment variables
import 'dotenv/config';

const logger = createLogger('server');

const app = express();
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Create authentication middleware
const apiKeyAuth = createApiKeyAuth(db);
const hookAuth = createHookAuth();

// Initialize workspace manager for health checks
let workspaceManager: WorkspaceManager | null = null;
try {
  const cleanupConfig = getCleanupConfig();
  if (cleanupConfig.workspaceBase) {
    workspaceManager = new WorkspaceManager(cleanupConfig.workspaceBase);
  }
} catch (error) {
  logger.warn('WorkspaceManager not initialized for health checks', {
    error: error instanceof Error ? error.message : String(error),
  });
}

// Health check endpoint (no auth required)
app.get('/health', async (req, res) => {
  try {
    // Check database connectivity
    await db.query('SELECT 1');

    // Get retry daemon status
    const daemon = getRetryDaemon();
    const daemonStats = daemon ? await daemon.getStats() : null;

    // Get cleanup job status
    const cleanupJob = getCleanupJob();
    const cleanupStats = cleanupJob ? cleanupJob.getStats() : null;
    const cleanupConfig = getCleanupConfig();

    // Get disk space and workspace count
    let diskStatus: { availableGB: number; thresholdGB: number; status: string } | null = null;
    let workspaceStatus: { count: number; quota: number; status: string } | null = null;

    if (workspaceManager) {
      try {
        const diskInfo = await workspaceManager.checkDiskSpace('health-check');
        diskStatus = {
          availableGB: diskInfo.availableGB,
          thresholdGB: cleanupConfig.minDiskSpaceGB,
          status: diskInfo.availableGB >= cleanupConfig.minDiskSpaceGB ? 'ok' : 'warning',
        };

        const quotaInfo = await workspaceManager.countWorkspaces('health-check');
        workspaceStatus = {
          count: quotaInfo.count,
          quota: quotaInfo.quota,
          status: quotaInfo.exceeded ? 'warning' : 'ok',
        };
      } catch (error) {
        logger.warn('Failed to get workspace health info', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Determine archival capability status
    const archivalStatus = {
      enabled: cleanupConfig.archiveWorkspaces,
      tarAvailable: isTarAvailable(),
      status: cleanupConfig.archiveWorkspaces
        ? (isTarAvailable() ? 'ok' : 'degraded')
        : 'disabled',
    };

    // Determine overall health status
    const hasWarnings = diskStatus?.status === 'warning' || workspaceStatus?.status === 'warning';
    const overallStatus = hasWarnings ? 'warning' : 'ok';

    res.json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      components: {
        database: 'connected',
        retryDaemon: daemonStats ? {
          running: daemonStats.isRunning,
          pendingRetries: daemonStats.pendingRetries,
          deadLetterCount: daemonStats.deadLetterCount
        } : 'not initialized',
        cleanupJob: cleanupStats ? {
          running: cleanupJob?.isCleanupRunning() || false,
          lastRun: cleanupStats.lastRun,
          sessionsProcessed: cleanupStats.sessionsProcessed,
          workspacesDeleted: cleanupStats.workspacesDeleted,
          errors: cleanupStats.errors,
        } : 'not initialized',
        disk: diskStatus,
        workspaces: workspaceStatus,
        archival: archivalStatus,
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Hook endpoints - use optional shared secret auth (for Claude Code hooks)
// These are mounted BEFORE the authenticated routes to ensure /api/hooks/* is not affected by apiKeyAuth
app.use('/api/hooks', hookAuth, createHookRouter(db));

// All other API routes require API key authentication
app.use('/api', apiKeyAuth, createRouter(db));

const port = process.env.API_PORT || 3001;

// Start the server
const server = app.listen(port, () => {
  logger.info(`Claude Orchestrator API running on :${port}`);

  // Validate and log cleanup configuration
  const cleanupConfig = getCleanupConfig();
  validateCleanupConfig(cleanupConfig);

  // Start the retry daemon if enabled
  const enableRetryDaemon = process.env.ENABLE_RETRY_DAEMON !== 'false';
  if (enableRetryDaemon) {
    try {
      startRetryDaemon();
      logger.info('Retry daemon started');
    } catch (error) {
      logger.error('Failed to start retry daemon', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Continue running the server - retry daemon is not critical for basic operation
    }
  }

  // Start the cleanup job if enabled
  if (cleanupConfig.enableScheduledCleanup) {
    try {
      startCleanupJob(db, workspaceManager || undefined);
      logger.info('Cleanup job started', {
        cronExpression: cleanupConfig.cleanupCronExpression,
        cleanupIntervalHours: cleanupConfig.cleanupIntervalHours,
      });
    } catch (error) {
      logger.error('Failed to start cleanup job', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Continue running the server - cleanup job is not critical for basic operation
    }
  } else {
    logger.info('Scheduled cleanup job is disabled');
  }
});

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop the retry daemon
  stopRetryDaemon();

  // Stop the cleanup job
  stopCleanupJob();

  // Close the server
  server.close(() => {
    logger.info('HTTP server closed');

    // Close database pool
    db.end().then(() => {
      logger.info('Database pool closed');
      process.exit(0);
    }).catch((err) => {
      logger.error('Error closing database pool', { error: err.message });
      process.exit(1);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
