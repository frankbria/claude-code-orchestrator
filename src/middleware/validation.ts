import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { validateWorkspacePath, isAllowedPath } from '../utils/pathValidation';
import { createLogger } from '../utils/logger';

const securityLogger = createLogger('security');

/**
 * Rate limiter for workspace creation endpoints
 * CRITICAL SECURITY FIX #7: Prevents abuse and DoS attacks
 *
 * Configuration:
 * - 15-minute sliding window
 * - Maximum 10 requests per IP
 * - Security logging for violations
 *
 * @remarks
 * This middleware should be applied to all workspace creation endpoints
 * to prevent attackers from exhausting system resources through repeated
 * malicious workspace creation attempts.
 */
export const workspaceCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window
  message: 'Too many workspace creation requests',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    securityLogger.warn('Rate limit exceeded for workspace creation', {
      ip: req.ip,
      requestId: (req as any).id,
      timestamp: new Date().toISOString(),
    });

    res.status(429).json({
      error: 'Too many requests',
      details: 'Please try again later',
    });
  },
});

/**
 * Validate session creation request with comprehensive security checks
 * CRITICAL SECURITY: Multi-layer input validation and sanitization
 *
 * Security Features:
 * - Project type allowlist enforcement
 * - GitHub repository format validation (prevents command injection)
 * - Path traversal detection (../ sequences)
 * - Null byte injection prevention (\0)
 * - Path allowlist validation
 * - Security event logging with request correlation
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 *
 * @remarks
 * This middleware implements defense-in-depth by validating inputs
 * BEFORE they reach the WorkspaceManager service. It prevents:
 *
 * - Path traversal attacks (../../etc/passwd)
 * - Command injection in GitHub repo names
 * - Null byte injection attacks
 * - Directory traversal using dots bypass
 * - TOCTOU race conditions (via early validation)
 *
 * All validation failures are logged for security monitoring and
 * incident response. Error messages are intentionally generic to
 * prevent information disclosure.
 *
 * @example
 * ```typescript
 * router.post('/sessions',
 *   workspaceCreationLimiter,
 *   validateSessionCreate,
 *   async (req, res) => {
 *     // Request has been validated and sanitized
 *     const workspace = await workspaceManager.prepareWorkspace(req.body);
 *   }
 * );
 * ```
 */
export async function validateSessionCreate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { projectType, projectPath, githubRepo, basePath } = req.body;
  const requestId = (req as any).id;

  // Validate project type against allowlist
  const allowedTypes = ['github', 'local', 'e2b', 'worktree'];
  if (!allowedTypes.includes(projectType)) {
    securityLogger.warn('Invalid project type', {
      projectType,
      requestId,
      timestamp: new Date().toISOString(),
    });

    res.status(400).json({
      error: 'Invalid request',
      details: 'Project type not allowed',
    });
    return;
  }

  // Type-specific validation with security hardening
  try {
    switch (projectType) {
      case 'github':
        // CRITICAL FIX #4: Enhanced GitHub repo validation
        // Prevents: command injection, path traversal, dots bypass
        if (!githubRepo || typeof githubRepo !== 'string') {
          throw new Error('GitHub repository required');
        }

        // Strict regex validation: owner/repo format
        // - Must start with alphanumeric
        // - Can contain alphanumeric, hyphens, underscores
        // - Can contain dots in repo name (but not consecutive)
        // - Must end with alphanumeric
        if (!/^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*[a-zA-Z0-9]$/.test(githubRepo)) {
          throw new Error('Invalid repository format');
        }

        // Prevent ".." sequences (dots bypass attack)
        if (githubRepo.includes('..')) {
          securityLogger.warn('Path traversal attempt in GitHub repo name', {
            requestId,
            timestamp: new Date().toISOString(),
          });
          throw new Error('Invalid repository format');
        }
        break;

      case 'local': {
        // Validate local path with multiple security layers
        if (!projectPath || typeof projectPath !== 'string') {
          throw new Error('Project path required');
        }

        // Layer 1: Prevent obviously malicious paths
        // - Path traversal sequences (..)
        // - Null byte injection (\0)
        if (projectPath.includes('..') || projectPath.includes('\0')) {
          securityLogger.warn('Malicious path detected', {
            attack: projectPath.includes('\0') ? 'null_byte' : 'path_traversal',
            requestId,
            timestamp: new Date().toISOString(),
          });
          throw new Error('Invalid path');
        }

        // Layer 2: Validate path with symlink protection
        // This will throw if path escapes base directory
        const validatedPath = await validateWorkspacePath(projectPath, requestId);

        // Layer 3: Check allowlist (defense-in-depth)
        if (!isAllowedPath(validatedPath)) {
          securityLogger.warn('Path not in allowlist', {
            requestId,
            timestamp: new Date().toISOString(),
          });
          throw new Error('Path not allowed');
        }
        break;
      }

      case 'worktree':
        // Validate base path for git worktree creation
        if (!basePath || typeof basePath !== 'string') {
          throw new Error('Base path required');
        }

        // Prevent path traversal and null byte injection
        if (basePath.includes('..') || basePath.includes('\0')) {
          securityLogger.warn('Malicious base path detected', {
            attack: basePath.includes('\0') ? 'null_byte' : 'path_traversal',
            requestId,
            timestamp: new Date().toISOString(),
          });
          throw new Error('Invalid path');
        }

        // Validate base path exists and is within allowed directory
        await validateWorkspacePath(basePath, requestId);
        break;

      case 'e2b':
        // E2B sandbox - no local path validation needed
        // Workspace creation happens in remote sandbox environment
        break;
    }

    // Validation passed - proceed to next middleware
    securityLogger.info('Session validation passed', {
      projectType,
      requestId,
      timestamp: new Date().toISOString(),
    });

    next();
  } catch (error: any) {
    // Log validation failure for security monitoring
    securityLogger.warn('Session validation failed', {
      projectType,
      error: error.message,
      requestId,
      timestamp: new Date().toISOString(),
    });

    // Generic error message to prevent information disclosure
    res.status(400).json({
      error: 'Invalid request',
      details: 'Validation failed',
    });
  }
}

/**
 * Add unique request ID for correlation across logs and audit trails
 * SECURITY: Enables tracking of request flow through system components
 *
 * The request ID is:
 * - Generated using crypto.randomUUID() for uniqueness
 * - Attached to the request object for use in downstream middleware
 * - Returned in response headers for client-side correlation
 * - Included in all security logs for incident investigation
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 *
 * @remarks
 * This middleware should be applied early in the middleware chain
 * (before other middleware that may need the request ID for logging).
 *
 * Request IDs enable:
 * - Correlation of logs across multiple services
 * - Incident investigation and forensics
 * - Performance monitoring and debugging
 * - Security event tracking
 *
 * @example
 * ```typescript
 * app.use(addRequestId);
 * app.use('/api', router);
 *
 * // In downstream middleware:
 * securityLogger.info('Event', { requestId: req.id });
 * ```
 */
export function addRequestId(req: Request, res: Response, next: NextFunction): void {
  // Use existing request ID if present (e.g., from load balancer)
  // Otherwise generate new UUID
  (req as any).id = (req as any).id || crypto.randomUUID();

  // Add to response headers for client-side correlation
  res.setHeader('X-Request-ID', (req as any).id);

  next();
}
