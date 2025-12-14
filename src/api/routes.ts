// src/api/routes.ts
import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey,
  getSessionById,
  updateSessionWithVersion,
  VersionConflictError,
  SessionStatus,
  SessionUpdatePayload,
  mergeSessionMetadata,
} from '../db/queries';
import { updateSessionWithRetry } from '../db/retry';
import { WorkspaceManager } from '../services/workspace';
import {
  validateSessionCreate,
  workspaceCreationLimiter,
  addRequestId
} from '../middleware/validation';
import { createLogger } from '../utils/logger';
import { getCleanupConfig } from '../config/cleanup';
import { getBlobStorage, BlobStorageError } from '../services/blobStorage';

const apiLogger = createLogger('api');
const cleanupLogger = createLogger('cleanup');

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
      `SELECT id, session_id, tool, input, result, status, duration_ms, timestamp,
              blob_uri, result_size_bytes
       FROM command_logs
       WHERE session_id = $1
       ORDER BY timestamp DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json(logs.rows);
  });

  // Get full output for a specific command log entry
  // Returns the full result content, either from inline storage or blob storage
  router.get('/sessions/:id/logs/:logId/output', async (req, res) => {
    const requestId = (req as any).id;

    try {
      // Get the log entry
      const result = await db.query(
        `SELECT id, session_id, tool, result, blob_uri, result_size_bytes
         FROM command_logs
         WHERE id = $1 AND session_id = $2`,
        [req.params.logId, req.params.id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Log entry not found',
          code: 'LOG_NOT_FOUND',
        });
        return;
      }

      const log = result.rows[0];

      // If blob_uri is present, retrieve from blob storage
      if (log.blob_uri) {
        try {
          const blobStorage = getBlobStorage();
          const stream = await blobStorage.getStream(log.blob_uri);

          // Set response headers for streaming
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline');
          if (log.result_size_bytes) {
            res.setHeader('X-Original-Size', log.result_size_bytes.toString());
          }

          // Pipe the stream to the response
          stream.pipe(res);

          stream.on('error', (error) => {
            apiLogger.error('Error streaming blob content', {
              requestId,
              logId: req.params.logId,
              blobUri: log.blob_uri,
              error: error.message,
            });
            // If headers haven't been sent, send an error response
            if (!res.headersSent) {
              res.status(500).json({
                error: 'Failed to retrieve blob content',
                code: 'BLOB_STREAM_ERROR',
              });
            }
          });

          apiLogger.info('Streaming blob content', {
            requestId,
            logId: req.params.logId,
            sessionId: req.params.id,
            blobUri: log.blob_uri,
            resultSizeBytes: log.result_size_bytes,
          });
        } catch (blobError) {
          apiLogger.error('Failed to retrieve blob', {
            requestId,
            logId: req.params.logId,
            blobUri: log.blob_uri,
            error: blobError instanceof BlobStorageError
              ? blobError.message
              : (blobError as Error).message,
          });

          res.status(500).json({
            error: 'Failed to retrieve blob content',
            code: 'BLOB_RETRIEVAL_ERROR',
            details: blobError instanceof BlobStorageError
              ? blobError.operation
              : undefined,
          });
        }
        return;
      }

      // If no blob_uri, return inline result
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline');
      if (log.result_size_bytes) {
        res.setHeader('X-Original-Size', log.result_size_bytes.toString());
      }

      res.send(log.result || '');

      apiLogger.info('Returning inline result', {
        requestId,
        logId: req.params.logId,
        sessionId: req.params.id,
        resultLength: log.result?.length || 0,
      });
    } catch (error) {
      apiLogger.error('Failed to get log output', {
        requestId,
        logId: req.params.logId,
        sessionId: req.params.id,
        error: (error as Error).message,
      });

      res.status(500).json({
        error: 'Failed to retrieve log output',
        code: 'LOG_OUTPUT_ERROR',
      });
    }
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
      `SELECT id, project_path, project_type, status, created_at, updated_at, version
       FROM sessions
       ORDER BY updated_at DESC`
    );
    res.json(sessions.rows);
  });

  // Get single session by ID
  router.get('/sessions/:id', async (req, res) => {
    const session = await getSessionById(db, req.params.id);
    if (!session) {
      res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
      return;
    }
    res.json(session);
  });

  // Update session status and/or metadata
  // Supports optimistic locking via optional 'version' parameter
  // Metadata merging: provided metadata is merged into existing metadata (not replaced)
  router.patch('/sessions/:id', async (req, res) => {
    const { status, claudeSessionId, version, metadata } = req.body;
    const requestId = (req as any).id;
    const cleanupConfig = getCleanupConfig();

    // Check if this is a terminal status that should trigger cleanup
    const isTerminalStatus = status === 'completed' || status === 'error';

    try {
      // If version is provided, use optimistic locking
      if (version !== undefined) {
        const expectedVersion = parseInt(version, 10);
        if (isNaN(expectedVersion) || expectedVersion < 1) {
          res.status(400).json({
            error: 'Invalid version number',
            code: 'INVALID_VERSION'
          });
          return;
        }

        // Build update payload
        const updates: SessionUpdatePayload = {};
        if (status) updates.status = status as SessionStatus;
        if (claudeSessionId) updates.claude_session_id = claudeSessionId;

        try {
          const newVersion = await updateSessionWithVersion(
            db,
            req.params.id,
            updates,
            expectedVersion
          );

          // Best-effort metadata merge in optimistic-locking path
          // Note: mergeSessionMetadata may increment version via triggers,
          // so we refetch to get the actual current version
          if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
            try {
              await mergeSessionMetadata(db, req.params.id, metadata);
              apiLogger.info('Session metadata merged (versioned path)', {
                requestId,
                sessionId: req.params.id,
                metadataKeys: Object.keys(metadata),
              });
            } catch (error) {
              apiLogger.error('Failed to merge session metadata', {
                requestId,
                sessionId: req.params.id,
                error: (error as Error).message,
              });
              // Don't fail the request - metadata merge is best-effort
            }
          }

          // Fetch updated session for cleanup check and to get actual version
          const session = await getSessionById(db, req.params.id);

          // Trigger cleanup if applicable
          if (isTerminalStatus && cleanupConfig.enableAutoCleanup && session) {
            triggerAsyncCleanup(workspaceManager, session, status, requestId, cleanupLogger);
          }

          res.json({
            status: 'updated',
            version: session?.version ?? newVersion
          });
          return;
        } catch (error) {
          if (error instanceof VersionConflictError) {
            // Get current session to provide actual version
            const currentSession = await getSessionById(db, req.params.id);
            res.status(409).json({
              error: 'Version conflict - session was modified by another process',
              code: 'VERSION_CONFLICT',
              expectedVersion,
              actualVersion: currentSession?.version,
              hint: 'Refetch the session and retry with the current version'
            });
            return;
          }
          throw error;
        }
      }

      // Legacy behavior: update without version check (backward compatible)
      if (claudeSessionId) {
        await db.query(
          `UPDATE sessions SET claude_session_id = $1 WHERE id = $2`,
          [claudeSessionId, req.params.id]
        );
      }

      if (status) {
        await db.query(
          `UPDATE sessions SET status = $1 WHERE id = $2`,
          [status, req.params.id]
        );

        // Trigger automatic cleanup if enabled and status is terminal
        if (isTerminalStatus && cleanupConfig.enableAutoCleanup) {
          try {
            const session = await getSessionById(db, req.params.id);
            if (session) {
              triggerAsyncCleanup(workspaceManager, session, status, requestId, cleanupLogger);
            }
          } catch (error) {
            cleanupLogger.error('Failed to trigger workspace cleanup', {
              requestId,
              sessionId: req.params.id,
              error: (error as Error).message,
            });
          }
        }
      }

      // Merge metadata if provided (does not overwrite existing keys unless explicitly set)
      // Strict validation: must be a plain object (not null, not array)
      if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
        try {
          await mergeSessionMetadata(db, req.params.id, metadata);
          apiLogger.info('Session metadata merged', {
            requestId,
            sessionId: req.params.id,
            metadataKeys: Object.keys(metadata),
          });
        } catch (error) {
          apiLogger.error('Failed to merge session metadata', {
            requestId,
            sessionId: req.params.id,
            error: (error as Error).message,
          });
          // Don't fail the request - metadata merge is best-effort
        }
      }

      // Get updated session to return version
      const updatedSession = await getSessionById(db, req.params.id);
      res.json({
        status: 'updated',
        version: updatedSession?.version
      });
    } catch (error) {
      apiLogger.error('Session update failed', {
        requestId,
        sessionId: req.params.id,
        error: (error as Error).message
      });
      res.status(500).json({
        error: 'Session update failed',
        code: 'UPDATE_ERROR'
      });
    }
  });

  // Helper function to trigger async cleanup
  function triggerAsyncCleanup(
    manager: WorkspaceManager,
    session: { id: string; project_path: string },
    status: string,
    requestId: string,
    logger: ReturnType<typeof createLogger>
  ) {
    if (session.project_path.startsWith('e2b://')) {
      logger.info('Skipping cleanup for E2B sandbox', {
        requestId,
        sessionId: session.id,
      });
      return;
    }

    manager.cleanup(session.project_path, requestId)
      .then(() => {
        logger.info('Workspace cleanup completed', {
          requestId,
          sessionId: session.id,
          projectPath: session.project_path,
          status,
        });
      })
      .catch((error: Error) => {
        logger.error('Workspace cleanup failed', {
          requestId,
          sessionId: session.id,
          projectPath: session.project_path,
          error: error.message,
        });
      });
  }

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

  // NOTE: Heartbeat endpoint moved to hooks.ts (POST /api/hooks/sessions/:id/heartbeat)
  // This allows Claude Code hooks to authenticate via x-hook-secret header
  // rather than requiring API key authentication

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
