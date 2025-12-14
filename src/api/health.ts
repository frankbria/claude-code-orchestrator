// src/api/health.ts
import express, { RequestHandler } from 'express';
import { Pool } from 'pg';
import * as fs from 'fs/promises';
import { register } from '../metrics';
import { createLogger } from '../utils/logger';
import { getCleanupConfig } from '../config/cleanup';

const logger = createLogger('health');

interface HealthCheck {
  status: 'ok' | 'warning' | 'critical' | 'error';
  message?: string;
  [key: string]: any;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    database: HealthCheck;
    diskSpace: HealthCheck;
    workspaces: HealthCheck;
    pool: {
      total: number;
      idle: number;
      active: number;
    };
  };
}

/**
 * Check database connectivity
 */
async function checkDatabase(pool: Pool): Promise<HealthCheck> {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - start;
    return {
      status: 'ok',
      latencyMs: latency,
    };
  } catch (error) {
    logger.error('Database health check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Database check failed',
    };
  }
}

/**
 * Check available disk space on workspace volume
 */
async function checkDiskSpace(): Promise<HealthCheck> {
  const cleanupConfig = getCleanupConfig();
  const workspaceBase = cleanupConfig.workspaceBase || '/tmp/claude-workspaces';

  try {
    // Ensure directory exists
    await fs.mkdir(workspaceBase, { recursive: true });

    const stats = await fs.statfs(workspaceBase);
    const availableBytes = stats.bavail * stats.bsize;
    const availableGB = availableBytes / (1024 ** 3);

    if (availableGB < 5) {
      return {
        status: 'critical',
        available: parseFloat(availableGB.toFixed(2)),
        unit: 'GB',
        message: 'Critically low disk space',
      };
    }

    if (availableGB < 20) {
      return {
        status: 'warning',
        available: parseFloat(availableGB.toFixed(2)),
        unit: 'GB',
        message: 'Low disk space',
      };
    }

    return {
      status: 'ok',
      available: parseFloat(availableGB.toFixed(2)),
      unit: 'GB',
    };
  } catch (error) {
    logger.error('Disk space check failed', {
      error: error instanceof Error ? error.message : String(error),
      path: workspaceBase,
    });
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Disk space check failed',
    };
  }
}

/**
 * Count workspaces in the workspace directory
 */
async function countWorkspaces(): Promise<HealthCheck> {
  const cleanupConfig = getCleanupConfig();
  const workspaceBase = cleanupConfig.workspaceBase || '/tmp/claude-workspaces';

  try {
    // Ensure directory exists
    await fs.mkdir(workspaceBase, { recursive: true });

    const entries = await fs.readdir(workspaceBase, { withFileTypes: true });
    const dirCount = entries.filter((e) => e.isDirectory()).length;

    return {
      status: 'ok',
      count: dirCount,
      path: workspaceBase,
    };
  } catch (error) {
    logger.error('Workspace count failed', {
      error: error instanceof Error ? error.message : String(error),
      path: workspaceBase,
    });
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Workspace count failed',
    };
  }
}

/**
 * Count active sessions in the database
 */
async function countActiveSessions(pool: Pool): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM sessions WHERE status = 'active'`
    );
    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    logger.error('Active session count failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Get database pool statistics
 */
function getPoolStats(pool: Pool): { total: number; idle: number; active: number } {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    active: pool.totalCount - pool.idleCount,
  };
}

/**
 * Options for creating health router
 */
export interface HealthRouterOptions {
  /**
   * Middleware for protecting the /metrics endpoint
   */
  strictAuth?: RequestHandler;
}

/**
 * Create health and metrics router
 */
export function createHealthRouter(pool: Pool, options: HealthRouterOptions = {}) {
  const router = express.Router();
  const { strictAuth } = options;

  /**
   * Comprehensive health check endpoint
   * GET /api/health
   */
  router.get('/health', async (_req, res) => {
    try {
      // Run all health checks in parallel
      const [database, diskSpace, workspaces] = await Promise.all([
        checkDatabase(pool),
        checkDiskSpace(),
        countWorkspaces(),
      ]);

      const poolStats = getPoolStats(pool);

      // Determine overall health status
      const checks = [database, diskSpace, workspaces];
      const hasError = checks.some((c) => c.status === 'error');
      const hasCritical = checks.some((c) => c.status === 'critical');
      const hasWarning = checks.some((c) => c.status === 'warning');

      let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
      if (hasError || hasCritical) {
        overallStatus = 'unhealthy';
      } else if (hasWarning) {
        overallStatus = 'degraded';
      } else {
        overallStatus = 'healthy';
      }

      const response: HealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        checks: {
          database,
          diskSpace,
          workspaces,
          pool: poolStats,
        },
      };

      const statusCode = overallStatus === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('Health check endpoint failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Health check failed',
      });
    }
  });

  /**
   * Prometheus metrics endpoint
   * GET /api/metrics
   */
  const metricsHandler: RequestHandler = async (_req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      const metrics = await register.metrics();
      res.send(metrics);
    } catch (error) {
      logger.error('Metrics endpoint failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).send('Error collecting metrics');
    }
  };

  // Apply strict auth to metrics endpoint if provided
  if (strictAuth) {
    router.get('/metrics', strictAuth, metricsHandler);
  } else {
    router.get('/metrics', metricsHandler);
  }

  return router;
}

// Export helper functions for use in scheduled jobs
export {
  checkDatabase,
  checkDiskSpace,
  countWorkspaces,
  countActiveSessions,
  getPoolStats,
};
