// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
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
 * Creates an API key authentication middleware
 * Validates the x-api-key header against the database
 */
export function createApiKeyAuth(db: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      res.status(401).json({
        error: 'API key required',
        code: 'MISSING_API_KEY'
      });
      return;
    }

    try {
      const keyRecord = await validateApiKey(db, apiKey);

      if (!keyRecord) {
        res.status(401).json({
          error: 'Invalid API key',
          code: 'INVALID_API_KEY'
        });
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
      next();
      return;
    }

    const providedSecret = req.headers['x-hook-secret'];

    if (!providedSecret || providedSecret !== hookSecret) {
      res.status(401).json({
        error: 'Invalid hook secret',
        code: 'INVALID_HOOK_SECRET'
      });
      return;
    }

    next();
  };
}
