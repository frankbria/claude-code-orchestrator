/**
 * Session Monitor Service
 *
 * Provides automatic detection of stale and crashed sessions using node-cron
 * for scheduling. Handles:
 * - Stale session detection (no heartbeat for configurable timeout)
 * - Process liveness checks via PID tracking
 * - Session status updates with metrics tracking
 *
 * @module services/sessionMonitor
 */

import cron, { ScheduledTask } from 'node-cron';
import { Pool } from 'pg';
import {
  getInactiveSessions,
  getSessionsWithPid,
  batchUpdateSessionStatus,
  SessionStatus,
} from '../db/queries';
import { createLogger } from '../utils/logger';
import {
  sessionsMarkedStale,
  sessionsMarkedCrashed,
  sessionMonitorRuns,
  sessionMonitorErrors,
} from '../metrics';

const logger = createLogger('session-monitor');

/**
 * Configuration for the session monitor
 */
export interface SessionMonitorConfig {
  /** Minutes of inactivity before marking a session as stale (default: 2) */
  staleTimeoutMinutes: number;
  /** Cron expression for stale session detection (default: every minute) */
  staleCronExpression: string;
  /** Cron expression for PID liveness check (default: every 5 minutes) */
  livenessCronExpression: string;
  /** Enable stale session detection (default: true) */
  enableStaleDetection: boolean;
  /** Enable PID liveness checks (default: true) */
  enableLivenessCheck: boolean;
}

const DEFAULT_STALE_TIMEOUT_MINUTES = 2;

/**
 * Parse and validate stale timeout minutes from environment variable
 * Returns default value if the env var is missing, invalid, or out of range
 */
function parseStaleTimeoutMinutes(envValue: string | undefined): number {
  if (!envValue) {
    return DEFAULT_STALE_TIMEOUT_MINUTES;
  }

  const parsed = parseInt(envValue, 10);

  // Validate: must be a finite positive integer
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn('Invalid SESSION_STALE_TIMEOUT_MINUTES value, using default', {
      envValue,
      parsedValue: parsed,
      defaultValue: DEFAULT_STALE_TIMEOUT_MINUTES,
    });
    return DEFAULT_STALE_TIMEOUT_MINUTES;
  }

  // Sanity check: cap at a reasonable maximum (24 hours = 1440 minutes)
  const MAX_TIMEOUT_MINUTES = 1440;
  if (parsed > MAX_TIMEOUT_MINUTES) {
    logger.warn('SESSION_STALE_TIMEOUT_MINUTES exceeds maximum, capping', {
      envValue,
      parsedValue: parsed,
      maxValue: MAX_TIMEOUT_MINUTES,
    });
    return MAX_TIMEOUT_MINUTES;
  }

  return parsed;
}

/**
 * Get session monitor configuration from environment variables
 */
export function getSessionMonitorConfig(): SessionMonitorConfig {
  return {
    staleTimeoutMinutes: parseStaleTimeoutMinutes(process.env.SESSION_STALE_TIMEOUT_MINUTES),
    staleCronExpression: process.env.SESSION_STALE_CRON || '* * * * *',
    livenessCronExpression: process.env.SESSION_LIVENESS_CRON || '*/5 * * * *',
    enableStaleDetection: process.env.ENABLE_STALE_DETECTION !== 'false',
    enableLivenessCheck: process.env.ENABLE_LIVENESS_CHECK !== 'false',
  };
}

/**
 * Session monitor statistics
 */
export interface SessionMonitorStats {
  /** Number of sessions marked as stale */
  sessionsMarkedStale: number;
  /** Number of sessions marked as crashed */
  sessionsMarkedCrashed: number;
  /** Total number of monitor runs */
  totalRuns: number;
  /** Number of errors encountered */
  errors: number;
  /** Timestamp of last stale check */
  lastStaleCheck: Date | null;
  /** Timestamp of last liveness check */
  lastLivenessCheck: Date | null;
  /** Whether the monitor is running */
  isRunning: boolean;
}

/**
 * Check if a process with the given PID is alive
 * Uses signal 0 to check process existence without killing it
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks if the process exists without sending a real signal
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // ESRCH = No such process
    // EPERM = Process exists but we don't have permission (still alive)
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EPERM') {
      return true; // Process exists but we can't signal it
    }
    return false; // Process doesn't exist
  }
}

/**
 * SessionMonitor class manages the scheduled monitoring of session health
 */
export class SessionMonitor {
  private staleTask: ScheduledTask | null = null;
  private livenessTask: ScheduledTask | null = null;
  private db: Pool;
  private config: SessionMonitorConfig;
  private stats: SessionMonitorStats = {
    sessionsMarkedStale: 0,
    sessionsMarkedCrashed: 0,
    totalRuns: 0,
    errors: 0,
    lastStaleCheck: null,
    lastLivenessCheck: null,
    isRunning: false,
  };

  constructor(db: Pool, config?: Partial<SessionMonitorConfig>) {
    this.db = db;
    this.config = { ...getSessionMonitorConfig(), ...config };
  }

  /**
   * Start the session monitor
   */
  start(): void {
    if (this.stats.isRunning) {
      logger.warn('Session monitor already running');
      return;
    }

    // Start stale session detection
    if (this.config.enableStaleDetection) {
      this.staleTask = cron.schedule(this.config.staleCronExpression, async () => {
        await this.checkStaleSessions();
      });
      logger.info('Stale session detection started', {
        cronExpression: this.config.staleCronExpression,
        timeoutMinutes: this.config.staleTimeoutMinutes,
      });
    }

    // Start PID liveness checks
    if (this.config.enableLivenessCheck) {
      this.livenessTask = cron.schedule(this.config.livenessCronExpression, async () => {
        await this.checkProcessLiveness();
      });
      logger.info('Process liveness check started', {
        cronExpression: this.config.livenessCronExpression,
      });
    }

    this.stats.isRunning = true;
    logger.info('Session monitor started', {
      staleDetection: this.config.enableStaleDetection,
      livenessCheck: this.config.enableLivenessCheck,
    });
  }

  /**
   * Stop the session monitor
   */
  stop(): void {
    if (this.staleTask) {
      this.staleTask.stop();
      this.staleTask = null;
    }

    if (this.livenessTask) {
      this.livenessTask.stop();
      this.livenessTask = null;
    }

    this.stats.isRunning = false;
    logger.info('Session monitor stopped');
  }

  /**
   * Get monitor statistics
   */
  getStats(): SessionMonitorStats {
    return { ...this.stats };
  }

  /**
   * Check for and mark stale sessions
   */
  async checkStaleSessions(): Promise<number> {
    this.stats.totalRuns++;
    this.stats.lastStaleCheck = new Date();
    sessionMonitorRuns.labels({ type: 'stale' }).inc();

    try {
      // Get active sessions that haven't been updated within the timeout
      const staleSessions = await getInactiveSessions(
        this.db,
        this.config.staleTimeoutMinutes,
        100
      );

      if (staleSessions.length === 0) {
        return 0;
      }

      const sessionIds = staleSessions.map(s => s.id);
      const updated = await batchUpdateSessionStatus(this.db, sessionIds, 'stale');

      this.stats.sessionsMarkedStale += updated;
      sessionsMarkedStale.inc(updated);

      logger.info('Sessions marked as stale', {
        count: updated,
        sessionIds,
        timeoutMinutes: this.config.staleTimeoutMinutes,
      });

      return updated;
    } catch (error) {
      this.stats.errors++;
      sessionMonitorErrors.labels({ type: 'stale' }).inc();
      logger.error('Stale session detection failed', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      return 0;
    }
  }

  /**
   * Check process liveness for sessions with tracked PIDs
   */
  async checkProcessLiveness(): Promise<number> {
    this.stats.totalRuns++;
    this.stats.lastLivenessCheck = new Date();
    sessionMonitorRuns.labels({ type: 'liveness' }).inc();

    try {
      // Get active sessions with claudePid in metadata
      const sessions = await getSessionsWithPid(this.db);

      if (sessions.length === 0) {
        return 0;
      }

      const crashedSessionIds: string[] = [];

      for (const session of sessions) {
        const pid = session.metadata?.claudePid;

        // Validate PID is a reasonable number
        if (typeof pid !== 'number' || pid <= 0 || !Number.isInteger(pid)) {
          logger.warn('Invalid PID in session metadata', {
            sessionId: session.id,
            pid,
          });
          continue;
        }

        if (!isProcessAlive(pid)) {
          crashedSessionIds.push(session.id);
          logger.info('Process not found for session', {
            sessionId: session.id,
            pid,
          });
        }
      }

      if (crashedSessionIds.length === 0) {
        return 0;
      }

      const updated = await batchUpdateSessionStatus(this.db, crashedSessionIds, 'crashed');

      this.stats.sessionsMarkedCrashed += updated;
      sessionsMarkedCrashed.inc(updated);

      logger.info('Sessions marked as crashed', {
        count: updated,
        sessionIds: crashedSessionIds,
      });

      return updated;
    } catch (error) {
      this.stats.errors++;
      sessionMonitorErrors.labels({ type: 'liveness' }).inc();
      logger.error('Process liveness check failed', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      return 0;
    }
  }

  /**
   * Run both checks manually (useful for testing)
   */
  async runChecks(): Promise<{ stale: number; crashed: number }> {
    const stale = await this.checkStaleSessions();
    const crashed = await this.checkProcessLiveness();
    return { stale, crashed };
  }
}

// Singleton instance
let sessionMonitorInstance: SessionMonitor | null = null;

/**
 * Start the session monitor daemon
 *
 * @param db Database pool
 * @param config Optional configuration overrides
 */
export function startSessionMonitor(
  db: Pool,
  config?: Partial<SessionMonitorConfig>
): SessionMonitor {
  if (sessionMonitorInstance) {
    logger.warn('Session monitor already exists, returning existing instance');
    return sessionMonitorInstance;
  }

  sessionMonitorInstance = new SessionMonitor(db, config);
  sessionMonitorInstance.start();

  return sessionMonitorInstance;
}

/**
 * Stop the session monitor daemon
 */
export function stopSessionMonitor(): void {
  if (sessionMonitorInstance) {
    sessionMonitorInstance.stop();
    sessionMonitorInstance = null;
  }
}

/**
 * Get the session monitor instance
 */
export function getSessionMonitor(): SessionMonitor | null {
  return sessionMonitorInstance;
}
