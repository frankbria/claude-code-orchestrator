/**
 * Secret Scrubbing Integration Tests
 *
 * End-to-end tests for secret scrubbing in the hook processing pipeline.
 * Tests verify that:
 * - Secrets in tool results are scrubbed before database storage
 * - Secrets in tool inputs are scrubbed before database storage
 * - Secrets in notification messages are scrubbed before database storage
 * - Audit logs are generated when secrets are detected
 * - Idempotency is preserved with scrubbed values
 *
 * @module __tests__/integration/secretScrubbing
 */

import express from 'express';
import request from 'supertest';
import { createHookRouter } from '../../api/hooks';
import { Pool } from 'pg';

// Mock database queries
interface MockQuery {
  text: string;
  values?: any[];
  result: any;
}

// Valid UUID for testing (matches UUID format expected by hooks.ts)
const TEST_SESSION_UUID = '550e8400-e29b-41d4-a716-446655440099';

class MockPool {
  private storedData: {
    commandLogs: any[];
    sessionMessages: any[];
  };
  private sessions: Map<string, { id: string; claude_session_id: string }>;

  constructor() {
    this.storedData = {
      commandLogs: [],
      sessionMessages: [],
    };
    this.sessions = new Map();
    // Add a default test session with a valid UUID
    this.sessions.set(TEST_SESSION_UUID, {
      id: TEST_SESSION_UUID,
      claude_session_id: 'claude-session-abc',
    });
  }

  getStoredData() {
    return this.storedData;
  }

  async query(text: string, values?: any[]): Promise<any> {
    // Handle session lookup by id
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('WHERE id =')) {
      const sessionId = values?.[0];
      const session = this.sessions.get(sessionId);
      if (session) {
        return { rows: [session] };
      }
      return { rows: [] };
    }

    // Handle session lookup by claude_session_id
    if (text.includes('SELECT') && text.includes('FROM sessions') && text.includes('claude_session_id =')) {
      const claudeSessionId = values?.[0];
      for (const session of this.sessions.values()) {
        if (session.claude_session_id === claudeSessionId) {
          return { rows: [session] };
        }
      }
      return { rows: [] };
    }

    // Handle command_logs insert
    if (text.includes('INSERT INTO command_logs')) {
      const log = {
        session_id: values?.[0],
        tool: values?.[1],
        input: values?.[2],
        result: values?.[3],
        duration_ms: values?.[4],
        timestamp: values?.[5],
        event_id: values?.[6],
      };
      this.storedData.commandLogs.push(log);
      return { rows: [log] };
    }

    // Handle session_messages insert
    if (text.includes('INSERT INTO session_messages')) {
      const message = {
        session_id: values?.[0],
        content: values?.[1],
        timestamp: values?.[2],
        event_id: values?.[3],
      };
      this.storedData.sessionMessages.push(message);
      return { rows: [message] };
    }

    // Handle event_id duplicate check
    if (text.includes('SELECT 1 FROM') && text.includes('event_id')) {
      const eventId = values?.[0];
      const exists = this.storedData.commandLogs.some(l => l.event_id === eventId) ||
                     this.storedData.sessionMessages.some(m => m.event_id === eventId);
      return { rows: exists ? [{ '1': 1 }] : [] };
    }

    // Handle session update
    if (text.includes('UPDATE sessions')) {
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe('Secret Scrubbing Integration', () => {
  let app: express.Express;
  let mockPool: MockPool;
  let consoleSpy: jest.SpyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Backup environment
    originalEnv = { ...process.env };
    process.env.SCRUB_SECRETS = 'true';

    // Create mock pool and app
    mockPool = new MockPool();
    app = express();
    app.use(express.json());
    app.use('/api/hooks', createHookRouter(mockPool as unknown as Pool));

    // Spy on console.log for log verification
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    // Restore console
    consoleSpy.mockRestore();
  });

  // ============================================================================
  // Tool Complete Hook Tests
  // ============================================================================

  describe('Tool Complete Hook - Secret Scrubbing', () => {
    test('should scrub secrets from tool result before storage', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440001',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'Output: API_KEY=sk-1234567890abcdefghij1234567890abcdefghij\nDone.',
          durationMs: 100,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs.length).toBe(1);

      const storedResult = storedData.commandLogs[0].result;
      expect(storedResult).not.toContain('sk-1234567890');
      expect(storedResult).toContain('***REDACTED***');
    });

    test('should scrub secrets from tool input (string) before storage', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440002',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          input: 'export GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqrstu678',
          result: 'Token set',
          durationMs: 50,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs.length).toBe(1);

      const storedInput = JSON.parse(storedData.commandLogs[0].input);
      expect(storedInput).not.toContain('ghp_abc123');
      expect(storedInput).toContain('***REDACTED***');
    });

    test('should scrub secrets from tool input (object) before storage', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440003',
          session: TEST_SESSION_UUID,
          tool: 'write',
          input: {
            path: '/home/user/.env',
            content: 'DATABASE_PASSWORD=supersecret123',
          },
          result: 'File written',
          durationMs: 10,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs.length).toBe(1);

      const storedInput = JSON.parse(storedData.commandLogs[0].input);
      expect(storedInput.content).toContain('***REDACTED***');
      expect(storedInput.content).not.toContain('supersecret123');
    });

    test('should scrub database connection strings', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440004',
          session: TEST_SESSION_UUID,
          tool: 'grep',
          result: 'DATABASE_URL=postgresql://admin:secretpassword@db.example.com:5432/production',
          durationMs: 200,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      const storedResult = storedData.commandLogs[0].result;

      expect(storedResult).not.toContain('secretpassword');
      expect(storedResult).toContain('***REDACTED***');
      expect(storedResult).toContain('postgresql://');
    });

    test('should scrub private keys', async () => {
      const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyf8CL7wdPYUvQmE4f6EfT2l8H
verySecretKeyData=
-----END RSA PRIVATE KEY-----`;

      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440005',
          session: TEST_SESSION_UUID,
          tool: 'read',
          result: privateKey,
          durationMs: 5,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      const storedResult = storedData.commandLogs[0].result;

      expect(storedResult).not.toContain('MIIEpAIBAAKCAQEA');
      expect(storedResult).not.toContain('verySecretKeyData');
      expect(storedResult).toContain('***REDACTED***');
      expect(storedResult).toContain('-----BEGIN RSA PRIVATE KEY-----');
    });

    test('should preserve non-sensitive data', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440006',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'Build completed successfully.\nTests passed: 42\nCoverage: 85%',
          durationMs: 5000,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      const storedResult = storedData.commandLogs[0].result;

      expect(storedResult).toBe('Build completed successfully.\nTests passed: 42\nCoverage: 85%');
      expect(storedResult).not.toContain('***REDACTED***');
    });

    test('should handle multiple secrets in same result', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440007',
          session: TEST_SESSION_UUID,
          tool: 'cat',
          result: `
OPENAI_API_KEY=sk-1234567890abcdefghij1234567890ab
SLACK_TOKEN=xoxb-123-456-789
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
          `,
          durationMs: 10,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      const storedResult = storedData.commandLogs[0].result;

      expect(storedResult).not.toContain('sk-1234567890');
      expect(storedResult).not.toContain('xoxb-123-456-789');
      expect(storedResult).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect((storedResult.match(/\*\*\*REDACTED\*\*\*/g) || []).length).toBeGreaterThanOrEqual(3);
    });

    test('should generate audit log when secrets are scrubbed', async () => {
      await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440008',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'API_KEY=sk-1234567890abcdefghij1234567890abcdefghij',
          durationMs: 100,
        });

      // Check that security log was generated
      const securityLogs = consoleSpy.mock.calls.filter((call: any[]) => {
        const logStr = call[0];
        return logStr.includes('security') || logStr.includes('secret-scrubber');
      });

      expect(securityLogs.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Notification Hook Tests
  // ============================================================================

  describe('Notification Hook - Secret Scrubbing', () => {
    test('should scrub secrets from notification message before storage', async () => {
      const response = await request(app)
        .post('/api/hooks/notification')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440010',
          session: TEST_SESSION_UUID,
          message: 'Error: Failed to authenticate with API_KEY=sk-1234567890abcdefghij1234567890ab',
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      expect(storedData.sessionMessages.length).toBe(1);

      const storedContent = storedData.sessionMessages[0].content;
      expect(storedContent).not.toContain('sk-1234567890');
      expect(storedContent).toContain('***REDACTED***');
    });

    test('should preserve non-sensitive notification messages', async () => {
      const response = await request(app)
        .post('/api/hooks/notification')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440011',
          session: TEST_SESSION_UUID,
          message: 'Build completed successfully. All tests passed.',
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      const storedContent = storedData.sessionMessages[0].content;

      expect(storedContent).toBe('Build completed successfully. All tests passed.');
    });
  });

  // ============================================================================
  // Idempotency Tests
  // ============================================================================

  describe('Idempotency with Scrubbed Values', () => {
    test('should detect duplicate events correctly after scrubbing', async () => {
      const eventId = '550e8400-e29b-41d4-a716-446655440020';

      // First request
      const response1 = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId,
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'SECRET=mysecretvalue123',
          durationMs: 100,
        });

      expect(response1.status).toBe(200);
      expect(response1.body.status).toBe('delivered');

      // Second request with same eventId
      const response2 = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId,
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'SECRET=mysecretvalue123',
          durationMs: 100,
        });

      expect(response2.status).toBe(200);
      expect(response2.body.status).toBe('duplicate');

      // Should only have one entry in database
      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs.filter(l => l.event_id === eventId).length).toBe(1);
    });
  });

  // ============================================================================
  // Configuration Tests
  // ============================================================================

  describe('Scrubbing Configuration', () => {
    test('should not scrub when SCRUB_SECRETS=false', async () => {
      process.env.SCRUB_SECRETS = 'false';

      // Create new app with updated config
      const newMockPool = new MockPool();
      const newApp = express();
      newApp.use(express.json());
      newApp.use('/api/hooks', createHookRouter(newMockPool as unknown as Pool));

      const response = await request(newApp)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440030',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'API_KEY=sk-1234567890abcdefghij1234567890ab',
          durationMs: 100,
        });

      expect(response.status).toBe(200);

      const storedData = newMockPool.getStoredData();
      const storedResult = storedData.commandLogs[0].result;

      // Should NOT be scrubbed
      expect(storedResult).toContain('sk-1234567890');
      expect(storedResult).not.toContain('***REDACTED***');
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('Error Handling', () => {
    test('should handle null result gracefully', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440040',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: null,
          durationMs: 100,
        });

      expect(response.status).toBe(200);
    });

    test('should handle undefined input gracefully', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440041',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'Some result',
          durationMs: 100,
        });

      expect(response.status).toBe(200);
    });

    test('should handle empty string result', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440042',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: '',
          durationMs: 100,
        });

      expect(response.status).toBe(200);

      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs[0].result).toBe('');
    });
  });

  // ============================================================================
  // Session Resolution Tests
  // ============================================================================

  describe('Session Resolution with Scrubbing', () => {
    test('should work with valid session ID', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440050',
          session: TEST_SESSION_UUID,
          tool: 'bash',
          result: 'PASSWORD=secret123',
          durationMs: 100,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('delivered');
    });

    test('should acknowledge unknown session without storing', async () => {
      const response = await request(app)
        .post('/api/hooks/tool-complete')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440051',
          session: 'unknown-session-999',
          tool: 'bash',
          result: 'PASSWORD=secret123',
          durationMs: 100,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('session_not_found');

      // Should not have stored anything
      const storedData = mockPool.getStoredData();
      expect(storedData.commandLogs.filter(l =>
        l.event_id === '550e8400-e29b-41d4-a716-446655440051'
      ).length).toBe(0);
    });
  });
});
