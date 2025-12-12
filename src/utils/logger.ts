import fs from 'fs';
import path from 'path';

/**
 * Log entry structure for structured logging
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'critical';
  category: string;
  message: string;
  metadata?: Record<string, any>;
  timestamp: string;
}

/**
 * Logger class for structured logging with security audit trail
 *
 * Security logs are written to both console (for monitoring) and
 * dedicated log files (for audit trail and compliance).
 */
export class Logger {
  private category: string;
  private logDir: string;

  /**
   * Create a new logger instance
   * @param category - Log category (e.g., 'security', 'api', 'database')
   */
  constructor(category: string) {
    this.category = category;
    this.logDir = process.env.LOG_DIR || '/var/log/claude-orchestrator';

    // Ensure log directory exists with secure permissions
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true, mode: 0o750 });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
      // Fall back to console-only logging
    }
  }

  /**
   * Internal logging method
   * @param level - Log level
   * @param message - Log message
   * @param metadata - Additional structured data
   */
  private log(level: LogEntry['level'], message: string, metadata?: Record<string, any>): void {
    const entry: LogEntry = {
      level,
      category: this.category,
      message,
      metadata,
      timestamp: new Date().toISOString(),
    };

    // Console output (structured JSON for log aggregation tools)
    console.log(JSON.stringify(entry));

    // File output for security logs (audit trail)
    if (this.category === 'security') {
      this.writeSecurityLog(entry);
    }
  }

  /**
   * Write security log entry to dedicated file
   * Security logs require special handling for compliance and audit
   * @param entry - Log entry to write
   */
  private writeSecurityLog(entry: LogEntry): void {
    try {
      const logFile = path.join(this.logDir, 'security.log');
      const logLine = JSON.stringify(entry) + '\n';

      // Append to security log file with restricted permissions
      fs.appendFileSync(logFile, logLine, { mode: 0o640 });
    } catch (error) {
      // If file writing fails, at least we have console output
      console.error('Failed to write security log:', error);
    }
  }

  /**
   * Log informational message
   * @param message - Log message
   * @param metadata - Additional structured data
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.log('info', message, metadata);
  }

  /**
   * Log warning message
   * Used for security events that were blocked or unusual activity
   * @param message - Log message
   * @param metadata - Additional structured data
   */
  warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata);
  }

  /**
   * Log error message
   * Used for operational errors and security violations
   * @param message - Log message
   * @param metadata - Additional structured data
   */
  error(message: string, metadata?: Record<string, any>): void {
    this.log('error', message, metadata);
  }

  /**
   * Log critical message
   * Used for severe security incidents requiring immediate attention
   * @param message - Log message
   * @param metadata - Additional structured data
   */
  critical(message: string, metadata?: Record<string, any>): void {
    this.log('critical', message, metadata);
  }
}

/**
 * Factory function to create logger instances
 * @param category - Log category
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const securityLogger = createLogger('security');
 * securityLogger.warn('Invalid login attempt', { userId: '123', ip: '1.2.3.4' });
 * ```
 */
export function createLogger(category: string): Logger {
  return new Logger(category);
}
