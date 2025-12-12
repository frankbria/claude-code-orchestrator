// src/api/hooks.ts
import express from 'express';
import { Pool } from 'pg';

export function createHookRouter(db: Pool) {
  const router = express.Router();

  // Receives POST from Claude Code postToolUse hook
  router.post('/tool-complete', async (req, res) => {
    const { session, tool, result } = req.body;
    
    await db.query(
      `INSERT INTO command_logs (session_id, tool, result, status, timestamp)
       VALUES ($1, $2, $3, 'completed', NOW())`,
      [session, tool, result]
    );
    
    // Update session's last activity
    await db.query(
      `UPDATE sessions SET updated_at = NOW() WHERE claude_session_id = $1`,
      [session]
    );
    
    res.sendStatus(200);
  });

  // Receives notifications from Claude Code
  router.post('/notification', async (req, res) => {
    const { session, message } = req.body;
    
    await db.query(
      `INSERT INTO session_messages (session_id, direction, content, source)
       SELECT id, 'system', $2, 'claude-hook'
       FROM sessions WHERE claude_session_id = $1`,
      [session, message]
    );
    
    res.sendStatus(200);
  });

  return router;
}
