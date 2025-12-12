// src/api/routes.ts
import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey
} from '../db/queries';
import { WorkspaceManager } from '../services/workspace';
import {
  validateSessionCreate,
  workspaceCreationLimiter,
  addRequestId
} from '../middleware/validation';
import { createLogger } from '../utils/logger';

const apiLogger = createLogger('api');

/**
 * Middleware to require admin privileges
 * Checks if the authenticated API key has admin=true in metadata
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'MISSING_AUTH'
    });
    return;
  }

  const isAdmin = req.apiKey.metadata?.admin === true;
  
  if (!isAdmin) {
    res.status(403).json({
      error: 'Admin privileges required',
      code: 'INSUFFICIENT_PERMISSIONS'
    });
    return;
  }

  next();
}

export function createRouter(db: Pool) {
  const router = express.Router();

  // Initialize WorkspaceManager for secure workspace operations
  const workspaceManager = new WorkspaceManager();

  // Add request ID to all routes for audit trail correlation
  router.use(addRequestId);

  // Create new session (called by n8n)
  // SECURITY: Rate limited and validated before processing
  router.post('/sessions',
    workspaceCreationLimiter,  // Rate limit: 10 req/15min per IP
    validateSessionCreate,     // Validate and sanitize inputs
    async (req, res) => {
      const { projectType, projectPath, githubRepo, initialPrompt, slackChannel } = req.body;
      const requestId = (req as any).id;

      try {
        apiLogger.info('Session creation started', {
          requestId,
          projectType,
          timestamp: new Date().toISOString(),
        });

        // Prepare workspace with full security validation
        // This replaces the vulnerable direct path/execSync usage
        const workspacePath = await workspaceManager.prepareWorkspace({
          projectType,
          projectPath,
          githubRepo,
          basePath: projectPath, // For worktree type
        }, requestId);

        // Create session record
        const result = await db.query(
          `INSERT INTO sessions (project_path, project_type, metadata)
           VALUES ($1, $2, $3) RETURNING id`,
          [workspacePath, projectType, JSON.stringify({
            initialPrompt,
            slackChannel,
            requestId,
            createdAt: new Date().toISOString(),
          })]
        );

        const sessionId = result.rows[0].id;

        // Log the initial prompt
        await db.query(
          `INSERT INTO session_messages (session_id, direction, content, source)
           VALUES ($1, 'user', $2, 'n8n')`,
          [sessionId, initialPrompt]
        );

        apiLogger.info('Session created successfully', {
          requestId,
          sessionId,
          timestamp: new Date().toISOString(),
        });

        res.status(201).json({
          sessionId,
          workspacePath,
          status: 'created',
          requestId,
        });
      } catch (error) {
        apiLogger.error('Session creation failed', {
          requestId,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });

        // Generic error message to client (details logged server-side)
        res.status(400).json({
          error: 'Session creation failed',
          details: 'Invalid request',
          requestId,
        });
      }
    }
  );

  // Get session logs (dashboard polling endpoint)
  router.get('/sessions/:id/logs', async (req, res) => {
    const logs = await db.query(
      `SELECT * FROM command_logs 
       WHERE session_id = $1 
       ORDER BY timestamp DESC 
       LIMIT 50`,
      [req.params.id]
    );
    res.json(logs.rows);
  });

  // Get session messages
  router.get('/sessions/:id/messages', async (req, res) => {
    const messages = await db.query(
      `SELECT * FROM session_messages 
       WHERE session_id = $1 
       ORDER BY timestamp ASC`,
      [req.params.id]
    );
    res.json(messages.rows);
  });

  // List all sessions
  router.get('/sessions', async (req, res) => {
    const sessions = await db.query(
      `SELECT id, project_path, project_type, status, created_at, updated_at
       FROM sessions 
       ORDER BY updated_at DESC`
    );
    res.json(sessions.rows);
  });

  // Update session status
  router.patch('/sessions/:id', async (req, res) => {
    const { status, claudeSessionId } = req.body;
    
    if (claudeSessionId) {
      await db.query(
        `UPDATE sessions SET claude_session_id = $1, updated_at = NOW() WHERE id = $2`,
        [claudeSessionId, req.params.id]
      );
    }
    
    if (status) {
      await db.query(
        `UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, req.params.id]
      );
    }
    
    res.json({ status: 'updated' });
  });

  // Log a message (from Slack/n8n continuation)
  router.post('/sessions/:id/messages', async (req, res) => {
    const { direction, content, source } = req.body;
    
    await db.query(
      `INSERT INTO session_messages (session_id, direction, content, source)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, direction, content, source]
    );
    
    res.json({ status: 'logged' });
  });

  // ============================================
  // Admin API Key Management Endpoints
  // ============================================

  // Create a new API key
  router.post('/admin/keys', requireAdmin, async (req, res) => {
    try {
      const { name, metadata = {} } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({
          error: 'Name is required',
          code: 'MISSING_NAME'
        });
        return;
      }

      // Validate metadata is an object
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        res.status(400).json({
          error: 'Metadata must be a valid object',
          code: 'INVALID_METADATA'
        });
        return;
      }

      // Sanitize metadata - only allow safe types and reasonable sizes
      const sanitizedMetadata: Record<string, any> = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof key !== 'string' || key.length > 100) {
          res.status(400).json({
            error: 'Metadata keys must be strings with max 100 characters',
            code: 'INVALID_METADATA_KEY'
          });
          return;
        }
        
        const valueType = typeof value;
        if (!['string', 'number', 'boolean'].includes(valueType)) {
          res.status(400).json({
            error: 'Metadata values must be strings, numbers, or booleans',
            code: 'INVALID_METADATA_VALUE'
          });
          return;
        }
        
        if (valueType === 'string' && (value as string).length > 1000) {
          res.status(400).json({
            error: 'Metadata string values must be less than 1000 characters',
            code: 'METADATA_VALUE_TOO_LONG'
          });
          return;
        }
        
        sanitizedMetadata[key] = value;
      }

      const apiKey = await createApiKey(db, name, sanitizedMetadata);

      // Return the full key only on creation (this is the only time it's visible)
      res.status(201).json({
        id: apiKey.id,
        key: apiKey.key,
        name: apiKey.name,
        created_at: apiKey.created_at,
        message: 'Store this key securely. It will not be shown again.'
      });
    } catch (error) {
      console.error('Error creating API key:', error);
      res.status(500).json({
        error: 'Failed to create API key',
        code: 'CREATE_KEY_ERROR'
      });
    }
  });

  // List all API keys (without exposing key values)
  router.get('/admin/keys', requireAdmin, async (req, res) => {
    try {
      const keys = await listApiKeys(db);
      res.json(keys);
    } catch (error) {
      console.error('Error listing API keys:', error);
      res.status(500).json({
        error: 'Failed to list API keys',
        code: 'LIST_KEYS_ERROR'
      });
    }
  });

  // Get a single API key by ID
  router.get('/admin/keys/:id', requireAdmin, async (req, res) => {
    try {
      const key = await getApiKeyById(db, req.params.id);

      if (!key) {
        res.status(404).json({
          error: 'API key not found',
          code: 'KEY_NOT_FOUND'
        });
        return;
      }

      res.json(key);
    } catch (error) {
      console.error('Error getting API key:', error);
      res.status(500).json({
        error: 'Failed to get API key',
        code: 'GET_KEY_ERROR'
      });
    }
  });

  // Revoke an API key (soft delete - sets active = false)
  router.patch('/admin/keys/:id/revoke', requireAdmin, async (req, res) => {
    try {
      const revoked = await revokeApiKey(db, req.params.id);

      if (!revoked) {
        res.status(404).json({
          error: 'API key not found',
          code: 'KEY_NOT_FOUND'
        });
        return;
      }

      res.json({ status: 'revoked', id: req.params.id });
    } catch (error) {
      console.error('Error revoking API key:', error);
      res.status(500).json({
        error: 'Failed to revoke API key',
        code: 'REVOKE_KEY_ERROR'
      });
    }
  });

  // Delete an API key permanently
  router.delete('/admin/keys/:id', requireAdmin, async (req, res) => {
    try {
      const deleted = await deleteApiKey(db, req.params.id);

      if (!deleted) {
        res.status(404).json({
          error: 'API key not found',
          code: 'KEY_NOT_FOUND'
        });
        return;
      }

      res.json({ status: 'deleted', id: req.params.id });
    } catch (error) {
      console.error('Error deleting API key:', error);
      res.status(500).json({
        error: 'Failed to delete API key',
        code: 'DELETE_KEY_ERROR'
      });
    }
  });

  return router;
}
