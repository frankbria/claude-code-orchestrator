// src/api/hooks.ts
import express, { RequestHandler } from 'express';
import { Pool } from 'pg';
import { createLogger } from '../utils/logger';
import { validate as uuidValidate } from 'uuid';
import {
  getSessionById,
  touchSessionWithVersion,
} from '../db/queries';
import { withOptimisticLockRetry, retryMetrics } from '../db/retry';
import { scrubSecrets, scrubObjectSecrets, logScrubbedSecrets, isScrubbingEnabled } from '../services/secretScrubber';
import { hooksReceivedTotal, hookDeliveryLatency } from '../metrics';

/**
 * Options for configuring the hook router
 */
export interface HookRouterOptions {
  /**
   * Middleware to apply to sensitive endpoints (like /metrics) that require
   * stricter authentication. If not provided, these endpoints will be
   * protected by the same auth as other hook endpoints.
   */
  strictAuth?: RequestHandler;
}

const logger = createLogger('hooks');

/**
 * Validate that a string is a valid UUID v4
 */
function isValidUuid(str: string | undefined): str is string {
  if (!str) return false;
  return uuidValidate(str);
}

/**
 * Parse and validate a timestamp from client input.
 * Accepts ISO8601 strings or Unix epoch (seconds or milliseconds).
 * Returns a valid Date object or null if invalid/missing.
 */
function parseTimestamp(value: unknown): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  // Handle numeric timestamps (epoch)
  if (typeof value === 'number') {
    // Detect if seconds or milliseconds (timestamps before year 2001 in ms would be > 10^12)
    const ms = value > 10000000000 ? value : value * 1000;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) {
      return date;
    }
    return null;
  }

  // Handle string timestamps
  if (typeof value === 'string') {
    // Try parsing as ISO8601
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      // Sanity check: reject dates too far in past or future
      const now = Date.now();
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      if (date.getTime() > now - oneYearMs && date.getTime() < now + oneYearMs) {
        return date;
      }
      logger.warn('Timestamp outside acceptable range', { value, parsed: date.toISOString() });
      return null;
    }

    // Try parsing as numeric string (epoch)
    const numValue = Number(value);
    if (!isNaN(numValue)) {
      return parseTimestamp(numValue);
    }
  }

  logger.warn('Invalid timestamp format', { value, type: typeof value });
  return null;
}

/**
 * Check if an event with the given event_id already exists
 */
async function eventExists(
  db: Pool,
  table: 'command_logs' | 'session_messages',
  eventId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM ${table} WHERE event_id = $1 LIMIT 1`,
    [eventId]
  );
  return result.rows.length > 0;
}

/**
 * Resolved session information including version for optimistic locking
 */
interface ResolvedSession {
  id: string;
  claudeSessionId: string | null;
  version: number;
}

/**
 * Resolve a session identifier to its UUID (sessions.id).
 * The incoming session value could be either:
 * - A UUID (sessions.id) - used directly
 * - A claude_session_id string - looked up to get the UUID
 * Returns { id, claudeSessionId, version } or null if not found.
 */
async function resolveSession(
  db: Pool,
  sessionIdentifier: string | undefined
): Promise<ResolvedSession | null> {
  if (!sessionIdentifier) {
    return null;
  }

  // Check if it's already a valid UUID (could be sessions.id)
  if (isValidUuid(sessionIdentifier)) {
    // Try to find by id first
    const byId = await db.query(
      `SELECT id, claude_session_id, version FROM sessions WHERE id = $1`,
      [sessionIdentifier]
    );
    if (byId.rows.length > 0) {
      return {
        id: byId.rows[0].id,
        claudeSessionId: byId.rows[0].claude_session_id,
        version: byId.rows[0].version
      };
    }
  }

  // Try to find by claude_session_id
  const byClaudeId = await db.query(
    `SELECT id, claude_session_id, version FROM sessions WHERE claude_session_id = $1`,
    [sessionIdentifier]
  );
  if (byClaudeId.rows.length > 0) {
    return {
      id: byClaudeId.rows[0].id,
      claudeSessionId: byClaudeId.rows[0].claude_session_id,
      version: byClaudeId.rows[0].version
    };
  }

  return null;
}

export function createHookRouter(db: Pool, options: HookRouterOptions = {}) {
  const router = express.Router();
  const { strictAuth } = options;

  // Receives POST from Claude Code postToolUse hook
  router.post('/tool-complete', async (req, res) => {
    try {
      const { eventId, eventType, session, tool, input, result, durationMs, timestamp } = req.body;

      // Scrub secrets from input and result before any processing
      let scrubbedResult = result;
      let scrubbedInput = input;
      const allFoundSecrets: string[] = [];

      if (isScrubbingEnabled()) {
        // Scrub result (always a string or null)
        if (result !== null && result !== undefined) {
          const resultScrub = scrubSecrets(String(result));
          scrubbedResult = resultScrub.scrubbed;
          allFoundSecrets.push(...resultScrub.foundSecrets);
        }

        // Scrub input (can be string or object)
        if (input !== null && input !== undefined) {
          if (typeof input === 'string') {
            const inputScrub = scrubSecrets(input);
            scrubbedInput = inputScrub.scrubbed;
            allFoundSecrets.push(...inputScrub.foundSecrets);
          } else if (typeof input === 'object') {
            const inputScrub = scrubObjectSecrets(input);
            scrubbedInput = inputScrub.scrubbed;
            allFoundSecrets.push(...inputScrub.foundSecrets);
          }
        }

        // Log scrubbed secrets for audit trail
        if (allFoundSecrets.length > 0) {
          logScrubbedSecrets([...new Set(allFoundSecrets)], {
            sessionId: session,
            tool,
            eventId,
          });
        }
      }

      // Validate session is provided
      if (!session) {
        logger.warn('Tool complete hook called without session', { eventId, tool });
        res.status(400).json({
          error: 'Missing session identifier',
          code: 'MISSING_SESSION'
        });
        return;
      }

      // Validate eventId (required for idempotency)
      if (!eventId) {
        logger.warn('Tool complete hook called without eventId', { session, tool });
        // For backwards compatibility, generate one if not provided
        // But log a warning - new hooks should always provide eventId
      }

      // Validate eventId format if provided
      if (eventId && !isValidUuid(eventId)) {
        logger.warn('Invalid eventId format', { eventId, session, tool });
        res.status(400).json({
          error: 'Invalid eventId format',
          code: 'INVALID_EVENT_ID'
        });
        return;
      }

      // Resolve session identifier to UUID
      const resolvedSession = await resolveSession(db, session);
      if (!resolvedSession) {
        // Return 200 to acknowledge and prevent retry loops, but log warning
        logger.warn('Tool complete received for unknown session', {
          eventId,
          session,
          tool
        });
        res.status(200).json({
          status: 'session_not_found',
          acknowledged: true,
          message: 'No session found with the provided identifier - event acknowledged but not stored',
          eventId
        });
        return;
      }

      // Parse client-provided timestamp, fall back to current time
      const parsedTimestamp = parseTimestamp(timestamp);
      const eventTimestamp = parsedTimestamp ? parsedTimestamp.toISOString() : new Date().toISOString();

      // Check for duplicate event (idempotency)
      if (eventId) {
        const isDuplicate = await eventExists(db, 'command_logs', eventId);
        if (isDuplicate) {
          logger.info('Duplicate event detected, acknowledging', {
            eventId,
            session,
            tool
          });
          res.status(200).json({
            status: 'duplicate',
            message: 'Event already processed',
            eventId
          });
          return;
        }
      }

      // Insert the new event using resolved session UUID
      // Note: Using scrubbed values to prevent secret exposure in database
      await db.query(
        `INSERT INTO command_logs (
          session_id, tool, input, result, status, duration_ms, timestamp,
          event_id, delivery_status, delivery_attempts, last_delivery_attempt
        )
        VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, 'delivered', 1, NOW())`,
        [
          resolvedSession.id,
          tool,
          scrubbedInput !== null && scrubbedInput !== undefined ? JSON.stringify(scrubbedInput) : null,
          scrubbedResult !== null && scrubbedResult !== undefined ? scrubbedResult : null,
          durationMs !== null && durationMs !== undefined ? durationMs : null,
          eventTimestamp,
          eventId !== null && eventId !== undefined ? eventId : null
        ]
      );

      // Update session's last activity with optimistic locking
      // Use retry logic to handle concurrent hook deliveries
      const updateResult = await withOptimisticLockRetry(
        async () => {
          // Re-fetch session to get latest version
          const currentSession = await getSessionById(db, resolvedSession.id);
          if (!currentSession) {
            throw new Error(`Session disappeared: ${resolvedSession.id}`);
          }
          return touchSessionWithVersion(db, resolvedSession.id, currentSession.version);
        },
        { maxRetries: 3, baseDelayMs: 100 }
      );

      // Track retry metrics for monitoring
      retryMetrics.record(updateResult);

      if (!updateResult.success) {
        // Log but don't fail the request - the command log was already inserted
        logger.warn('Failed to update session timestamp after retries', {
          eventId,
          sessionId: resolvedSession.id,
          attempts: updateResult.attempts,
          retriesExhausted: updateResult.retriesExhausted,
          error: updateResult.error?.message
        });
      }

      // Record Prometheus metrics for successful hook delivery
      hooksReceivedTotal.labels({ tool: tool || 'unknown', status: 'completed' }).inc();

      // Track delivery latency if client timestamp was provided
      if (parsedTimestamp) {
        const deliveryLatency = Date.now() - parsedTimestamp.getTime();
        if (deliveryLatency >= 0 && deliveryLatency < 60000) {
          // Only record reasonable latencies (0-60s)
          hookDeliveryLatency.labels({ tool: tool || 'unknown' }).observe(deliveryLatency);
        }
      }

      logger.info('Tool complete event recorded', {
        eventId,
        eventType,
        sessionId: resolvedSession.id,
        claudeSessionId: resolvedSession.claudeSessionId,
        tool,
        durationMs,
        timestamp: eventTimestamp,
        clientTimestamp: !!parsedTimestamp,
        sessionUpdateAttempts: updateResult.attempts,
        sessionUpdateSuccess: updateResult.success,
        secretsScrubbed: allFoundSecrets.length > 0
      });

      res.status(200).json({
        status: 'delivered',
        eventId
      });
    } catch (error) {
      // Handle unique constraint violation (race condition on duplicate)
      if ((error as any).code === '23505' && (error as any).constraint?.includes('event_id')) {
        logger.info('Duplicate event detected via constraint', {
          eventId: req.body.eventId
        });
        res.status(200).json({
          status: 'duplicate',
          message: 'Event already processed',
          eventId: req.body.eventId
        });
        return;
      }

      // Record error metric
      hooksReceivedTotal.labels({ tool: req.body.tool || 'unknown', status: 'error' }).inc();

      logger.error('Failed to process tool-complete hook', {
        error: error instanceof Error ? error.message : String(error),
        eventId: req.body.eventId,
        session: req.body.session
      });

      res.status(500).json({
        error: 'Internal server error',
        code: 'HOOK_PROCESSING_ERROR'
      });
    }
  });

  // Receives notifications from Claude Code
  router.post('/notification', async (req, res) => {
    try {
      const { eventId, eventType, session, message, timestamp } = req.body;

      // Scrub secrets from message content before any processing
      let scrubbedMessage = message;
      const allFoundSecrets: string[] = [];

      if (isScrubbingEnabled() && message !== null && message !== undefined) {
        const messageScrub = scrubSecrets(String(message));
        scrubbedMessage = messageScrub.scrubbed;
        allFoundSecrets.push(...messageScrub.foundSecrets);

        // Log scrubbed secrets for audit trail
        if (allFoundSecrets.length > 0) {
          logScrubbedSecrets(allFoundSecrets, {
            sessionId: session,
            eventId,
          });
        }
      }

      // Validate session is provided
      if (!session) {
        logger.warn('Notification hook called without session', { eventId });
        res.status(400).json({
          error: 'Missing session identifier',
          code: 'MISSING_SESSION'
        });
        return;
      }

      // Validate eventId format if provided
      if (eventId && !isValidUuid(eventId)) {
        logger.warn('Invalid eventId format for notification', { eventId, session });
        res.status(400).json({
          error: 'Invalid eventId format',
          code: 'INVALID_EVENT_ID'
        });
        return;
      }

      // Resolve session identifier to UUID
      const resolvedSession = await resolveSession(db, session);
      if (!resolvedSession) {
        // Return 200 to acknowledge and prevent retry loops, but log warning
        logger.warn('Notification received for unknown session', {
          eventId,
          session,
          messageLength: message?.length
        });

        res.status(200).json({
          status: 'session_not_found',
          acknowledged: true,
          message: 'No session found with the provided identifier - event acknowledged but not stored',
          eventId
        });
        return;
      }

      // Parse client-provided timestamp, fall back to current time
      const parsedTimestamp = parseTimestamp(timestamp);
      const eventTimestamp = parsedTimestamp ? parsedTimestamp.toISOString() : new Date().toISOString();

      // Check for duplicate event (idempotency)
      if (eventId) {
        const isDuplicate = await eventExists(db, 'session_messages', eventId);
        if (isDuplicate) {
          logger.info('Duplicate notification detected, acknowledging', {
            eventId,
            session
          });
          res.status(200).json({
            status: 'duplicate',
            message: 'Event already processed',
            eventId
          });
          return;
        }
      }

      // Insert the notification using resolved session UUID
      // Note: Using scrubbed message to prevent secret exposure in database
      await db.query(
        `INSERT INTO session_messages (
          session_id, direction, content, source, created_at,
          event_id, delivery_status, delivery_attempts, last_delivery_attempt
        )
        VALUES ($1, 'system', $2, 'claude-hook', $3, $4, 'delivered', 1, NOW())`,
        [
          resolvedSession.id,
          scrubbedMessage !== null && scrubbedMessage !== undefined ? scrubbedMessage : null,
          eventTimestamp,
          eventId !== null && eventId !== undefined ? eventId : null
        ]
      );

      // Record Prometheus metrics for successful notification delivery
      hooksReceivedTotal.labels({ tool: 'notification', status: 'completed' }).inc();

      // Track delivery latency if client timestamp was provided
      if (parsedTimestamp) {
        const deliveryLatency = Date.now() - parsedTimestamp.getTime();
        if (deliveryLatency >= 0 && deliveryLatency < 60000) {
          // Only record reasonable latencies (0-60s)
          hookDeliveryLatency.labels({ tool: 'notification' }).observe(deliveryLatency);
        }
      }

      logger.info('Notification event recorded', {
        eventId,
        eventType,
        sessionId: resolvedSession.id,
        claudeSessionId: resolvedSession.claudeSessionId,
        messageLength: scrubbedMessage?.length,
        timestamp: eventTimestamp,
        clientTimestamp: !!parsedTimestamp,
        secretsScrubbed: allFoundSecrets.length > 0,
        secretTypes: allFoundSecrets.length > 0 ? [...new Set(allFoundSecrets)] : undefined,
        secretCount: allFoundSecrets.length > 0 ? allFoundSecrets.length : undefined
      });

      res.status(200).json({
        status: 'delivered',
        eventId
      });
    } catch (error) {
      // Handle unique constraint violation (race condition on duplicate)
      if ((error as any).code === '23505' && (error as any).constraint?.includes('event_id')) {
        logger.info('Duplicate notification detected via constraint', {
          eventId: req.body.eventId
        });
        res.status(200).json({
          status: 'duplicate',
          message: 'Event already processed',
          eventId: req.body.eventId
        });
        return;
      }

      // Record error metric
      hooksReceivedTotal.labels({ tool: 'notification', status: 'error' }).inc();

      logger.error('Failed to process notification hook', {
        error: error instanceof Error ? error.message : String(error),
        eventId: req.body.eventId,
        session: req.body.session
      });

      res.status(500).json({
        error: 'Internal server error',
        code: 'HOOK_PROCESSING_ERROR'
      });
    }
  });

  // Health check endpoint for hooks subsystem
  router.get('/health', async (_req, res) => {
    try {
      // Check database connectivity
      await db.query('SELECT 1');
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        error: 'Database connection failed',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Metrics endpoint for monitoring retry behavior
  // This endpoint exposes operational data and requires stricter authentication
  // to prevent information leakage in misconfigured environments
  const metricsHandler: RequestHandler = async (_req, res) => {
    const metrics = retryMetrics.getMetrics();
    const denominator = metrics.successfulFirstAttempts + metrics.successfulRetries +
      metrics.failedAfterRetries + metrics.nonRetryableErrors;
    res.json({
      retryMetrics: {
        totalAttempts: metrics.totalAttempts,
        successfulFirstAttempts: metrics.successfulFirstAttempts,
        successfulRetries: metrics.successfulRetries,
        failedAfterRetries: metrics.failedAfterRetries,
        nonRetryableErrors: metrics.nonRetryableErrors,
        // Derived metrics
        successRate: denominator > 0
          ? ((metrics.successfulFirstAttempts + metrics.successfulRetries) / denominator * 100).toFixed(2) + '%'
          : 'N/A',
        retryRate: denominator > 0
          ? ((metrics.successfulRetries + metrics.failedAfterRetries) / denominator * 100).toFixed(2) + '%'
          : 'N/A',
      },
      timestamp: new Date().toISOString()
    });
  };

  // Apply strict auth middleware if provided, otherwise use default route auth
  if (strictAuth) {
    router.get('/metrics', strictAuth, metricsHandler);
  } else {
    router.get('/metrics', metricsHandler);
  }

  return router;
}
