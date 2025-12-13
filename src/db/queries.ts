// src/db/queries.ts
import { Pool } from 'pg';
import crypto from 'crypto';

// Session types for cleanup operations
export type SessionStatus = 'active' | 'completed' | 'error' | 'stale';

export interface Session {
  id: string;
  project_path: string;
  project_type: string;
  status: SessionStatus;
  claude_session_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SessionForCleanup {
  id: string;
  project_path: string;
  status: SessionStatus;
  updated_at: Date;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  metadata: Record<string, unknown>;
}

// Event delivery status types
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_letter';

export interface EventDeliveryInfo {
  id: string;
  event_id: string;
  delivery_status: DeliveryStatus;
  delivery_attempts: number;
  last_delivery_attempt: Date;
  delivery_error: string | null;
}

export interface FailedDeliveryEntry {
  id: string;
  event_id: string;
  session_id: string;
  tool?: string;
  content?: string;
  delivery_status: DeliveryStatus;
  delivery_attempts: number;
  last_delivery_attempt: Date;
  delivery_error: string | null;
}

/**
 * Generate a secure random API key (64 character hex string)
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate an API key and update last_used_at timestamp
 * Returns the API key record if valid, null otherwise
 */
export async function validateApiKey(
  db: Pool,
  key: string
): Promise<ApiKey | null> {
  const result = await db.query(
    `UPDATE api_keys
     SET last_used_at = NOW()
     WHERE key = $1 AND active = true
     RETURNING id, key, name, active, created_at, last_used_at, metadata`,
    [key]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Create a new API key
 */
export async function createApiKey(
  db: Pool,
  name: string,
  metadata: Record<string, unknown> = {}
): Promise<ApiKey> {
  const key = generateApiKey();

  const result = await db.query(
    `INSERT INTO api_keys (key, name, metadata)
     VALUES ($1, $2, $3)
     RETURNING id, key, name, active, created_at, last_used_at, metadata`,
    [key, name, JSON.stringify(metadata)]
  );

  return result.rows[0];
}

/**
 * List all API keys (without exposing the actual key values)
 */
export async function listApiKeys(db: Pool): Promise<ApiKeyInfo[]> {
  const result = await db.query(
    `SELECT id, name, active, created_at, last_used_at, metadata
     FROM api_keys
     ORDER BY created_at DESC`
  );

  return result.rows;
}

/**
 * Get a single API key by ID (without exposing the actual key value)
 */
export async function getApiKeyById(
  db: Pool,
  id: string
): Promise<ApiKeyInfo | null> {
  const result = await db.query(
    `SELECT id, name, active, created_at, last_used_at, metadata
     FROM api_keys
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Revoke an API key (sets active = false)
 */
export async function revokeApiKey(
  db: Pool,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_keys
     SET active = false
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(
  db: Pool,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM api_keys
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}

// =============================================================================
// Event Delivery Query Helpers
// =============================================================================

/**
 * Check if an event with the given event_id exists in command_logs
 */
export async function checkCommandLogEventExists(
  db: Pool,
  eventId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM command_logs WHERE event_id = $1 LIMIT 1`,
    [eventId]
  );
  return result.rows.length > 0;
}

/**
 * Check if an event with the given event_id exists in session_messages
 */
export async function checkMessageEventExists(
  db: Pool,
  eventId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM session_messages WHERE event_id = $1 LIMIT 1`,
    [eventId]
  );
  return result.rows.length > 0;
}

/**
 * Get failed command log deliveries for retry
 */
export async function getFailedCommandLogDeliveries(
  db: Pool,
  limit: number = 100
): Promise<FailedDeliveryEntry[]> {
  const result = await db.query(
    `SELECT id, event_id, session_id, tool, delivery_status,
            delivery_attempts, last_delivery_attempt, delivery_error
     FROM command_logs
     WHERE delivery_status IN ('pending', 'failed')
     ORDER BY last_delivery_attempt ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Get failed session message deliveries for retry
 */
export async function getFailedMessageDeliveries(
  db: Pool,
  limit: number = 100
): Promise<FailedDeliveryEntry[]> {
  const result = await db.query(
    `SELECT id, event_id, session_id, content, delivery_status,
            delivery_attempts, last_delivery_attempt, delivery_error
     FROM session_messages
     WHERE delivery_status IN ('pending', 'failed')
     ORDER BY last_delivery_attempt ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Update delivery status for a command log entry
 */
export async function updateCommandLogDeliveryStatus(
  db: Pool,
  eventId: string,
  status: DeliveryStatus,
  attempts: number,
  error?: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE command_logs
     SET delivery_status = $2,
         delivery_attempts = $3,
         last_delivery_attempt = NOW(),
         delivery_error = $4
     WHERE event_id = $1
     RETURNING id`,
    [eventId, status, attempts, error || null]
  );
  return result.rows.length > 0;
}

/**
 * Update delivery status for a session message entry
 */
export async function updateMessageDeliveryStatus(
  db: Pool,
  eventId: string,
  status: DeliveryStatus,
  attempts: number,
  error?: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE session_messages
     SET delivery_status = $2,
         delivery_attempts = $3,
         last_delivery_attempt = NOW(),
         delivery_error = $4
     WHERE event_id = $1
     RETURNING id`,
    [eventId, status, attempts, error || null]
  );
  return result.rows.length > 0;
}

/**
 * Mark a command log event as delivered
 */
export async function markCommandLogDelivered(
  db: Pool,
  eventId: string
): Promise<boolean> {
  return updateCommandLogDeliveryStatus(db, eventId, 'delivered', 1);
}

/**
 * Mark a session message event as delivered
 */
export async function markMessageDelivered(
  db: Pool,
  eventId: string
): Promise<boolean> {
  return updateMessageDeliveryStatus(db, eventId, 'delivered', 1);
}

/**
 * Get event delivery statistics
 */
export async function getEventDeliveryStats(
  db: Pool
): Promise<{
  commandLogs: { pending: number; delivered: number; failed: number; deadLetter: number };
  sessionMessages: { pending: number; delivered: number; failed: number; deadLetter: number };
}> {
  const commandLogsResult = await db.query(`
    SELECT delivery_status, COUNT(*) as count
    FROM command_logs
    WHERE event_id IS NOT NULL
    GROUP BY delivery_status
  `);

  const messagesResult = await db.query(`
    SELECT delivery_status, COUNT(*) as count
    FROM session_messages
    WHERE event_id IS NOT NULL
    GROUP BY delivery_status
  `);

  const parseStats = (rows: any[]) => {
    const stats = { pending: 0, delivered: 0, failed: 0, deadLetter: 0 };
    for (const row of rows) {
      if (row.delivery_status === 'pending') stats.pending = parseInt(row.count, 10);
      else if (row.delivery_status === 'delivered') stats.delivered = parseInt(row.count, 10);
      else if (row.delivery_status === 'failed') stats.failed = parseInt(row.count, 10);
      else if (row.delivery_status === 'dead_letter') stats.deadLetter = parseInt(row.count, 10);
    }
    return stats;
  };

  return {
    commandLogs: parseStats(commandLogsResult.rows),
    sessionMessages: parseStats(messagesResult.rows)
  };
}

// =============================================================================
// Session Cleanup Query Helpers
// =============================================================================

/**
 * Get a session by ID with project_path for cleanup
 */
export async function getSessionById(
  db: Pool,
  id: string
): Promise<Session | null> {
  const result = await db.query(
    `SELECT id, project_path, project_type, status, claude_session_id,
            metadata, created_at, updated_at
     FROM sessions
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Get sessions eligible for cleanup based on status and age
 *
 * Returns sessions that are completed, error, or stale and have been
 * updated more than the specified number of hours ago.
 *
 * @param db Database pool
 * @param olderThanHours Only include sessions older than this many hours
 * @param limit Maximum number of sessions to return
 */
export async function getStaleSessionsForCleanup(
  db: Pool,
  olderThanHours: number,
  limit: number = 100
): Promise<SessionForCleanup[]> {
  const result = await db.query(
    `SELECT id, project_path, status, updated_at
     FROM sessions
     WHERE status IN ('completed', 'error', 'stale')
     AND updated_at < NOW() - INTERVAL '1 hour' * $1
     ORDER BY updated_at ASC
     LIMIT $2`,
    [olderThanHours, limit]
  );

  return result.rows;
}

/**
 * Delete a session record after cleanup
 *
 * Also deletes associated messages and command logs (via CASCADE or manual)
 */
export async function deleteSession(
  db: Pool,
  id: string
): Promise<boolean> {
  // Delete related records first if not using CASCADE
  await db.query(
    `DELETE FROM session_messages WHERE session_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM command_logs WHERE session_id = $1`,
    [id]
  );

  const result = await db.query(
    `DELETE FROM sessions WHERE id = $1 RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}

/**
 * Mark a session as cleaned (update metadata with cleaned_at timestamp)
 *
 * Alternative to deletion - preserves session record for auditing
 */
export async function markSessionCleaned(
  db: Pool,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions
     SET metadata = metadata || '{"cleaned_at": "${new Date().toISOString()}"}'::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}

/**
 * Update session status
 */
export async function updateSessionStatus(
  db: Pool,
  id: string,
  status: SessionStatus
): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id`,
    [status, id]
  );

  return result.rows.length > 0;
}

/**
 * Get count of sessions by status
 */
export async function getSessionStatusCounts(
  db: Pool
): Promise<Record<SessionStatus, number>> {
  const result = await db.query(`
    SELECT status, COUNT(*) as count
    FROM sessions
    GROUP BY status
  `);

  const counts: Record<string, number> = {
    active: 0,
    completed: 0,
    error: 0,
    stale: 0,
  };

  for (const row of result.rows) {
    if (row.status in counts) {
      counts[row.status] = parseInt(row.count, 10);
    }
  }

  return counts as Record<SessionStatus, number>;
}
