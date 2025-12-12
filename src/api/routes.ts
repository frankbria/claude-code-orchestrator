// src/api/routes.ts
import express from 'express';
import { Pool } from 'pg';
import { execSync } from 'child_process';

export function createRouter(db: Pool) {
  const router = express.Router();

  // Create new session (called by n8n)
  router.post('/sessions', async (req, res) => {
    const { projectType, projectPath, githubRepo, initialPrompt, slackChannel } = req.body;
    
    // Prepare workspace based on project type
    let workspacePath = projectPath;
    if (projectType === 'github' && githubRepo) {
      const repoName = githubRepo.split('/').pop()?.replace('.git', '');
      workspacePath = `/tmp/claude-workspaces/${repoName}-${Date.now()}`;
      execSync(`gh repo clone ${githubRepo} ${workspacePath}`);
    }
    
    // Create session record
    const result = await db.query(
      `INSERT INTO sessions (project_path, project_type, metadata)
       VALUES ($1, $2, $3) RETURNING id`,
      [workspacePath, projectType, JSON.stringify({ initialPrompt, slackChannel })]
    );
    
    const sessionId = result.rows[0].id;
    
    // Log the initial prompt
    await db.query(
      `INSERT INTO session_messages (session_id, direction, content, source)
       VALUES ($1, 'user', $2, 'n8n')`,
      [sessionId, initialPrompt]
    );
    
    res.json({ sessionId, workspacePath, status: 'created' });
  });

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

  return router;
}
