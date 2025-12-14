// src/index.ts
import express from 'express';
import { Pool } from 'pg';
import cron from 'node-cron';
import * as fs from 'fs/promises';
import { createRouter } from './api/routes';
import { createHookRouter } from './api/hooks';
import { createHealthRouter, countActiveSessions } from './api/health';
import { createApiKeyAuth, createHookAuth, createStrictHookAuth, validateProductionSecrets, isProduction } from './middleware/auth';
import { metricsMiddleware } from './middleware/metrics';
import { startRetryDaemon, stopRetryDaemon, getRetryDaemon } from './services/retryDaemon';
import { startCleanupJob, stopCleanupJob, getCleanupJob } from './services/cleanup-job';
import { WorkspaceManager } from './services/workspace';
import { getCleanupConfig, validateCleanupConfig, isTarAvailable } from './config/cleanup';
import { createLogger } from './utils/logger';
import {
  sessionsActive,
  diskSpaceAvailableBytes,
  dbConnectionsActive,
  dbConnectionsIdle,
  dbConnectionsTotal,
  workspacesCount,
  retryDaemonPending,
  retryDaemonDeadLetter,
} from './metrics';

// Load environment variables
import 'dotenv/config';

const logger = createLogger('server');

const app = express();
app.use(express.json());

// Add metrics middleware early to capture all request latencies
app.use(metricsMiddleware);

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Validate production secrets before proceeding
const secretsValidation = validateProductionSecrets();
for (const warning of secretsValidation.warnings) {
  logger.warn(warning);
}
if (!secretsValidation.valid) {
  for (const error of secretsValidation.errors) {
    logger.error(error);
  }
  if (isProduction()) {
    logger.error('Refusing to start in production with missing required secrets');
    process.exit(1);
  }
}

// Create authentication middleware
const apiKeyAuth = createApiKeyAuth(db);
const hookAuth = createHookAuth();
const strictHookAuth = createStrictHookAuth();

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
// The strictAuth middleware is used for sensitive endpoints like /metrics that expose operational data
app.use('/api/hooks', hookAuth, createHookRouter(db, { strictAuth: strictHookAuth }));

// Health and Prometheus metrics endpoints (protected by strict auth for /metrics)
app.use('/api', createHealthRouter(db, { strictAuth: strictHookAuth }));

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

  // Start the metrics collection cron job (every minute)
  startMetricsCollection();
});

// Scheduled metrics collection task
let metricsTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Update Prometheus gauge metrics with current system state.
 * Called every minute by the cron job.
 */
async function updateMetrics(): Promise<void> {
  try {
    // Update active sessions count
    const activeCount = await countActiveSessions(db);
    sessionsActive.set(activeCount);

    // Update database pool metrics
    dbConnectionsTotal.set(db.totalCount);
    dbConnectionsIdle.set(db.idleCount);
    dbConnectionsActive.set(db.totalCount - db.idleCount);

    // Update disk space metrics
    const cleanupConfig = getCleanupConfig();
    const workspaceBase = cleanupConfig.workspaceBase || '/tmp/claude-workspaces';
    try {
      await fs.mkdir(workspaceBase, { recursive: true });
      const stats = await fs.statfs(workspaceBase);
      const availableBytes = stats.bavail * stats.bsize;
      diskSpaceAvailableBytes.set(availableBytes);

      // Count workspaces
      const entries = await fs.readdir(workspaceBase, { withFileTypes: true });
      const dirCount = entries.filter((e) => e.isDirectory()).length;
      workspacesCount.set(dirCount);
    } catch (error) {
      logger.warn('Failed to collect disk metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Update retry daemon metrics
    const daemon = getRetryDaemon();
    if (daemon) {
      try {
        const daemonStats = await daemon.getStats();
        retryDaemonPending.set(daemonStats.pendingRetries);
        retryDaemonDeadLetter.set(daemonStats.deadLetterCount);
      } catch (error) {
        logger.warn('Failed to collect retry daemon metrics', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.error('Failed to update metrics', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start the metrics collection cron job.
 */
function startMetricsCollection(): void {
  // Run immediately on startup
  updateMetrics().catch((err) => {
    logger.error('Initial metrics collection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Schedule to run every minute
  metricsTask = cron.schedule('* * * * *', async () => {
    await updateMetrics();
  });

  logger.info('Metrics collection started (every minute)');
}

/**
 * Stop the metrics collection cron job.
 */
function stopMetricsCollection(): void {
  if (metricsTask) {
    metricsTask.stop();
    metricsTask = null;
    logger.info('Metrics collection stopped');
  }
}

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop the metrics collection
  stopMetricsCollection();

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
