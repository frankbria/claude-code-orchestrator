// src/db/retry.ts
import { Pool } from 'pg';
import { createLogger } from '../utils/logger';
import {
  VersionConflictError,
  Session,
  SessionUpdatePayload,
  getSessionById,
  updateSessionWithVersion,
} from './queries';

const logger = createLogger('retry');

/**
 * Configuration options for retry behavior
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 1000) */
  maxDelayMs?: number;
  /** Jitter factor (0-1) to add randomness to delays (default: 0.1) */
  jitterFactor?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterFactor: 0.1,
};

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The result value if successful */
  value?: T;
  /** Number of attempts made */
  attempts: number;
  /** Whether retries were exhausted */
  retriesExhausted: boolean;
  /** The last error if failed */
  error?: Error;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter: random value between -jitterFactor*delay and +jitterFactor*delay
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, cappedDelay + jitter);
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an operation with optimistic lock retry logic
 *
 * This function wraps an async operation and automatically retries
 * when a VersionConflictError is thrown. It uses exponential backoff
 * with jitter to avoid thundering herd problems.
 *
 * @param operation Async function that may throw VersionConflictError
 * @param options Retry configuration options
 * @returns RetryResult containing success status, value, and retry metadata
 *
 * @example
 * ```typescript
 * const result = await withOptimisticLockRetry(async () => {
 *   const session = await getSessionById(db, sessionId);
 *   return updateSessionWithVersion(db, sessionId, { status: 'active' }, session.version);
 * });
 *
 * if (result.success) {
 *   console.log('Updated to version:', result.value);
 * } else {
 *   console.log('Failed after', result.attempts, 'attempts');
 * }
 * ```
 */
export async function withOptimisticLockRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let attempts = 0;
  let lastError: Error | undefined;

  while (attempts <= config.maxRetries) {
    attempts++;

    try {
      const value = await operation();
      return {
        success: true,
        value,
        attempts,
        retriesExhausted: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Only retry on version conflict errors
      if (!(error instanceof VersionConflictError)) {
        return {
          success: false,
          attempts,
          retriesExhausted: false,
          error: lastError,
        };
      }

      // Check if we have retries left
      if (attempts > config.maxRetries) {
        logger.warn('Optimistic lock retry exhausted', {
          sessionId: error.sessionId,
          expectedVersion: error.expectedVersion,
          totalAttempts: attempts,
        });
        break;
      }

      // Calculate and apply backoff delay
      const delay = calculateDelay(
        attempts - 1,
        config.baseDelayMs,
        config.maxDelayMs,
        config.jitterFactor
      );

      logger.info('Retrying after version conflict', {
        sessionId: error.sessionId,
        expectedVersion: error.expectedVersion,
        attempt: attempts,
        maxRetries: config.maxRetries,
        delayMs: Math.round(delay),
      });

      await sleep(delay);
    }
  }

  return {
    success: false,
    attempts,
    retriesExhausted: true,
    error: lastError,
  };
}

/**
 * High-level helper to update a session with automatic retry
 *
 * This function handles the full read-modify-write cycle with retry logic:
 * 1. Reads the current session state (including version)
 * 2. Applies the update with version check
 * 3. Retries on version conflict
 *
 * @param db Database pool
 * @param sessionId Session UUID
 * @param updates Fields to update
 * @param options Retry configuration options
 * @returns RetryResult with the new version number on success
 */
export async function updateSessionWithRetry(
  db: Pool,
  sessionId: string,
  updates: SessionUpdatePayload,
  options: RetryOptions = {}
): Promise<RetryResult<number>> {
  return withOptimisticLockRetry(async () => {
    // Read current session to get version
    const session = await getSessionById(db, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Update with version check
    return updateSessionWithVersion(db, sessionId, updates, session.version);
  }, options);
}

/**
 * Metrics tracking for retry operations
 */
export interface RetryMetrics {
  totalAttempts: number;
  successfulFirstAttempts: number;
  successfulRetries: number;
  failedAfterRetries: number;
  nonRetryableErrors: number;
}

/**
 * Create a retry metrics collector
 *
 * This can be used to track retry behavior across the application
 * for monitoring and alerting purposes.
 */
export function createRetryMetricsCollector(): {
  record: (result: RetryResult<any>) => void;
  getMetrics: () => RetryMetrics;
  reset: () => void;
} {
  let metrics: RetryMetrics = {
    totalAttempts: 0,
    successfulFirstAttempts: 0,
    successfulRetries: 0,
    failedAfterRetries: 0,
    nonRetryableErrors: 0,
  };

  return {
    record(result: RetryResult<any>) {
      metrics.totalAttempts += result.attempts;

      if (result.success) {
        if (result.attempts === 1) {
          metrics.successfulFirstAttempts++;
        } else {
          metrics.successfulRetries++;
        }
      } else if (result.retriesExhausted) {
        metrics.failedAfterRetries++;
      } else {
        metrics.nonRetryableErrors++;
      }
    },

    getMetrics() {
      return { ...metrics };
    },

    reset() {
      metrics = {
        totalAttempts: 0,
        successfulFirstAttempts: 0,
        successfulRetries: 0,
        failedAfterRetries: 0,
        nonRetryableErrors: 0,
      };
    },
  };
}

// Global metrics collector instance (optional, for monitoring)
export const retryMetrics = createRetryMetricsCollector();
