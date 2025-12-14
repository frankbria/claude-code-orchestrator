/**
 * Secret Scrubber Service Tests
 *
 * Comprehensive test suite for the secret scrubbing functionality.
 * Tests cover:
 * - Pattern detection for all supported secret types
 * - Edge cases (null, empty, malformed inputs)
 * - Non-secret preservation
 * - Object scrubbing
 * - Audit logging
 * - Encryption at rest
 *
 * @module __tests__/services/secretScrubber
 */

import {
  scrubSecrets,
  scrubObjectSecrets,
  logScrubbedSecrets,
  isScrubbingEnabled,
  isEncryptionEnabled,
  encryptSensitiveData,
  decryptSensitiveData,
  processToolData,
  ScrubResult,
  ScrubContext,
} from '../../services/secretScrubber';

describe('Secret Scrubber Service', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    // Backup environment
    originalEnv = { ...process.env };
    // Enable scrubbing for tests
    process.env.SCRUB_SECRETS = 'true';
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
  // Service-Specific API Key Detection Tests
  // ============================================================================

  describe('Service-Specific API Key Detection', () => {
    test('should detect and scrub OpenAI API keys (sk-...)', () => {
      const input = 'API_KEY=sk-1234567890abcdefghij1234567890abcdefghij';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('sk-1234567890');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('openai_api_key');
    });

    test('should detect and scrub OpenAI project keys (sk-proj-...)', () => {
      const input = 'export OPENAI_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('sk-proj-');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('openai_project_key');
    });

    test('should detect and scrub Anthropic API keys (sk-ant-...)', () => {
      const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789jkl012mno345pqr';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('sk-ant-');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('anthropic_api_key');
    });

    test('should detect and scrub Slack tokens (xoxb-...)', () => {
      // Using obviously fake pattern that won't trigger GitHub secret scanning
      const input = 'SLACK_TOKEN=xoxb-fake-token-for-testing-purposes';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('xoxb-');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('slack_token');
    });

    test('should detect and scrub Slack webhook URLs', () => {
      const input = 'WEBHOOK=https://hooks.slack.com/services/T12345678/B87654321/abcdefghijklmnop';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('hooks.slack.com/services/T');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('slack_webhook');
    });

    test('should detect and scrub GitHub tokens (ghp_...)', () => {
      const input = 'GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqrstu678';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('ghp_');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('github_token');
    });

    test('should detect and scrub GitHub tokens (gho_...)', () => {
      const input = 'TOKEN=gho_abc123def456ghi789jkl012mno345pqrstu678';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('gho_');
      expect(result.foundSecrets).toContain('github_token');
    });

    test('should detect and scrub AWS Access Key IDs', () => {
      const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('aws_access_key');
    });

    test('should detect and scrub Google API keys (AIza...)', () => {
      const input = 'GOOGLE_API_KEY=AIzaSyC8k3lM2nO5p6Q7r8S9t0uVwXyZ123456-';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('AIzaSy');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('google_api_key');
    });

    test('should detect and scrub Stripe API keys', () => {
      // Using obviously fake pattern that won't trigger GitHub secret scanning
      const input = 'STRIPE_KEY=sk_test_FakeKeyForTestingPurposes1234';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('sk_test_');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('stripe_key');
    });

    test('should detect and scrub npm tokens', () => {
      const input = 'NPM_TOKEN=npm_abc123def456ghi789jkl012mno345pqr678';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('npm_');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('npm_token');
    });

    test('should detect and scrub SendGrid API keys', () => {
      const input = 'SENDGRID_KEY=SG.abc123def456ghi789jkl.abc123def456ghi789jkl012mno345pqrstuvwxyz12';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('SG.');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('sendgrid_key');
    });
  });

  // ============================================================================
  // Database Connection String Tests
  // ============================================================================

  describe('Database Connection String Detection', () => {
    test('should scrub PostgreSQL connection strings', () => {
      const input = 'DATABASE_URL=postgresql://user:secretpassword123@localhost:5432/mydb';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('secretpassword123');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.scrubbed).toContain('postgresql://');
      expect(result.scrubbed).toContain('@localhost');
      expect(result.foundSecrets).toContain('postgresql_connection');
    });

    test('should scrub MongoDB connection strings', () => {
      const input = 'MONGO_URI=mongodb+srv://admin:mysupersecretpwd@cluster0.abc123.mongodb.net';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('mysupersecretpwd');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('mongodb_connection');
    });

    test('should scrub MySQL connection strings', () => {
      const input = 'MYSQL_URL=mysql://root:password123@127.0.0.1:3306/app';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('password123');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('mysql_connection');
    });

    test('should scrub Redis connection strings', () => {
      const input = 'REDIS_URL=redis://:myredispassword@redis.example.com:6379';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('myredispassword');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('redis_connection');
    });
  });

  // ============================================================================
  // Private Key Detection Tests
  // ============================================================================

  describe('Private Key Detection', () => {
    test('should scrub RSA private keys', () => {
      const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyf8CL7wdPYUvQmE4f6EfT2l8H
base64encodedprivatekeydata==
-----END RSA PRIVATE KEY-----`;
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('MIIEpAIBAAKCAQEA');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.scrubbed).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(result.scrubbed).toContain('-----END RSA PRIVATE KEY-----');
      expect(result.foundSecrets).toContain('rsa_private_key');
    });

    test('should scrub OpenSSH private keys', () => {
      const input = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS
base64data==
-----END OPENSSH PRIVATE KEY-----`;
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('b3BlbnNzaC');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('openssh_private_key');
    });

    test('should scrub generic private keys', () => {
      const input = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC
-----END PRIVATE KEY-----`;
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('MIIEvgIBADANBgkqhkiG9w0');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('private_key');
    });
  });

  // ============================================================================
  // Environment Variable Pattern Tests
  // ============================================================================

  describe('Environment Variable Pattern Detection', () => {
    test('should scrub PASSWORD= patterns', () => {
      const input = 'DB_PASSWORD=mysecretpassword123';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe('DB_PASSWORD=***REDACTED***');
      expect(result.foundSecrets).toContain('env_secret');
    });

    test('should scrub API_KEY= patterns', () => {
      const input = 'MY_API_KEY=abc123def456';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe('MY_API_KEY=***REDACTED***');
      expect(result.foundSecrets).toContain('env_secret');
    });

    test('should scrub SECRET= patterns', () => {
      const input = 'APP_SECRET=verysecretvalue';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe('APP_SECRET=***REDACTED***');
      expect(result.foundSecrets).toContain('env_secret');
    });

    test('should scrub quoted environment variable secrets', () => {
      const input = 'AUTH_TOKEN="my-secret-token-value"';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe('AUTH_TOKEN="***REDACTED***"');
      expect(result.foundSecrets).toContain('env_secret_quoted');
    });

    test('should scrub DATABASE_URL patterns', () => {
      const input = 'DATABASE_URL=postgres://user:pass@host/db';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('postgres://user:pass@host/db');
      expect(result.scrubbed).toContain('***REDACTED***');
    });
  });

  // ============================================================================
  // JSON Pattern Tests
  // ============================================================================

  describe('JSON Secret Detection', () => {
    test('should scrub JSON password fields', () => {
      const input = '{"username": "admin", "password": "secret123"}';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('secret123');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('json_secret');
    });

    test('should scrub JSON api_key fields', () => {
      const input = '{"api_key": "abc123def456"}';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('abc123def456');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('json_secret');
    });

    test('should scrub JSON token fields', () => {
      const input = '{"token": "jwt.token.here", "user": "test"}';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('jwt.token.here');
      expect(result.scrubbed).toContain('***REDACTED***');
    });
  });

  // ============================================================================
  // Bearer Token and Auth Header Tests
  // ============================================================================

  describe('Authorization Header Detection', () => {
    test('should scrub Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets.some(s => s.includes('bearer') || s.includes('jwt'))).toBe(true);
    });

    test('should scrub Basic auth headers', () => {
      const input = 'Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('dXNlcm5hbWU6cGFzc3dvcmQ=');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('basic_auth');
    });
  });

  // ============================================================================
  // JWT Token Tests
  // ============================================================================

  describe('JWT Token Detection', () => {
    test('should scrub JWT tokens', () => {
      const input = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets).toContain('jwt_token');
    });
  });

  // ============================================================================
  // Edge Cases Tests
  // ============================================================================

  describe('Edge Cases', () => {
    test('should handle null input', () => {
      const result = scrubSecrets(null);

      expect(result.scrubbed).toBe(null);
      expect(result.foundSecrets).toEqual([]);
      expect(result.secretCount).toBe(0);
    });

    test('should handle undefined input', () => {
      const result = scrubSecrets(undefined);

      // undefined inputs are normalized to null for consistency
      expect(result.scrubbed).toBe(null);
      expect(result.foundSecrets).toEqual([]);
      expect(result.secretCount).toBe(0);
    });

    test('should handle empty string', () => {
      const result = scrubSecrets('');

      expect(result.scrubbed).toBe('');
      expect(result.foundSecrets).toEqual([]);
      expect(result.secretCount).toBe(0);
    });

    test('should handle text with no secrets', () => {
      const input = 'This is just a regular log message with no sensitive data.';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe(input);
      expect(result.foundSecrets).toEqual([]);
      expect(result.secretCount).toBe(0);
    });

    test('should handle multiple secrets in same text', () => {
      const input = `
        API_KEY=sk-1234567890abcdefghij1234567890ab
        PASSWORD=mysecretpassword
        GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqrstu678
      `;
      const result = scrubSecrets(input);

      expect(result.scrubbed).not.toContain('sk-1234567890');
      expect(result.scrubbed).not.toContain('mysecretpassword');
      expect(result.scrubbed).not.toContain('ghp_abc123');
      expect(result.secretCount).toBeGreaterThan(1);
    });

    test('should handle secrets with special characters', () => {
      const input = 'PASSWORD=pass!@#$%^&*()word123';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets.length).toBeGreaterThan(0);
    });

    test('should handle very long text with secrets', () => {
      const longText = 'A'.repeat(10000) + 'API_KEY=sk-1234567890abcdefghij12345' + 'B'.repeat(10000);
      const result = scrubSecrets(longText);

      expect(result.scrubbed).not.toContain('sk-1234567890');
      expect(result.scrubbed).toContain('***REDACTED***');
    });
  });

  // ============================================================================
  // Non-Secret Preservation Tests
  // ============================================================================

  describe('Non-Secret Preservation', () => {
    test('should preserve non-sensitive environment variables', () => {
      const input = 'DEBUG=true\nNODE_ENV=production\nPORT=3000';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe(input);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should preserve normal code snippets', () => {
      const input = `
function getUser() {
  const user = { name: 'John', email: 'john@example.com' };
  return user;
}
      `;
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe(input);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should preserve URLs without credentials', () => {
      const input = 'https://api.example.com/users?page=1&limit=10';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe(input);
      expect(result.foundSecrets).toEqual([]);
    });
  });

  // ============================================================================
  // Object Scrubbing Tests
  // ============================================================================

  describe('Object Scrubbing', () => {
    test('should scrub string values in objects', () => {
      const input = {
        apiKey: 'sk-1234567890abcdefghij1234567890ab',
        username: 'testuser',
      };
      const result = scrubObjectSecrets(input);

      expect((result.scrubbed as any).apiKey).toBe('***REDACTED***');
      expect((result.scrubbed as any).username).toBe('testuser');
      expect(result.foundSecrets).toContain('sensitive_key_value');
    });

    test('should scrub nested objects', () => {
      const input = {
        config: {
          database: {
            password: 'mysecretpassword',
          },
        },
      };
      const result = scrubObjectSecrets(input);

      expect((result.scrubbed as any).config.database.password).toBe('***REDACTED***');
    });

    test('should scrub arrays', () => {
      const input = ['sk-1234567890abcdefghij1234567890ab', 'normal text'];
      const result = scrubObjectSecrets(input);

      expect((result.scrubbed as any[])[0]).toContain('***REDACTED***');
      expect((result.scrubbed as any[])[1]).toBe('normal text');
    });

    test('should handle null objects', () => {
      const result = scrubObjectSecrets(null);

      expect(result.scrubbed).toBe(null);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should preserve non-secret primitive values', () => {
      const input = {
        count: 42,
        enabled: true,
        name: 'test',
      };
      const result = scrubObjectSecrets(input);

      expect(result.scrubbed).toEqual(input);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should detect sensitive keys and redact values', () => {
      const input = {
        password: 'supersecret',
        api_key: 'myapikey',
        token: 'mytoken123',
        normalKey: 'normalvalue',
      };
      const result = scrubObjectSecrets(input);

      expect((result.scrubbed as any).password).toBe('***REDACTED***');
      expect((result.scrubbed as any).api_key).toBe('***REDACTED***');
      expect((result.scrubbed as any).token).toBe('***REDACTED***');
      expect((result.scrubbed as any).normalKey).toBe('normalvalue');
    });
  });

  // ============================================================================
  // Configuration Tests
  // ============================================================================

  describe('Configuration', () => {
    test('should respect SCRUB_SECRETS=false', () => {
      process.env.SCRUB_SECRETS = 'false';

      const input = 'API_KEY=sk-1234567890abcdefghij1234567890ab';
      const result = scrubSecrets(input);

      expect(result.scrubbed).toBe(input);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should default to enabled when SCRUB_SECRETS is not set', () => {
      delete process.env.SCRUB_SECRETS;

      expect(isScrubbingEnabled()).toBe(true);
    });

    test('should be disabled when SCRUB_SECRETS=false', () => {
      process.env.SCRUB_SECRETS = 'false';

      expect(isScrubbingEnabled()).toBe(false);
    });
  });

  // ============================================================================
  // Audit Logging Tests
  // ============================================================================

  describe('Audit Logging', () => {
    test('should log detected secret types', () => {
      const context: ScrubContext = {
        sessionId: 'test-session-123',
        tool: 'bash',
        eventId: 'event-456',
      };

      logScrubbedSecrets(['openai_api_key', 'env_secret'], context);

      expect(consoleSpy).toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls;
      expect(logCalls.some((call: any[]) => {
        const logStr = call[0];
        return logStr.includes('secret-scrubber') || logStr.includes('security');
      })).toBe(true);
    });

    test('should not log if no secrets found', () => {
      logScrubbedSecrets([], { sessionId: 'test' });

      // Should not have logged anything
      const secretLogs = consoleSpy.mock.calls.filter((call: any[]) => {
        const logStr = call[0];
        return logStr.includes('secret-scrubber');
      });
      expect(secretLogs.length).toBe(0);
    });

    test('should include correlation context in logs', () => {
      const context: ScrubContext = {
        sessionId: 'session-abc',
        tool: 'grep',
        eventId: 'evt-123',
        requestId: 'req-456',
      };

      logScrubbedSecrets(['github_token'], context);

      const logCalls = consoleSpy.mock.calls;
      const logStr = logCalls.find((call: any[]) => call[0].includes('sessionId'));

      expect(logStr).toBeDefined();
      if (logStr) {
        expect(logStr[0]).toContain('session-abc');
      }
    });
  });

  // ============================================================================
  // Encryption Tests
  // ============================================================================

  describe('Encryption at Rest', () => {
    const testEncryptionKey = 'a'.repeat(64); // Valid 64-char hex key

    test('should report encryption as disabled without key', () => {
      delete process.env.ENCRYPTION_KEY;
      delete process.env.ENABLE_ENCRYPTION_AT_REST;

      expect(isEncryptionEnabled()).toBe(false);
    });

    test('should report encryption as disabled without enable flag', () => {
      process.env.ENCRYPTION_KEY = testEncryptionKey;
      delete process.env.ENABLE_ENCRYPTION_AT_REST;

      expect(isEncryptionEnabled()).toBe(false);
    });

    test('should report encryption as enabled with both settings', () => {
      process.env.ENCRYPTION_KEY = testEncryptionKey;
      process.env.ENABLE_ENCRYPTION_AT_REST = 'true';

      expect(isEncryptionEnabled()).toBe(true);
    });

    test('should encrypt and decrypt data correctly', () => {
      process.env.ENCRYPTION_KEY = testEncryptionKey;

      const plaintext = 'This is sensitive data to encrypt';
      const encrypted = encryptSensitiveData(plaintext);

      expect(encrypted.encrypted).not.toBe(plaintext);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();

      const decrypted = decryptSensitiveData(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag
      );

      expect(decrypted).toBe(plaintext);
    });

    test('should throw error when encrypting without key', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(() => encryptSensitiveData('test')).toThrow('Encryption key not configured');
    });

    test('should use unique IV for each encryption', () => {
      process.env.ENCRYPTION_KEY = testEncryptionKey;

      const plaintext = 'Same text twice';
      const encrypted1 = encryptSensitiveData(plaintext);
      const encrypted2 = encryptSensitiveData(plaintext);

      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.encrypted).not.toBe(encrypted2.encrypted);
    });
  });

  // ============================================================================
  // Process Tool Data Tests
  // ============================================================================

  describe('Process Tool Data', () => {
    test('should process string data', () => {
      const input = 'API_KEY=sk-1234567890abcdefghij1234567890ab';
      const context: ScrubContext = { sessionId: 'test' };

      const result = processToolData(input, context);

      expect((result.processed as string)).toContain('***REDACTED***');
      expect(result.foundSecrets.length).toBeGreaterThan(0);
    });

    test('should process object data', () => {
      const input = { password: 'secret123' };
      const context: ScrubContext = { sessionId: 'test' };

      const result = processToolData(input, context);

      expect((result.processed as any).password).toBe('***REDACTED***');
      expect(result.foundSecrets).toContain('sensitive_key_value');
    });

    test('should handle null data', () => {
      const context: ScrubContext = { sessionId: 'test' };

      const result = processToolData(null, context);

      expect(result.processed).toBe(null);
      expect(result.foundSecrets).toEqual([]);
    });

    test('should log when secrets are found', () => {
      const input = 'GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqrstu678';
      const context: ScrubContext = { sessionId: 'test', tool: 'bash' };

      processToolData(input, context);

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  describe('Performance', () => {
    test('should handle large text efficiently', () => {
      const largeText = 'Normal text '.repeat(100000) +
        'API_KEY=sk-1234567890abcdefghij1234567890ab' +
        ' More normal text'.repeat(100000);

      const startTime = Date.now();
      const result = scrubSecrets(largeText);
      const duration = Date.now() - startTime;

      expect(result.scrubbed).toContain('***REDACTED***');
      expect(result.foundSecrets.length).toBeGreaterThan(0);
      // Should complete in reasonable time (less than 5 seconds)
      expect(duration).toBeLessThan(5000);
    });

    test('should handle many patterns efficiently', () => {
      const input = `
        sk-1234567890abcdefghij1234567890ab
        xoxb-123-456-789
        ghp_abc123def456ghi789jkl012mno345pqrstu678
        AKIAIOSFODNN7EXAMPLE
        AIzaSyC8k3lM2nO5p6Q7r8S9t0uVwXyZ123456-
        postgres://user:password@localhost/db
        -----BEGIN RSA PRIVATE KEY-----test-----END RSA PRIVATE KEY-----
        API_KEY=secretvalue
      `;

      const startTime = Date.now();
      const result = scrubSecrets(input);
      const duration = Date.now() - startTime;

      expect(result.foundSecrets.length).toBeGreaterThan(5);
      // Should complete quickly (less than 100ms for this small input)
      expect(duration).toBeLessThan(100);
    });
  });
});
