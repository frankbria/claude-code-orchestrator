// src/metrics.ts
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

// Create a custom registry for all metrics
export const register = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register });

/**
 * Counter for hooks received
 * Labels: tool (e.g., 'bash', 'read', 'write'), status ('completed', 'error')
 */
export const hooksReceivedTotal = new Counter({
  name: 'hooks_received_total',
  help: 'Total number of hooks received from Claude Code',
  labelNames: ['tool', 'status'] as const,
  registers: [register],
});

/**
 * Gauge for active sessions
 * Updated periodically by scheduled job
 */
export const sessionsActive = new Gauge({
  name: 'sessions_active',
  help: 'Current number of active sessions',
  registers: [register],
});

/**
 * Histogram for API request latency
 * Labels: route, method, status
 * Buckets optimized for API response times
 */
export const apiRequestDuration = new Histogram({
  name: 'api_request_duration_ms',
  help: 'API request duration in milliseconds',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

/**
 * Gauge for available disk space in bytes
 * Updated periodically by scheduled job
 */
export const diskSpaceAvailableBytes = new Gauge({
  name: 'disk_space_available_bytes',
  help: 'Available disk space in bytes on workspace volume',
  registers: [register],
});

/**
 * Gauge for active database connections
 */
export const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections in the pool',
  registers: [register],
});

/**
 * Gauge for idle database connections
 */
export const dbConnectionsIdle = new Gauge({
  name: 'db_connections_idle',
  help: 'Number of idle database connections in the pool',
  registers: [register],
});

/**
 * Gauge for total database connections
 */
export const dbConnectionsTotal = new Gauge({
  name: 'db_connections_total',
  help: 'Total number of database connections in the pool',
  registers: [register],
});

/**
 * Gauge for workspace count
 */
export const workspacesCount = new Gauge({
  name: 'workspaces_count',
  help: 'Current number of workspace directories',
  registers: [register],
});

/**
 * Counter for session state changes
 * Labels: from_status, to_status
 */
export const sessionStateChanges = new Counter({
  name: 'session_state_changes_total',
  help: 'Total number of session state changes',
  labelNames: ['from_status', 'to_status'] as const,
  registers: [register],
});

/**
 * Counter for retry daemon operations
 * Labels: operation ('retry_success', 'retry_failed', 'dead_letter')
 */
export const retryDaemonOperations = new Counter({
  name: 'retry_daemon_operations_total',
  help: 'Total retry daemon operations',
  labelNames: ['operation'] as const,
  registers: [register],
});

/**
 * Gauge for retry daemon pending count
 */
export const retryDaemonPending = new Gauge({
  name: 'retry_daemon_pending',
  help: 'Number of pending retries in the retry daemon',
  registers: [register],
});

/**
 * Gauge for retry daemon dead letter count
 */
export const retryDaemonDeadLetter = new Gauge({
  name: 'retry_daemon_dead_letter',
  help: 'Number of events in dead letter queue',
  registers: [register],
});

/**
 * Counter for cleanup job operations
 * Labels: operation ('session_cleaned', 'workspace_deleted', 'error')
 */
export const cleanupJobOperations = new Counter({
  name: 'cleanup_job_operations_total',
  help: 'Total cleanup job operations',
  labelNames: ['operation'] as const,
  registers: [register],
});

/**
 * Histogram for hook delivery latency (time from event to storage)
 */
export const hookDeliveryLatency = new Histogram({
  name: 'hook_delivery_latency_ms',
  help: 'Time from hook event timestamp to storage in milliseconds',
  labelNames: ['tool'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});
