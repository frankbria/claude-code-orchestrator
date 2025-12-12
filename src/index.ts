// src/index.ts
import express from 'express';
import { Pool } from 'pg';
import { createRouter } from './api/routes';
import { createHookRouter } from './api/hooks';
import { createApiKeyAuth, createHookAuth } from './middleware/auth';

// Load environment variables
import 'dotenv/config';

const app = express();
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Create authentication middleware
const apiKeyAuth = createApiKeyAuth(db);
const hookAuth = createHookAuth();

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Hook endpoints - use optional shared secret auth (for Claude Code hooks)
// These are mounted BEFORE the authenticated routes to ensure /api/hooks/* is not affected by apiKeyAuth
app.use('/api/hooks', hookAuth, createHookRouter(db));

// All other API routes require API key authentication
app.use('/api', apiKeyAuth, createRouter(db));

const port = process.env.API_PORT || 3001;

app.listen(port, () => {
  console.log(`Claude Orchestrator API running on :${port}`);
});
