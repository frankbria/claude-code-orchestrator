// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';
import { validateApiKey, ApiKey } from '../db/queries';

// Extend Express Request to include apiKey
declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKey;
    }
  }
}

/**
 * Check if the application is running in production mode
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Check if CLAUDE_HOOK_SECRET is configured
 */
export function isHookSecretConfigured(): boolean {
  return !!process.env.CLAUDE_HOOK_SECRET;
}

/**
 * Validate that required secrets are configured for production
 * Call this during server startup to fail fast if misconfigured
 */
export function validateProductionSecrets(): { valid: boolean; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isHookSecretConfigured()) {
    if (isProduction()) {
      errors.push('CLAUDE_HOOK_SECRET must be set in production mode');
    } else {
      warnings.push('CLAUDE_HOOK_SECRET not set - hook endpoints are unauthenticated (acceptable in development)');
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors
  };
}

/**
 * Creates an API key authentication middleware
 * Validates the x-api-key header against the database
 */
export function createApiKeyAuth(db: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'];

    // Unified error response to prevent timing attacks
    const unauthorizedResponse = () => {
      res.status(401).json({
        error: 'Invalid or missing API key',
        code: 'INVALID_API_KEY'
      });
    };

    if (!apiKey || typeof apiKey !== 'string') {
      unauthorizedResponse();
      return;
    }

    try {
      const keyRecord = await validateApiKey(db, apiKey);

      if (!keyRecord) {
        unauthorizedResponse();
        return;
      }

      // Attach the API key info to the request for downstream use
      req.apiKey = keyRecord;
      next();
    } catch (error) {
      console.error('API key validation error:', error);
      res.status(500).json({
        error: 'Authentication service error',
        code: 'AUTH_SERVICE_ERROR'
      });
    }
  };
}

/**
 * Creates a hook authentication middleware using a shared secret
 * Validates the x-hook-secret header against an environment variable
 */
export function createHookAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hookSecret = process.env.CLAUDE_HOOK_SECRET;

    // If no hook secret is configured, allow all requests (development mode)
    if (!hookSecret) {
      console.warn('CLAUDE_HOOK_SECRET not set - hook endpoints are unauthenticated. Set this in production!');
      next();
      return;
    }

    const providedSecret = req.headers['x-hook-secret'];

    if (!providedSecret || typeof providedSecret !== 'string') {
      res.status(401).json({
        error: 'Invalid hook secret',
        code: 'INVALID_HOOK_SECRET'
      });
      return;
    }

    // Use constant-time comparison to prevent timing attacks
    try {
      const providedBuffer = Buffer.from(providedSecret);
      const secretBuffer = Buffer.from(hookSecret);
      
      // Ensure buffers are same length to use timingSafeEqual
      if (providedBuffer.length !== secretBuffer.length) {
        res.status(401).json({
          error: 'Invalid hook secret',
          code: 'INVALID_HOOK_SECRET'
        });
        return;
      }

      if (!crypto.timingSafeEqual(providedBuffer, secretBuffer)) {
        res.status(401).json({
          error: 'Invalid hook secret',
          code: 'INVALID_HOOK_SECRET'
        });
        return;
      }

      next();
    } catch (error) {
      res.status(401).json({
        error: 'Invalid hook secret',
        code: 'INVALID_HOOK_SECRET'
      });
    }
  };
}

/**
 * Creates a strict hook authentication middleware that ALWAYS requires authentication.
 * Unlike createHookAuth(), this middleware does NOT fall back to permissive mode
 * when CLAUDE_HOOK_SECRET is not set. Use this for sensitive endpoints like /metrics
 * that could leak operational information.
 *
 * If CLAUDE_HOOK_SECRET is not configured, requests are rejected with 503 Service Unavailable
 * to indicate the endpoint is not properly configured rather than a client auth error.
 */
export function createStrictHookAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hookSecret = process.env.CLAUDE_HOOK_SECRET;

    // Reject if hook secret is not configured - this endpoint requires authentication
    if (!hookSecret) {
      res.status(503).json({
        error: 'Endpoint not available - authentication not configured',
        code: 'AUTH_NOT_CONFIGURED',
        hint: isProduction()
          ? 'Contact administrator to configure CLAUDE_HOOK_SECRET'
          : 'Set CLAUDE_HOOK_SECRET environment variable to enable this endpoint'
      });
      return;
    }

    const providedSecret = req.headers['x-hook-secret'];

    if (!providedSecret || typeof providedSecret !== 'string') {
      res.status(401).json({
        error: 'Authentication required',
        code: 'MISSING_HOOK_SECRET'
      });
      return;
    }

    // Use constant-time comparison to prevent timing attacks
    try {
      const providedBuffer = Buffer.from(providedSecret);
      const secretBuffer = Buffer.from(hookSecret);

      // Ensure buffers are same length to use timingSafeEqual
      if (providedBuffer.length !== secretBuffer.length) {
        res.status(401).json({
          error: 'Invalid hook secret',
          code: 'INVALID_HOOK_SECRET'
        });
        return;
      }

      if (!crypto.timingSafeEqual(providedBuffer, secretBuffer)) {
        res.status(401).json({
          error: 'Invalid hook secret',
          code: 'INVALID_HOOK_SECRET'
        });
        return;
      }

      next();
    } catch (error) {
      res.status(401).json({
        error: 'Invalid hook secret',
        code: 'INVALID_HOOK_SECRET'
      });
    }
  };
}
