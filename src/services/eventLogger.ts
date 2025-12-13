// src/services/eventLogger.ts
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('event-logger');

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
 */
export interface FailedEventEntry {
  event: HookEvent;
  attempts: number;
  lastAttempt: string;
  lastError: string;
  nextRetry: string;
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
    this.failedLogPath = path.join(this.logDir, 'failed-events.json');
    this.deadLetterPath = path.join(this.logDir, 'dead-letter.json');
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
   * Add a failed event to the failed events queue
   */
  async writeFailedEvent(
    event: HookEvent,
    error: string,
    attempts: number = 1
  ): Promise<void> {
    try {
      const failedEvents = await this.readFailedEvents();

      // Calculate next retry time with exponential backoff
      // Base: 30 seconds, max: 1 hour
      const backoffMs = Math.min(30000 * Math.pow(2, attempts - 1), 3600000);
      const nextRetry = new Date(Date.now() + backoffMs).toISOString();

      const entry: FailedEventEntry = {
        event,
        attempts,
        lastAttempt: new Date().toISOString(),
        lastError: error,
        nextRetry
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

      logger.warn('Event added to failed queue', {
        eventId: event.eventId,
        attempts,
        nextRetry,
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
   * Read all failed events from the queue
   */
  async readFailedEvents(): Promise<FailedEventEntry[]> {
    try {
      if (!fs.existsSync(this.failedLogPath)) {
        return [];
      }

      const content = await fs.promises.readFile(this.failedLogPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        logger.warn('Invalid failed events file format, resetting');
        return [];
      }

      return parsed;
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
   * Get events ready for retry (past their nextRetry time)
   */
  async getEventsReadyForRetry(): Promise<FailedEventEntry[]> {
    const failedEvents = await this.readFailedEvents();
    const now = new Date();

    return failedEvents.filter(entry => new Date(entry.nextRetry) <= now);
  }

  /**
   * Remove a successfully delivered event from the failed queue
   */
  async removeFailedEvent(eventId: string): Promise<void> {
    try {
      const failedEvents = await this.readFailedEvents();
      const filtered = failedEvents.filter(e => e.event.eventId !== eventId);

      if (filtered.length !== failedEvents.length) {
        await this.writeFailedEventsAtomic(filtered);
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
   * Move an event to the dead letter queue after max retries
   */
  async moveToDeadLetter(entry: FailedEventEntry): Promise<void> {
    try {
      // Read existing dead letter entries
      let deadLetterEntries: FailedEventEntry[] = [];
      try {
        if (fs.existsSync(this.deadLetterPath)) {
          const content = await fs.promises.readFile(this.deadLetterPath, 'utf-8');
          deadLetterEntries = JSON.parse(content);
        }
      } catch {
        deadLetterEntries = [];
      }

      // Add to dead letter queue
      deadLetterEntries.push({
        ...entry,
        lastAttempt: new Date().toISOString()
      });

      // Write atomically
      const tempPath = this.deadLetterPath + '.tmp';
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify(deadLetterEntries, null, 2),
        { mode: 0o640 }
      );
      await fs.promises.rename(tempPath, this.deadLetterPath);

      // Remove from failed queue
      await this.removeFailedEvent(entry.event.eventId);

      logger.error('Event moved to dead letter queue', {
        eventId: entry.event.eventId,
        attempts: entry.attempts,
        lastError: entry.lastError
      });
    } catch (error) {
      logger.error('Failed to move event to dead letter queue', {
        eventId: entry.event.eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Write failed events file atomically using temp file + rename
   */
  private async writeFailedEventsAtomic(events: FailedEventEntry[]): Promise<void> {
    const tempPath = this.failedLogPath + '.tmp';

    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(events, null, 2),
      { mode: 0o640 }
    );

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
        const deadLetterEntries = JSON.parse(content);
        deadLetterCount = deadLetterEntries.length;
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
