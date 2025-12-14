// src/middleware/metrics.ts
import { Request, Response, NextFunction } from 'express';
import { apiRequestDuration } from '../metrics';

/**
 * Express middleware to track API request latency.
 * Records duration in milliseconds to the api_request_duration_ms histogram
 * with labels for route, method, and status code.
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip metrics collection for the metrics endpoint itself to avoid noise
  if (req.path === '/api/metrics' || req.path === '/metrics') {
    next();
    return;
  }

  const startTime = process.hrtime.bigint();

  // Listen for response finish to capture timing
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationNs = endTime - startTime;
    const durationMs = Number(durationNs) / 1_000_000;

    // Get route pattern if available (e.g., /api/sessions/:id)
    // Fall back to path if route is not defined
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : normalizeRoute(req.path);

    apiRequestDuration
      .labels({
        route,
        method: req.method,
        status: String(res.statusCode),
      })
      .observe(durationMs);
  });

  next();
}

/**
 * Normalize a path to a route pattern.
 * Replaces UUIDs and numeric IDs with placeholders to reduce cardinality.
 */
function normalizeRoute(path: string): string {
  return path
    // Replace UUIDs (8-4-4-4-12 hex format)
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id'
    )
    // Replace numeric IDs
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}
