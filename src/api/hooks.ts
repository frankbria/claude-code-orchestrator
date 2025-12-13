// src/api/hooks.ts
import express from 'express';
import { Pool } from 'pg';
import { createLogger } from '../utils/logger';
import { validate as uuidValidate } from 'uuid';

const logger = createLogger('hooks');

/**
 * Validate that a string is a valid UUID v4
 */
function isValidUuid(str: string | undefined): str is string {
  if (!str) return false;
  return uuidValidate(str);
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

export function createHookRouter(db: Pool) {
  const router = express.Router();

  // Receives POST from Claude Code postToolUse hook
  router.post('/tool-complete', async (req, res) => {
    try {
      const { eventId, session, tool, input, result, durationMs } = req.body;

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

      // Insert the new event
      await db.query(
        `INSERT INTO command_logs (
          session_id, tool, input, result, status, duration_ms, timestamp,
          event_id, delivery_status, delivery_attempts, last_delivery_attempt
        )
        VALUES ($1, $2, $3, $4, 'completed', $5, NOW(), $6, 'delivered', 1, NOW())`,
        [
          session,
          tool,
          input ? JSON.stringify(input) : null,
          result,
          durationMs || null,
          eventId || null
        ]
      );

      // Update session's last activity
      await db.query(
        `UPDATE sessions SET updated_at = NOW() WHERE claude_session_id = $1`,
        [session]
      );

      logger.info('Tool complete event recorded', {
        eventId,
        session,
        tool,
        durationMs
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
      const { eventId, session, message } = req.body;

      // Validate eventId format if provided
      if (eventId && !isValidUuid(eventId)) {
        logger.warn('Invalid eventId format for notification', { eventId, session });
        res.status(400).json({
          error: 'Invalid eventId format',
          code: 'INVALID_EVENT_ID'
        });
        return;
      }

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

      // Insert the notification
      await db.query(
        `INSERT INTO session_messages (
          session_id, direction, content, source,
          event_id, delivery_status, delivery_attempts, last_delivery_attempt
        )
        SELECT id, 'system', $2, 'claude-hook', $3, 'delivered', 1, NOW()
        FROM sessions WHERE claude_session_id = $1`,
        [session, message, eventId || null]
      );

      logger.info('Notification event recorded', {
        eventId,
        session,
        messageLength: message?.length
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

  return router;
}
