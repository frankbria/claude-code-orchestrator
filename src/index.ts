// src/index.ts
import express from 'express';
import { Pool } from 'pg';
import { createRouter } from './api/routes';
import { createHookRouter } from './api/hooks';
import { createApiKeyAuth, createHookAuth } from './middleware/auth';
import { startRetryDaemon, stopRetryDaemon, getRetryDaemon } from './services/retryDaemon';
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

// Health check endpoint (no auth required)
app.get('/health', async (req, res) => {
  try {
    // Check database connectivity
    await db.query('SELECT 1');

    // Get retry daemon status
    const daemon = getRetryDaemon();
    const daemonStats = daemon ? await daemon.getStats() : null;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      components: {
        database: 'connected',
        retryDaemon: daemonStats ? {
          running: daemonStats.isRunning,
          pendingRetries: daemonStats.pendingRetries,
          deadLetterCount: daemonStats.deadLetterCount
        } : 'not initialized'
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
});

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop the retry daemon
  stopRetryDaemon();

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
