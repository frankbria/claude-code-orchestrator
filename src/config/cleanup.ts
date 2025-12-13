/**
 * Cleanup Configuration Module
 *
 * Centralized configuration for workspace lifecycle management including:
 * - Disk quota enforcement
 * - Workspace archival settings
 * - Scheduled cleanup job parameters
 *
 * @module config/cleanup
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('config');

/**
 * Cleanup configuration interface
 */
export interface CleanupConfig {
  /** Base directory for workspaces */
  workspaceBase: string;
  /** Enable archival before workspace deletion */
  archiveWorkspaces: boolean;
  /** Directory to store workspace archives */
  archiveDir: string;
  /** Maximum number of concurrent workspaces */
  maxWorkspaces: number;
  /** Minimum free disk space in GB required */
  minDiskSpaceGB: number;
  /** Hours before cleaning completed/error sessions */
  cleanupIntervalHours: number;
  /** Cron expression for cleanup job */
  cleanupCronExpression: string;
  /** Delete session records after workspace cleanup */
  cleanupDeleteSessions: boolean;
  /** Enable automatic cleanup on session completion */
  enableAutoCleanup: boolean;
  /** Enable scheduled cleanup job */
  enableScheduledCleanup: boolean;
}

/**
 * Default configuration values
 */
const defaults: CleanupConfig = {
  workspaceBase: '/tmp/claude-workspaces',
  archiveWorkspaces: false,
  archiveDir: '/var/archives/claude-workspaces',
  maxWorkspaces: 100,
  minDiskSpaceGB: 5,
  cleanupIntervalHours: 24,
  cleanupCronExpression: '0 * * * *', // Every hour
  cleanupDeleteSessions: false,
  enableAutoCleanup: true,
  enableScheduledCleanup: true,
};

/**
 * Parse boolean from environment variable
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse integer from environment variable with validation
 */
function parseInteger(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  if (isNaN(parsed)) {
    logger.warn(`Invalid ${name} value: ${value}, using default: ${defaultValue}`);
    return defaultValue;
  }

  if (parsed < min || parsed > max) {
    logger.warn(`${name} value ${parsed} out of range [${min}, ${max}], using default: ${defaultValue}`);
    return defaultValue;
  }

  return parsed;
}

/**
 * Load and validate cleanup configuration from environment variables
 *
 * @returns Validated cleanup configuration
 */
export function loadCleanupConfig(): CleanupConfig {
  const config: CleanupConfig = {
    workspaceBase: process.env.WORKSPACE_BASE || defaults.workspaceBase,

    archiveWorkspaces: parseBoolean(
      process.env.ARCHIVE_WORKSPACES,
      defaults.archiveWorkspaces
    ),

    archiveDir: process.env.ARCHIVE_DIR || defaults.archiveDir,

    maxWorkspaces: parseInteger(
      process.env.MAX_WORKSPACES,
      defaults.maxWorkspaces,
      1,
      10000,
      'MAX_WORKSPACES'
    ),

    minDiskSpaceGB: parseInteger(
      process.env.MIN_DISK_SPACE_GB,
      defaults.minDiskSpaceGB,
      1,
      1000,
      'MIN_DISK_SPACE_GB'
    ),

    cleanupIntervalHours: parseInteger(
      process.env.CLEANUP_INTERVAL_HOURS,
      defaults.cleanupIntervalHours,
      1,
      720, // Max 30 days
      'CLEANUP_INTERVAL_HOURS'
    ),

    cleanupCronExpression: process.env.CLEANUP_CRON_EXPRESSION || defaults.cleanupCronExpression,

    cleanupDeleteSessions: parseBoolean(
      process.env.CLEANUP_DELETE_SESSIONS,
      defaults.cleanupDeleteSessions
    ),

    enableAutoCleanup: parseBoolean(
      process.env.ENABLE_AUTO_CLEANUP,
      defaults.enableAutoCleanup
    ),

    enableScheduledCleanup: parseBoolean(
      process.env.ENABLE_SCHEDULED_CLEANUP,
      defaults.enableScheduledCleanup
    ),
  };

  return config;
}

/**
 * Validate cleanup configuration and log warnings
 *
 * @param config The configuration to validate
 * @returns true if valid, false if there are critical errors
 */
export function validateCleanupConfig(config: CleanupConfig): boolean {
  let isValid = true;

  // Check workspace base is set
  if (!config.workspaceBase) {
    logger.error('WORKSPACE_BASE is required but not set');
    isValid = false;
  }

  // Check archive directory if archiving is enabled
  if (config.archiveWorkspaces && !config.archiveDir) {
    logger.error('ARCHIVE_DIR is required when ARCHIVE_WORKSPACES is enabled');
    isValid = false;
  }

  // Validate cron expression format (basic check)
  const cronParts = config.cleanupCronExpression.split(' ');
  if (cronParts.length < 5 || cronParts.length > 6) {
    logger.warn(`Invalid CLEANUP_CRON_EXPRESSION: ${config.cleanupCronExpression}, using default`);
    config.cleanupCronExpression = defaults.cleanupCronExpression;
  }

  // Log configuration summary
  logger.info('Cleanup configuration loaded', {
    workspaceBase: config.workspaceBase,
    archiveWorkspaces: config.archiveWorkspaces,
    maxWorkspaces: config.maxWorkspaces,
    minDiskSpaceGB: config.minDiskSpaceGB,
    cleanupIntervalHours: config.cleanupIntervalHours,
    enableAutoCleanup: config.enableAutoCleanup,
    enableScheduledCleanup: config.enableScheduledCleanup,
  });

  return isValid;
}

// Singleton configuration instance
let configInstance: CleanupConfig | null = null;

/**
 * Get the cleanup configuration (singleton)
 *
 * @returns The cleanup configuration
 */
export function getCleanupConfig(): CleanupConfig {
  if (!configInstance) {
    configInstance = loadCleanupConfig();
  }
  return configInstance;
}

/**
 * Reset configuration (for testing)
 */
export function resetCleanupConfig(): void {
  configInstance = null;
}
