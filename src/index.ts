// src/index.ts
import express from 'express';
import { Pool } from 'pg';
import { createRouter } from './api/routes';
import { createHookRouter } from './api/hooks';

const app = express();
app.use(express.json());

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use('/api', createRouter(db));
app.use('/api/hooks', createHookRouter(db));

app.listen(3001, () => {
  console.log('Claude Orchestrator API running on :3001');
});
