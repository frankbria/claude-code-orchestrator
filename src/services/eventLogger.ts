// src/services/eventLogger.ts
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('event-logger');

// Lock timeout in milliseconds (5 seconds)
const LOCK_TIMEOUT_MS = 5000;
// Lock retry interval in milliseconds
const LOCK_RETRY_MS = 50;

/**
 * Event structure for tool completion hooks
 */
export interface ToolCompleteEvent {
  eventId: string;
  eventType: 'tool-complete';
  session: string;
  tool: string;
  input?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  timestamp: string;
}

/**
 * Event structure for notification hooks
 */
export interface NotificationEvent {
  eventId: string;
  eventType: 'notification';
  session: string;
  message: string;
  timestamp: string;
}

export type HookEvent = ToolCompleteEvent | NotificationEvent;

/**
 * Failed event entry with error details
 * Matches the format used by bash hooks and RetryDaemon for compatibility
 */
export interface FailedEventEntry {
  event: HookEvent;
  error: string;
  lastAttempt: string;
  attempts: number;
}

/**
 * Event Logger Service
 *
 * Handles local persistence of hook events for reliability.
 * Events are written to local files before HTTP delivery attempts,
 * ensuring no data loss when the API is unavailable.
 */
export class EventLogger {
  private logDir: string;
  private eventsLogPath: string;
  private failedLogPath: string;
  private deadLetterPath: string;
  private lockFile: string;

  constructor(logDir?: string) {
    this.logDir = logDir || process.env.EVENT_LOG_DIR || '/var/log/claude-orchestrator/events';
    this.eventsLogPath = path.join(this.logDir, 'events.log');
    this.failedLogPath = path.join(this.logDir, 'failed-events.ndjson');
    this.deadLetterPath = path.join(this.logDir, 'dead-letter.ndjson');
    this.lockFile = path.join(this.logDir, '.lock');

    this.ensureLogDirectory();
  }

  /**
   * Ensure the log directory exists with proper permissions
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true, mode: 0o750 });
      }
    } catch (error) {
      logger.error('Failed to create event log directory', {
        logDir: this.logDir,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Acquire an exclusive file lock for read-modify-write operations.
   * Uses exclusive file creation ('wx' flag) to ensure atomicity.
   * Returns a release function that must be called when done.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    const startTime = Date.now();

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        // Try to create lock file exclusively
        const fd = await fs.promises.open(this.lockFile, 'wx');

        // Lock acquired - return release function
        return async () => {
          try {
            await fd.close();
            await fs.promises.unlink(this.lockFile);
          } catch (error) {
            logger.warn('Failed to release lock file', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Lock file exists, check if it's stale (older than timeout)
          try {
            const stats = await fs.promises.stat(this.lockFile);
            const lockAge = Date.now() - stats.mtimeMs;
            if (lockAge > LOCK_TIMEOUT_MS) {
              // Stale lock, remove it and retry
              logger.warn('Removing stale lock file', { lockAge });
              await fs.promises.unlink(this.lockFile);
              continue;
            }
          } catch {
            // Lock file might have been removed, retry
          }
          // Wait and retry
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        } else {
          throw error;
        }
      }
    }

    throw new Error(`Failed to acquire lock within ${LOCK_TIMEOUT_MS}ms`);
  }

  /**
   * Execute a function while holding the file lock.
   * Ensures lock is released even if the function throws.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const releaseLock = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await releaseLock();
    }
  }

  /**
   * Write an event to the events log (append-only)
   * This is called before attempting HTTP delivery
   */
  async writeEventLog(event: HookEvent): Promise<void> {
    try {
      const logLine = JSON.stringify({
        ...event,
        loggedAt: new Date().toISOString()
      }) + '\n';

      await fs.promises.appendFile(this.eventsLogPath, logLine, { mode: 0o640 });

      logger.info('Event logged', {
        eventId: event.eventId,
        eventType: event.eventType,
        session: event.session
      });
    } catch (error) {
      logger.error('Failed to write event log', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Add a failed event to the failed events queue (NDJSON format)
   * Uses file locking to prevent race conditions in read-modify-write.
   */
  async writeFailedEvent(
    event: HookEvent,
    error: string,
    attempts: number = 1
  ): Promise<void> {
    try {
      await this.withLock(async () => {
        const failedEvents = await this.readFailedEvents();
        const now = new Date().toISOString();

        const entry: FailedEventEntry = {
          event,
          error,
          lastAttempt: now,
          attempts
        };

        // Check if event already exists in failed queue
        const existingIndex = failedEvents.findIndex(
          e => e.event.eventId === event.eventId
        );

        if (existingIndex >= 0) {
          failedEvents[existingIndex] = entry;
        } else {
          failedEvents.push(entry);
        }

        await this.writeFailedEventsAtomic(failedEvents);
      });

      logger.warn('Event added to failed queue', {
        eventId: event.eventId,
        attempts,
        error
      });
    } catch (writeError) {
      logger.error('Failed to write to failed events queue', {
        eventId: event.eventId,
        error: writeError instanceof Error ? writeError.message : String(writeError)
      });
    }
  }

  /**
   * Read all failed events from the queue (NDJSON format)
   */
  async readFailedEvents(): Promise<FailedEventEntry[]> {
    try {
      if (!fs.existsSync(this.failedLogPath)) {
        return [];
      }

      const content = await fs.promises.readFile(this.failedLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      const events: FailedEventEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry && entry.event && entry.event.eventId) {
            events.push(entry);
          }
        } catch {
          // Skip malformed lines
          logger.warn('Skipping malformed line in failed events file');
        }
      }

      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      logger.error('Failed to read failed events', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Calculate backoff time in milliseconds for a given attempt count
   * Base: 30 seconds, max: 1 hour
   */
  private calculateBackoff(attempts: number): number {
    const baseMs = 30000; // 30 seconds
    const maxMs = 3600000; // 1 hour
    return Math.min(baseMs * Math.pow(2, attempts - 1), maxMs);
  }

  /**
   * Get events ready for retry (past their backoff time)
   */
  async getEventsReadyForRetry(): Promise<FailedEventEntry[]> {
    const failedEvents = await this.readFailedEvents();
    const now = new Date();

    return failedEvents.filter(entry => {
      const backoffMs = this.calculateBackoff(entry.attempts);
      const nextRetryTime = new Date(new Date(entry.lastAttempt).getTime() + backoffMs);
      return nextRetryTime <= now;
    });
  }

  /**
   * Internal method to remove event from failed queue without acquiring lock.
   * Caller must hold the lock.
   */
  private async removeFailedEventInternal(eventId: string): Promise<boolean> {
    const failedEvents = await this.readFailedEvents();
    const filtered = failedEvents.filter(e => e.event.eventId !== eventId);

    if (filtered.length !== failedEvents.length) {
      await this.writeFailedEventsAtomic(filtered);
      return true;
    }
    return false;
  }

  /**
   * Remove a successfully delivered event from the failed queue.
   * Uses file locking to prevent race conditions in read-modify-write.
   */
  async removeFailedEvent(eventId: string): Promise<void> {
    try {
      const removed = await this.withLock(async () => {
        return this.removeFailedEventInternal(eventId);
      });

      if (removed) {
        logger.info('Event removed from failed queue', { eventId });
      }
    } catch (error) {
      logger.error('Failed to remove event from failed queue', {
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Move an event to the dead letter queue after max retries (NDJSON format).
   * Uses file locking to ensure atomic append + remove operation.
   */
  async moveToDeadLetter(entry: FailedEventEntry): Promise<void> {
    try {
      await this.withLock(async () => {
        // Create dead letter entry with timestamp
        const deadLetterEntry = JSON.stringify({
          ...entry,
          movedToDeadLetter: new Date().toISOString()
        }) + '\n';

        // Append to dead letter queue (NDJSON)
        await fs.promises.appendFile(this.deadLetterPath, deadLetterEntry, { mode: 0o640 });

        // Remove from failed queue (using internal method to avoid deadlock)
        await this.removeFailedEventInternal(entry.event.eventId);
      });

      logger.error('Event moved to dead letter queue', {
        eventId: entry.event.eventId,
        attempts: entry.attempts,
        error: entry.error
      });
    } catch (error) {
      logger.error('Failed to move event to dead letter queue', {
        eventId: entry.event.eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Write failed events file atomically using temp file + rename (NDJSON format)
   */
  private async writeFailedEventsAtomic(events: FailedEventEntry[]): Promise<void> {
    const tempPath = this.failedLogPath + '.tmp';

    const content = events.length > 0
      ? events.map(e => JSON.stringify(e)).join('\n') + '\n'
      : '';

    await fs.promises.writeFile(tempPath, content, { mode: 0o640 });
    await fs.promises.rename(tempPath, this.failedLogPath);
  }

  /**
   * Get statistics about event delivery
   */
  async getStats(): Promise<{
    pendingRetries: number;
    deadLetterCount: number;
    oldestPending: string | null;
  }> {
    const failedEvents = await this.readFailedEvents();

    let deadLetterCount = 0;
    try {
      if (fs.existsSync(this.deadLetterPath)) {
        const content = await fs.promises.readFile(this.deadLetterPath, 'utf-8');
        // Count non-empty lines in NDJSON
        deadLetterCount = content.trim().split('\n').filter(l => l.trim()).length;
      }
    } catch {
      deadLetterCount = 0;
    }

    const oldestPending = failedEvents.length > 0
      ? failedEvents.reduce((oldest, entry) =>
          entry.lastAttempt < oldest.lastAttempt ? entry : oldest
        ).lastAttempt
      : null;

    return {
      pendingRetries: failedEvents.length,
      deadLetterCount,
      oldestPending
    };
  }
}

/**
 * Singleton instance for convenience
 */
let eventLoggerInstance: EventLogger | null = null;

export function getEventLogger(): EventLogger {
  if (!eventLoggerInstance) {
    eventLoggerInstance = new EventLogger();
  }
  return eventLoggerInstance;
}

/**
 * Create a new EventLogger instance with custom configuration
 */
export function createEventLogger(logDir?: string): EventLogger {
  return new EventLogger(logDir);
}
