// src/services/retryDaemon.ts
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('retry-daemon');

/**
 * Configuration for the retry daemon
 */
export interface RetryDaemonConfig {
  /** Directory containing failed events files */
  eventLogDir: string;
  /** Base URL for the API */
  apiBaseUrl: string;
  /** Optional hook secret for authentication */
  hookSecret?: string;
  /** Interval between retry checks in milliseconds (default: 30000) */
  retryIntervalMs: number;
  /** Maximum retry attempts before moving to dead letter (default: 10) */
  maxRetryAttempts: number;
  /** HTTP timeout in milliseconds (default: 5000) */
  httpTimeoutMs: number;
}

/**
 * Failed event entry structure (from NDJSON file)
 */
interface FailedEventEntry {
  event: {
    eventId: string;
    eventType: 'tool-complete' | 'notification';
    session: string;
    [key: string]: unknown;
  };
  error: string;
  lastAttempt: string;
  attempts: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Partial<RetryDaemonConfig> = {
  eventLogDir: process.env.EVENT_LOG_DIR || '/var/log/claude-orchestrator/events',
  apiBaseUrl: process.env.CLAUDE_ORCHESTRATOR_API || 'http://localhost:3001',
  hookSecret: process.env.CLAUDE_HOOK_SECRET,
  retryIntervalMs: parseInt(process.env.RETRY_INTERVAL_MS || '30000', 10),
  maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '10', 10),
  httpTimeoutMs: parseInt(process.env.RETRY_TIMEOUT_MS || '5000', 10)
};

/**
 * Retry Daemon Service
 *
 * Periodically checks for failed events and attempts redelivery.
 * Uses exponential backoff for retry timing.
 */
export class RetryDaemon {
  private config: RetryDaemonConfig;
  private failedEventsPath: string;
  private deadLetterPath: string;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;

  constructor(config: Partial<RetryDaemonConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config
    } as RetryDaemonConfig;

    this.failedEventsPath = path.join(this.config.eventLogDir, 'failed-events.ndjson');
    this.deadLetterPath = path.join(this.config.eventLogDir, 'dead-letter.ndjson');
  }

  /**
   * Start the retry daemon
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Retry daemon already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting retry daemon', {
      intervalMs: this.config.retryIntervalMs,
      maxAttempts: this.config.maxRetryAttempts,
      apiBaseUrl: this.config.apiBaseUrl
    });

    // Run immediately, then on interval
    this.processRetries();

    this.intervalId = setInterval(() => {
      this.processRetries();
    }, this.config.retryIntervalMs);
  }

  /**
   * Stop the retry daemon gracefully
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info('Retry daemon stopped');
  }

  /**
   * Process pending retry queue
   */
  private async processRetries(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const failedEvents = await this.readFailedEvents();

      if (failedEvents.length === 0) {
        this.isProcessing = false;
        return;
      }

      logger.info('Processing retry queue', { pendingCount: failedEvents.length });

      const now = new Date();
      const eventsToKeep: FailedEventEntry[] = [];
      let retriedCount = 0;
      let succeededCount = 0;
      let deadLetterCount = 0;

      for (const entry of failedEvents) {
        // Check if ready for retry (exponential backoff)
        const backoffMs = this.calculateBackoff(entry.attempts);
        const nextRetryTime = new Date(new Date(entry.lastAttempt).getTime() + backoffMs);

        if (nextRetryTime > now) {
          // Not ready for retry yet
          eventsToKeep.push(entry);
          continue;
        }

        // Check if max retries exceeded
        if (entry.attempts >= this.config.maxRetryAttempts) {
          await this.moveToDeadLetter(entry);
          deadLetterCount++;
          continue;
        }

        // Attempt redelivery
        retriedCount++;
        const success = await this.retryDelivery(entry);

        if (success) {
          succeededCount++;
          // Don't keep this event - it was delivered successfully
        } else {
          // Update attempt count and keep for next retry
          eventsToKeep.push({
            ...entry,
            attempts: entry.attempts + 1,
            lastAttempt: new Date().toISOString()
          });
        }
      }

      // Write remaining events back to file
      await this.writeFailedEvents(eventsToKeep);

      if (retriedCount > 0) {
        logger.info('Retry processing complete', {
          retried: retriedCount,
          succeeded: succeededCount,
          failed: retriedCount - succeededCount,
          deadLetter: deadLetterCount,
          remaining: eventsToKeep.length
        });
      }
    } catch (error) {
      logger.error('Error processing retry queue', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Calculate exponential backoff for retry
   * Base: 30 seconds, max: 1 hour
   */
  private calculateBackoff(attempts: number): number {
    const baseMs = 30000; // 30 seconds
    const maxMs = 3600000; // 1 hour
    return Math.min(baseMs * Math.pow(2, attempts - 1), maxMs);
  }

  /**
   * Attempt to redeliver a failed event
   */
  private async retryDelivery(entry: FailedEventEntry): Promise<boolean> {
    const endpoint = entry.event.eventType === 'tool-complete'
      ? '/api/hooks/tool-complete'
      : '/api/hooks/notification';

    const url = `${this.config.apiBaseUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (this.config.hookSecret) {
        headers['x-hook-secret'] = this.config.hookSecret;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(entry.event),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json() as { status: string };

        logger.info('Event redelivery successful', {
          eventId: entry.event.eventId,
          status: data.status,
          attempt: entry.attempts + 1
        });

        return true;
      } else {
        logger.warn('Event redelivery failed', {
          eventId: entry.event.eventId,
          status: response.status,
          attempt: entry.attempts + 1
        });

        return false;
      }
    } catch (error) {
      logger.warn('Event redelivery error', {
        eventId: entry.event.eventId,
        error: error instanceof Error ? error.message : String(error),
        attempt: entry.attempts + 1
      });

      return false;
    }
  }

  /**
   * Read failed events from NDJSON file
   */
  private async readFailedEvents(): Promise<FailedEventEntry[]> {
    try {
      if (!fs.existsSync(this.failedEventsPath)) {
        return [];
      }

      const content = await fs.promises.readFile(this.failedEventsPath, 'utf-8');
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
      throw error;
    }
  }

  /**
   * Write failed events to NDJSON file (atomic)
   */
  private async writeFailedEvents(events: FailedEventEntry[]): Promise<void> {
    const tempPath = this.failedEventsPath + '.tmp';

    const content = events.length > 0
      ? events.map(e => JSON.stringify(e)).join('\n') + '\n'
      : '';

    await fs.promises.writeFile(tempPath, content, { mode: 0o640 });
    await fs.promises.rename(tempPath, this.failedEventsPath);
  }

  /**
   * Move event to dead letter queue
   */
  private async moveToDeadLetter(entry: FailedEventEntry): Promise<void> {
    try {
      const deadLetterEntry = JSON.stringify({
        ...entry,
        movedToDeadLetter: new Date().toISOString()
      }) + '\n';

      await fs.promises.appendFile(this.deadLetterPath, deadLetterEntry, { mode: 0o640 });

      logger.error('Event moved to dead letter queue', {
        eventId: entry.event.eventId,
        eventType: entry.event.eventType,
        attempts: entry.attempts,
        lastError: entry.error
      });
    } catch (error) {
      logger.error('Failed to write to dead letter queue', {
        eventId: entry.event.eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get statistics about the retry queue
   */
  async getStats(): Promise<{
    isRunning: boolean;
    pendingRetries: number;
    deadLetterCount: number;
  }> {
    const failedEvents = await this.readFailedEvents();

    let deadLetterCount = 0;
    try {
      if (fs.existsSync(this.deadLetterPath)) {
        const content = await fs.promises.readFile(this.deadLetterPath, 'utf-8');
        deadLetterCount = content.trim().split('\n').filter(l => l.trim()).length;
      }
    } catch {
      deadLetterCount = 0;
    }

    return {
      isRunning: this.isRunning,
      pendingRetries: failedEvents.length,
      deadLetterCount
    };
  }
}

// Singleton instance
let daemonInstance: RetryDaemon | null = null;

/**
 * Start the retry daemon (singleton)
 */
export function startRetryDaemon(config?: Partial<RetryDaemonConfig>): RetryDaemon {
  if (!daemonInstance) {
    daemonInstance = new RetryDaemon(config);
  }

  daemonInstance.start();
  return daemonInstance;
}

/**
 * Stop the retry daemon
 */
export function stopRetryDaemon(): void {
  if (daemonInstance) {
    daemonInstance.stop();
  }
}

/**
 * Get the retry daemon instance
 */
export function getRetryDaemon(): RetryDaemon | null {
  return daemonInstance;
}
