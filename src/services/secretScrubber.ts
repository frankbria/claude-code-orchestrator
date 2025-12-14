/**
 * Secret Scrubbing Service
 *
 * This module provides comprehensive secret detection and scrubbing for tool results
 * and inputs before they are stored in the database. It implements pattern-based
 * detection for common secret formats and integrates with the existing security
 * logging infrastructure.
 *
 * SECURITY FEATURES:
 * - Pattern-based detection for API keys, tokens, passwords, and credentials
 * - Service-specific patterns (OpenAI, Slack, GitHub, AWS, Google, etc.)
 * - Database connection string detection and scrubbing
 * - Private key detection (PEM format)
 * - Environment variable format detection
 * - Audit logging of detected secret types (without exposing values)
 * - Optional encryption at rest for sensitive data
 *
 * @module services/secretScrubber
 */

import crypto from 'crypto';
import { createLogger } from '../utils/logger';

const logger = createLogger('secret-scrubber');
const securityLogger = createLogger('security');

/**
 * Result of scrubbing operation
 */
export interface ScrubResult {
  /** The scrubbed text with secrets redacted */
  scrubbed: string;
  /** List of detected secret types (for audit logging) */
  foundSecrets: string[];
  /** Count of total secrets found */
  secretCount: number;
}

/**
 * Context for audit logging
 */
export interface ScrubContext {
  /** Session ID for correlation */
  sessionId?: string;
  /** Tool name that produced the content */
  tool?: string;
  /** Event ID for correlation */
  eventId?: string;
  /** Request ID for correlation */
  requestId?: string;
}

/**
 * Encryption result
 */
export interface EncryptionResult {
  /** Encrypted data as hex string */
  encrypted: string;
  /** Initialization vector as hex string */
  iv: string;
  /** Authentication tag as hex string */
  tag: string;
}

/**
 * Secret pattern definition
 */
interface SecretPattern {
  /** Name of the secret type for logging */
  name: string;
  /** Regular expression pattern to match */
  pattern: RegExp;
  /** Optional replacement function (defaults to standard redaction) */
  replacement?: (match: string, ...groups: string[]) => string;
}

/**
 * Redaction placeholder
 */
const REDACTED = '***REDACTED***';

/**
 * Comprehensive library of secret patterns
 *
 * IMPORTANT: Patterns are ordered from most specific to least specific.
 * More specific patterns (like JWT, specific API keys) MUST come before
 * generic patterns (like env_secret) to ensure proper categorization.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // ==========================================================================
  // JWT Tokens (MUST be before generic patterns)
  // ==========================================================================

  // JWT tokens (three base64 parts separated by dots)
  {
    name: 'jwt_token',
    pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\b/g,
  },

  // ==========================================================================
  // Service-Specific API Keys and Tokens
  // ==========================================================================

  // OpenAI API keys (sk-...) - must be before generic patterns
  {
    name: 'openai_api_key',
    pattern: /\bsk-[a-zA-Z0-9]{20,}(?:[a-zA-Z0-9_-]*)\b/g,
  },

  // OpenAI Project keys (sk-proj-...)
  {
    name: 'openai_project_key',
    pattern: /\bsk-proj-[a-zA-Z0-9_-]{20,}\b/g,
  },

  // Anthropic API keys (sk-ant-...)
  {
    name: 'anthropic_api_key',
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  },

  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-)
  {
    name: 'slack_token',
    pattern: /\bxox[bpas]-[a-zA-Z0-9-]{10,}\b/g,
  },

  // Slack webhook URLs
  {
    name: 'slack_webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/g,
  },

  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    name: 'github_token',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g,
  },

  // GitHub App tokens
  {
    name: 'github_app_token',
    pattern: /\bghs_[a-zA-Z0-9]{36,}\b/g,
  },

  // AWS Access Key ID
  {
    name: 'aws_access_key',
    pattern: /\b(AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
  },

  // AWS Secret Access Key
  {
    name: 'aws_secret_key',
    pattern: /\b[a-zA-Z0-9+/]{40}\b(?=.*aws|.*secret)/gi,
  },

  // Google API keys (AIza...) - flexible length (33-40 chars after prefix)
  {
    name: 'google_api_key',
    pattern: /\bAIza[a-zA-Z0-9_-]{33,40}\b/g,
  },

  // Google OAuth tokens
  {
    name: 'google_oauth',
    pattern: /\bya29\.[a-zA-Z0-9_-]+\b/g,
  },

  // Stripe API keys (sk_live_, sk_test_, pk_live_, pk_test_, rk_live_, rk_test_)
  {
    name: 'stripe_key',
    pattern: /\b(sk|pk|rk)_(live|test)_[a-zA-Z0-9]{24,}\b/g,
  },

  // Twilio API keys
  {
    name: 'twilio_key',
    pattern: /\bSK[a-f0-9]{32}\b/g,
  },

  // SendGrid API keys (format: SG.xxx.yyy with flexible lengths)
  {
    name: 'sendgrid_key',
    pattern: /\bSG\.[a-zA-Z0-9_-]{20,30}\.[a-zA-Z0-9_-]{40,60}\b/g,
  },

  // Mailgun API keys
  {
    name: 'mailgun_key',
    pattern: /\bkey-[a-f0-9]{32}\b/g,
  },

  // Heroku API keys
  {
    name: 'heroku_key',
    pattern: /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b(?=.*heroku)/gi,
  },

  // npm tokens
  {
    name: 'npm_token',
    pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g,
  },

  // PyPI tokens
  {
    name: 'pypi_token',
    pattern: /\bpypi-[a-zA-Z0-9_-]{40,}\b/g,
  },

  // Docker Hub tokens
  {
    name: 'docker_token',
    pattern: /\bdckr_pat_[a-zA-Z0-9_-]{27,}\b/g,
  },

  // ==========================================================================
  // Database Connection Strings
  // ==========================================================================

  // PostgreSQL connection strings
  {
    name: 'postgresql_connection',
    pattern: /postgres(?:ql)?:\/\/[^:]+:([^@]+)@[^/\s]+/gi,
    replacement: (match: string) => {
      return match.replace(/:([^:@]+)@/, ':' + REDACTED + '@');
    },
  },

  // MongoDB connection strings
  {
    name: 'mongodb_connection',
    pattern: /mongodb(?:\+srv)?:\/\/[^:]+:([^@]+)@[^/\s]+/gi,
    replacement: (match: string) => {
      return match.replace(/:([^:@]+)@/, ':' + REDACTED + '@');
    },
  },

  // MySQL connection strings
  {
    name: 'mysql_connection',
    pattern: /mysql:\/\/[^:]+:([^@]+)@[^/\s]+/gi,
    replacement: (match: string) => {
      return match.replace(/:([^:@]+)@/, ':' + REDACTED + '@');
    },
  },

  // Redis connection strings
  {
    name: 'redis_connection',
    pattern: /redis(?:s)?:\/\/(?:[^:]*:)?([^@]+)@[^/\s]+/gi,
    replacement: (match: string) => {
      return match.replace(/:([^:@]+)@/, ':' + REDACTED + '@');
    },
  },

  // Generic database URLs with credentials
  {
    name: 'database_url',
    pattern: /\b(?:jdbc:)?(?:mysql|postgresql|postgres|mariadb|oracle|sqlserver|mssql):\/\/[^:]+:([^@\s]+)@/gi,
    replacement: (match: string) => {
      return match.replace(/:([^:@]+)@/, ':' + REDACTED + '@');
    },
  },

  // ==========================================================================
  // Private Keys and Certificates
  // ==========================================================================

  // RSA Private Keys
  {
    name: 'rsa_private_key',
    pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g,
    replacement: () => '-----BEGIN RSA PRIVATE KEY-----\n' + REDACTED + '\n-----END RSA PRIVATE KEY-----',
  },

  // EC Private Keys
  {
    name: 'ec_private_key',
    pattern: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g,
    replacement: () => '-----BEGIN EC PRIVATE KEY-----\n' + REDACTED + '\n-----END EC PRIVATE KEY-----',
  },

  // OpenSSH Private Keys
  {
    name: 'openssh_private_key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    replacement: () => '-----BEGIN OPENSSH PRIVATE KEY-----\n' + REDACTED + '\n-----END OPENSSH PRIVATE KEY-----',
  },

  // Generic Private Keys
  {
    name: 'private_key',
    pattern: /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED )?PRIVATE KEY-----/g,
    replacement: () => '-----BEGIN PRIVATE KEY-----\n' + REDACTED + '\n-----END PRIVATE KEY-----',
  },

  // PGP Private Key Blocks
  {
    name: 'pgp_private_key',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
    replacement: () => '-----BEGIN PGP PRIVATE KEY BLOCK-----\n' + REDACTED + '\n-----END PGP PRIVATE KEY BLOCK-----',
  },

  // ==========================================================================
  // Environment Variable Patterns (KEY=value format)
  // ==========================================================================

  // Generic secret keywords in environment variable format
  {
    name: 'env_secret',
    pattern: /\b([A-Z_]*(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE)[A-Z_]*)=([^\s'"]+)/gi,
    replacement: (_match: string, key: string) => `${key}=${REDACTED}`,
  },

  // Quoted environment variable secrets
  {
    name: 'env_secret_quoted',
    pattern: /\b([A-Z_]*(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE)[A-Z_]*)=["']([^"']+)["']/gi,
    replacement: (_match: string, key: string) => `${key}="${REDACTED}"`,
  },

  // Note: DATABASE_URL patterns are handled by the more specific database
  // connection string patterns above which preserve the URL structure
  // and only redact the password portion.

  // ==========================================================================
  // Generic Patterns (less specific, catch-all)
  // ==========================================================================

  // JSON key-value pairs with secret keywords
  {
    name: 'json_secret',
    pattern: /"(password|passwd|pwd|secret|token|api_key|apikey|auth_token|access_token|private_key|credential)"\s*:\s*"([^"]+)"/gi,
    replacement: (_match: string, key: string) => `"${key}": "${REDACTED}"`,
  },

  // Bearer tokens in headers
  {
    name: 'bearer_token',
    pattern: /\b(Bearer|Authorization:?\s*Bearer)\s+([a-zA-Z0-9._-]{20,})\b/gi,
    replacement: (_match: string, prefix: string) => `${prefix} ${REDACTED}`,
  },

  // Basic auth headers
  {
    name: 'basic_auth',
    pattern: /\b(Basic|Authorization:?\s*Basic)\s+([a-zA-Z0-9+/=]{10,})\b/gi,
    replacement: (_match: string, prefix: string) => `${prefix} ${REDACTED}`,
  },

  // JWT tokens (three base64 parts separated by dots)
  {
    name: 'jwt_token',
    pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\b/g,
  },

  // High-entropy strings that look like secrets (32+ chars, alphanumeric)
  // This is a catch-all and may have false positives, so it's last
  {
    name: 'generic_secret',
    pattern: /\b([A-Za-z0-9+/]{40,}={0,2})\b(?=.*(?:key|secret|token|password|credential))/gi,
  },
];

/**
 * Keywords that indicate a key name contains sensitive data.
 * These are matched at word boundaries (underscore, hyphen, or string edges)
 * to avoid false positives like "normalKey" matching "key".
 */
const SECRET_KEYWORDS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'auth',
  'credential',
  'private_key',
  'privatekey',
  'cert',
  'certificate',
  'bearer',
  'oauth',
  'access_token',
  'refresh_token',
  'session_key',
  'session_secret',
  'cookie_secret',
  'jwt_secret',
  'ssh_key',
  'rsa_key',
  'encryption_key',
];

/**
 * Check if a key name matches any secret keyword at word boundaries.
 * This prevents false positives like "normalKey" matching "key".
 *
 * @param keyName - The key name to check
 * @returns true if the key name contains a secret keyword at word boundaries
 */
function isSecretKeyName(keyName: string): boolean {
  const keyLower = keyName.toLowerCase();

  // Check for exact match or keyword at word boundaries (underscore, hyphen, or start/end)
  for (const keyword of SECRET_KEYWORDS) {
    // Exact match
    if (keyLower === keyword) {
      return true;
    }

    // Check for keyword at word boundaries using regex
    // Word boundary is: start of string, underscore, hyphen, or end of string
    const pattern = new RegExp(`(^|_|-)(${keyword})($|_|-)`, 'i');
    if (pattern.test(keyLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if secret scrubbing is enabled
 */
export function isScrubbingEnabled(): boolean {
  const enabled = process.env.SCRUB_SECRETS;
  // Default to true if not explicitly set to 'false'
  return enabled !== 'false';
}

/**
 * Scrub secrets from text
 *
 * Applies all secret patterns to the input text and replaces detected
 * secrets with redaction placeholders. Returns both the scrubbed text
 * and a list of detected secret types for audit logging.
 *
 * @param text - Input text to scrub
 * @returns ScrubResult with scrubbed text and detected secret types
 *
 * @example
 * ```typescript
 * const result = scrubSecrets('API_KEY=sk-1234567890abcdef');
 * console.log(result.scrubbed); // 'API_KEY=***REDACTED***'
 * console.log(result.foundSecrets); // ['env_secret']
 * ```
 */
export function scrubSecrets(text: string | null | undefined): ScrubResult {
  // Handle null/undefined/empty inputs gracefully
  if (text === null || text === undefined) {
    return {
      scrubbed: text as unknown as string,
      foundSecrets: [],
      secretCount: 0,
    };
  }

  if (typeof text !== 'string') {
    return {
      scrubbed: String(text),
      foundSecrets: [],
      secretCount: 0,
    };
  }

  if (text.length === 0) {
    return {
      scrubbed: '',
      foundSecrets: [],
      secretCount: 0,
    };
  }

  // Check if scrubbing is disabled
  if (!isScrubbingEnabled()) {
    return {
      scrubbed: text,
      foundSecrets: [],
      secretCount: 0,
    };
  }

  let scrubbed = text;
  const foundSecrets: Set<string> = new Set();
  let totalCount = 0;

  // Apply each pattern
  for (const { name, pattern, replacement } of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;

    // Count matches first
    const matches = scrubbed.match(pattern);
    if (matches && matches.length > 0) {
      foundSecrets.add(name);
      totalCount += matches.length;

      // Apply replacement
      if (replacement) {
        scrubbed = scrubbed.replace(pattern, replacement);
      } else {
        scrubbed = scrubbed.replace(pattern, REDACTED);
      }
    }
  }

  return {
    scrubbed,
    foundSecrets: Array.from(foundSecrets),
    secretCount: totalCount,
  };
}

/**
 * Scrub secrets from an object recursively
 *
 * Traverses an object and scrubs secrets from all string values.
 * Handles nested objects and arrays.
 *
 * @param obj - Object to scrub
 * @returns Object with all string values scrubbed, and list of found secrets
 *
 * @example
 * ```typescript
 * const result = scrubObjectSecrets({
 *   apiKey: 'sk-1234567890',
 *   nested: { password: 'secret123' }
 * });
 * ```
 */
export function scrubObjectSecrets(obj: unknown): { scrubbed: unknown; foundSecrets: string[] } {
  if (obj === null || obj === undefined) {
    return { scrubbed: obj, foundSecrets: [] };
  }

  if (typeof obj === 'string') {
    const result = scrubSecrets(obj);
    return { scrubbed: result.scrubbed, foundSecrets: result.foundSecrets };
  }

  if (Array.isArray(obj)) {
    const allFoundSecrets: string[] = [];
    const scrubbedArray = obj.map(item => {
      const { scrubbed, foundSecrets } = scrubObjectSecrets(item);
      allFoundSecrets.push(...foundSecrets);
      return scrubbed;
    });
    return { scrubbed: scrubbedArray, foundSecrets: [...new Set(allFoundSecrets)] };
  }

  if (typeof obj === 'object') {
    const allFoundSecrets: string[] = [];
    const scrubbedObj: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const { scrubbed, foundSecrets } = scrubObjectSecrets(value);
      allFoundSecrets.push(...foundSecrets);

      // Also check if the key name itself suggests sensitive data
      if (isSecretKeyName(key)) {
        if (typeof value === 'string' && value.length > 0) {
          scrubbedObj[key] = REDACTED;
          allFoundSecrets.push('sensitive_key_value');
        } else {
          scrubbedObj[key] = scrubbed;
        }
      } else {
        scrubbedObj[key] = scrubbed;
      }
    }

    return { scrubbed: scrubbedObj, foundSecrets: [...new Set(allFoundSecrets)] };
  }

  // For primitives (numbers, booleans), return as-is
  return { scrubbed: obj, foundSecrets: [] };
}

/**
 * Log detected secrets for audit purposes
 *
 * Logs the types of secrets detected without exposing their values.
 * Includes correlation context for incident investigation.
 *
 * @param foundSecrets - Array of detected secret type names
 * @param context - Context for correlation (sessionId, tool, eventId)
 *
 * @example
 * ```typescript
 * logScrubbedSecrets(['openai_api_key', 'env_secret'], {
 *   sessionId: 'abc-123',
 *   tool: 'bash',
 *   eventId: 'evt-456'
 * });
 * ```
 */
export function logScrubbedSecrets(foundSecrets: string[], context: ScrubContext): void {
  if (foundSecrets.length === 0) {
    return;
  }

  // Log to secret-scrubber category (info level)
  logger.info('Secrets scrubbed from content', {
    secretTypes: foundSecrets,
    secretCount: foundSecrets.length,
    sessionId: context.sessionId,
    tool: context.tool,
    eventId: context.eventId,
    requestId: context.requestId,
    timestamp: new Date().toISOString(),
  });

  // Also log to security category for audit trail
  securityLogger.info('Sensitive data detected and scrubbed', {
    secretTypes: foundSecrets,
    secretCount: foundSecrets.length,
    sessionId: context.sessionId,
    tool: context.tool,
    eventId: context.eventId,
    requestId: context.requestId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Check if encryption at rest is enabled
 */
export function isEncryptionEnabled(): boolean {
  return process.env.ENABLE_ENCRYPTION_AT_REST === 'true' && !!process.env.ENCRYPTION_KEY;
}

/**
 * Get encryption key from environment
 *
 * @returns Encryption key as Buffer, or null if not configured
 */
function getEncryptionKey(): Buffer | null {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    return null;
  }

  try {
    return Buffer.from(keyHex, 'hex');
  } catch {
    return null;
  }
}

/**
 * Encrypt sensitive data using AES-256-GCM
 *
 * Encrypts text using AES-256-GCM with a random IV for each encryption.
 * Returns the encrypted data along with IV and authentication tag.
 *
 * @param text - Plain text to encrypt
 * @returns EncryptionResult with encrypted data, IV, and tag
 * @throws Error if encryption key is not configured or invalid
 *
 * @example
 * ```typescript
 * const result = encryptSensitiveData('sensitive data');
 * console.log(result.encrypted); // hex-encoded encrypted data
 * console.log(result.iv);        // hex-encoded IV
 * console.log(result.tag);       // hex-encoded auth tag
 * ```
 */
export function encryptSensitiveData(text: string): EncryptionResult {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Encryption key not configured or invalid');
  }

  // Generate random IV (12 bytes for GCM)
  const iv = crypto.randomBytes(12);

  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  // Get auth tag
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt sensitive data using AES-256-GCM
 *
 * Decrypts data that was encrypted with encryptSensitiveData.
 *
 * @param encrypted - Hex-encoded encrypted data
 * @param iv - Hex-encoded initialization vector
 * @param tag - Hex-encoded authentication tag
 * @returns Decrypted plain text
 * @throws Error if decryption fails or key is not configured
 *
 * @example
 * ```typescript
 * const plainText = decryptSensitiveData(
 *   result.encrypted,
 *   result.iv,
 *   result.tag
 * );
 * ```
 */
export function decryptSensitiveData(encrypted: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Encryption key not configured or invalid');
  }

  // Create decipher
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  );

  // Set auth tag
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  // Decrypt
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Scrub and optionally encrypt tool data
 *
 * Main entry point for processing tool results and inputs before storage.
 * Combines scrubbing and optional encryption.
 *
 * @param data - Data to process (string or object)
 * @param context - Context for audit logging
 * @returns Processed data ready for storage
 *
 * @example
 * ```typescript
 * const processed = processToolData(
 *   'API_KEY=sk-123456',
 *   { sessionId: 'abc', tool: 'bash' }
 * );
 * ```
 */
export function processToolData(
  data: string | object | null | undefined,
  context: ScrubContext
): { processed: string | object | null; foundSecrets: string[] } {
  if (data === null || data === undefined) {
    return { processed: data, foundSecrets: [] };
  }

  let scrubResult: { scrubbed: unknown; foundSecrets: string[] };

  if (typeof data === 'string') {
    const result = scrubSecrets(data);
    scrubResult = { scrubbed: result.scrubbed, foundSecrets: result.foundSecrets };
  } else {
    scrubResult = scrubObjectSecrets(data);
  }

  // Log if secrets were found
  if (scrubResult.foundSecrets.length > 0) {
    logScrubbedSecrets(scrubResult.foundSecrets, context);
  }

  return {
    processed: scrubResult.scrubbed as string | object | null,
    foundSecrets: scrubResult.foundSecrets,
  };
}
