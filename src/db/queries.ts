// src/db/queries.ts
import { Pool } from 'pg';
import crypto from 'crypto';

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  metadata: Record<string, unknown>;
}

/**
 * Generate a secure random API key (64 character hex string)
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate an API key and update last_used_at timestamp
 * Returns the API key record if valid, null otherwise
 */
export async function validateApiKey(
  db: Pool,
  key: string
): Promise<ApiKey | null> {
  const result = await db.query(
    `UPDATE api_keys
     SET last_used_at = NOW()
     WHERE key = $1 AND active = true
     RETURNING id, key, name, active, created_at, last_used_at, metadata`,
    [key]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Create a new API key
 */
export async function createApiKey(
  db: Pool,
  name: string,
  metadata: Record<string, unknown> = {}
): Promise<ApiKey> {
  const key = generateApiKey();

  const result = await db.query(
    `INSERT INTO api_keys (key, name, metadata)
     VALUES ($1, $2, $3)
     RETURNING id, key, name, active, created_at, last_used_at, metadata`,
    [key, name, JSON.stringify(metadata)]
  );

  return result.rows[0];
}

/**
 * List all API keys (without exposing the actual key values)
 */
export async function listApiKeys(db: Pool): Promise<ApiKeyInfo[]> {
  const result = await db.query(
    `SELECT id, name, active, created_at, last_used_at, metadata
     FROM api_keys
     ORDER BY created_at DESC`
  );

  return result.rows;
}

/**
 * Get a single API key by ID (without exposing the actual key value)
 */
export async function getApiKeyById(
  db: Pool,
  id: string
): Promise<ApiKeyInfo | null> {
  const result = await db.query(
    `SELECT id, name, active, created_at, last_used_at, metadata
     FROM api_keys
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Revoke an API key (sets active = false)
 */
export async function revokeApiKey(
  db: Pool,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_keys
     SET active = false
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(
  db: Pool,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM api_keys
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rows.length > 0;
}
