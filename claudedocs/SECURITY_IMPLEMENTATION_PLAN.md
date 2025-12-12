# Security-Hardened Implementation Plan
## Path Traversal Vulnerability Fix

**Status**: Phase 1 Complete ✅ - Critical Security Issues Identified
**Branch**: `fix/path-traversal-vulnerability`
**Last Updated**: 2025-12-12

---

## Phase 1 Review Findings ⚠️

### Critical Issues Identified:
1. ✅ **Symlink attack vector** - Original plan missing `fs.realpath()` protection
2. ✅ **TOCTOU race condition** - Validation-to-creation timing vulnerability
3. ✅ **Path separator bypass** - Missing `path.sep` in `startsWith()` checks
4. ✅ **GitHub repo validation gaps** - Regex allows dangerous dot patterns
5. ✅ **Insecure environment defaults** - `/tmp` default is world-writable

### Major Improvements Required:
6. ✅ Security event logging for audit trails
7. ✅ Rate limiting on workspace creation endpoints
8. ✅ Resource limits (timeout/size) for Git operations

---

## Updated Implementation Plan

### Phase 2: Security-Hardened Core Implementation (PARALLEL)

#### Module 1: Path Validation Utility (`src/utils/pathValidation.ts`)

**ENHANCED SECURITY FEATURES:**

```typescript
import path from 'path';
import fs from 'fs/promises';
import { createLogger } from './logger';

const securityLogger = createLogger('security');

/**
 * Get and validate the secure base directory
 * CRITICAL: No default - must be explicitly configured
 */
export function getSecureBaseDir(): string {
  const envBase = process.env.WORKSPACE_BASE;

  if (!envBase) {
    throw new Error(
      'WORKSPACE_BASE environment variable must be explicitly set. ' +
      'Set it to a dedicated directory with restrictive permissions (chmod 700).'
    );
  }

  const resolvedBase = path.resolve(envBase);

  // Verify the base directory exists and has safe permissions
  try {
    const stats = fs.statSync(resolvedBase);

    if (!stats.isDirectory()) {
      throw new Error('WORKSPACE_BASE must be a directory');
    }

    // On Unix systems, check permissions (should be 0700 or 0750)
    if (process.platform !== 'win32') {
      const mode = stats.mode & parseInt('777', 8);
      if (mode > parseInt('750', 8)) {
        console.warn(
          `WARNING: WORKSPACE_BASE has overly permissive permissions (${mode.toString(8)}). ` +
          `Recommend: chmod 700 ${resolvedBase}`
        );
      }
    }
  } catch (error) {
    throw new Error(`WORKSPACE_BASE directory validation failed: ${error.message}`);
  }

  return resolvedBase;
}

/**
 * Validate workspace path with symlink protection
 * SECURITY: Prevents path traversal and symlink attacks
 */
export async function validateWorkspacePath(
  requestedPath: string,
  requestId?: string
): Promise<string> {
  const baseDir = getSecureBaseDir();
  const resolvedPath = path.resolve(requestedPath);

  // CRITICAL FIX #1: Add path separator to prevent bypass
  // Example: /tmp/workspaces vs /tmp/workspaces-hacked
  if (!resolvedPath.startsWith(baseDir + path.sep)) {
    securityLogger.warn('Path traversal attempt blocked', {
      requestId,
      requestedPath: path.basename(requestedPath), // Don't log full path
      timestamp: new Date().toISOString(),
    });
    throw new Error('Invalid workspace path');
  }

  // CRITICAL FIX #2: Symlink protection using fs.realpath()
  try {
    const realPath = await fs.realpath(resolvedPath);

    // Verify real path is still within base directory
    if (!realPath.startsWith(baseDir + path.sep)) {
      securityLogger.warn('Symlink escape attempt blocked', {
        requestId,
        timestamp: new Date().toISOString(),
      });
      throw new Error('Invalid workspace path');
    }

    securityLogger.info('Workspace path validated', {
      requestId,
      timestamp: new Date().toISOString(),
    });

    return realPath;
  } catch (error) {
    // Path doesn't exist yet - validate parent directories for symlinks
    if (error.code === 'ENOENT') {
      await validateParentDirectories(resolvedPath, baseDir, requestId);
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * Validate parent directories don't contain symlinks
 * SECURITY: Prevents symlink attacks on non-existent paths
 */
async function validateParentDirectories(
  targetPath: string,
  baseDir: string,
  requestId?: string
): Promise<void> {
  const parts = targetPath.split(path.sep);
  let currentPath = '';

  for (const part of parts) {
    if (!part) continue;

    currentPath = currentPath ? path.join(currentPath, part) : part;

    try {
      const realPath = await fs.realpath(currentPath);

      // Check if this real path is within base directory
      if (!realPath.startsWith(baseDir + path.sep) && realPath !== baseDir) {
        securityLogger.warn('Parent directory symlink escape detected', {
          requestId,
          timestamp: new Date().toISOString(),
        });
        throw new Error('Invalid workspace path');
      }
    } catch (error) {
      // Directory doesn't exist yet - this is OK, stop checking
      if (error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
}

/**
 * Check if resolved path matches allowlist patterns
 * SECURITY: Additional defense layer
 */
export function isAllowedPath(resolvedPath: string): boolean {
  const allowedPatterns = [
    /^\/tmp\/claude-workspaces\/.+$/,
    /^\/workspace\/.+$/,
    /^\/home\/[\w-]+\/claude-workspaces\/.+$/,
  ];

  return allowedPatterns.some(pattern => pattern.test(resolvedPath));
}
```

**Key Security Enhancements:**
- ✅ No default workspace base (explicit configuration required)
- ✅ Permission checking on Unix systems
- ✅ Symlink protection with `fs.realpath()`
- ✅ TOCTOU mitigation via parent directory validation
- ✅ Path separator in all `startsWith()` checks
- ✅ Security event logging with request correlation
- ✅ Generic error messages (no path disclosure)

---

#### Module 2: WorkspaceManager Service (`src/services/workspace.ts`)

**ENHANCED SECURITY FEATURES:**

```typescript
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { validateWorkspacePath, isAllowedPath, getSecureBaseDir } from '../utils/pathValidation';
import { createLogger } from '../utils/logger';

const execFileAsync = promisify(execFile);
const securityLogger = createLogger('security');

export interface SessionConfig {
  projectType: 'github' | 'local' | 'e2b' | 'worktree';
  projectPath?: string;
  githubRepo?: string;
  basePath?: string;
}

export class WorkspaceManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || getSecureBaseDir();
  }

  /**
   * Prepare workspace based on project type
   * SECURITY: Central validation point for all workspace creation
   */
  async prepareWorkspace(config: SessionConfig, requestId?: string): Promise<string> {
    securityLogger.info('Workspace preparation started', {
      requestId,
      projectType: config.projectType,
      timestamp: new Date().toISOString(),
    });

    switch (config.projectType) {
      case 'local':
        return this.ensureLocalDirectory(config.projectPath!, requestId);
      case 'github':
        return this.cloneGitHubRepo(config.githubRepo!, requestId);
      case 'worktree':
        return this.createGitWorktree(config.basePath!, requestId);
      case 'e2b':
        // E2B sandbox - no local path validation needed
        return 'e2b://sandbox';
      default:
        throw new Error('Invalid project type');
    }
  }

  /**
   * Ensure local directory exists and is secure
   * CRITICAL FIX: TOCTOU race condition mitigation
   */
  async ensureLocalDirectory(dirPath: string, requestId?: string): Promise<string> {
    // Pre-creation validation
    const validatedPath = await validateWorkspacePath(dirPath, requestId);

    // Allowlist check
    if (!isAllowedPath(validatedPath)) {
      securityLogger.warn('Path not in allowlist', {
        requestId,
        timestamp: new Date().toISOString(),
      });
      throw new Error('Path not in allowlist');
    }

    // Create directory with restricted permissions
    await fs.mkdir(validatedPath, { recursive: true, mode: 0o750 });

    // CRITICAL FIX #3: Post-creation validation (TOCTOU mitigation)
    // Verify no symlink was created during the operation
    const realPath = await fs.realpath(validatedPath);

    if (!realPath.startsWith(this.baseDir + path.sep)) {
      // Symlink attack detected - clean up and fail
      securityLogger.error('Symlink attack detected after creation', {
        requestId,
        timestamp: new Date().toISOString(),
      });

      await fs.rm(validatedPath, { recursive: true, force: true });
      throw new Error('Security violation detected');
    }

    securityLogger.info('Local directory created securely', {
      requestId,
      timestamp: new Date().toISOString(),
    });

    return realPath;
  }

  /**
   * Clone GitHub repository with security hardening
   * CRITICAL FIX: Command injection prevention and resource limits
   */
  async cloneGitHubRepo(repo: string, requestId?: string): Promise<string> {
    // CRITICAL FIX #4: Enhanced GitHub repo validation
    // Prevent: dots bypass, command injection, path traversal

    // Basic format check
    if (!/^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*[a-zA-Z0-9]$/.test(repo)) {
      securityLogger.warn('Invalid GitHub repo format', {
        requestId,
        timestamp: new Date().toISOString(),
      });
      throw new Error('Invalid repository format');
    }

    // Prevent ".." sequences
    if (repo.includes('..')) {
      securityLogger.warn('Path traversal attempt in repo name', {
        requestId,
        timestamp: new Date().toISOString(),
      });
      throw new Error('Invalid repository format');
    }

    // Use UUID for directory name (safer than using repo name)
    const uuid = crypto.randomUUID();
    const timestamp = Date.now();
    const targetPath = path.join(this.baseDir, `gh-${uuid}-${timestamp}`);

    // Validate constructed path
    const validatedPath = await validateWorkspacePath(targetPath, requestId);

    // Create directory first
    await fs.mkdir(validatedPath, { mode: 0o750 });

    try {
      // CRITICAL FIX #8: Use execFile (not exec) to prevent shell injection
      // Add timeout and resource limits
      await execFileAsync('gh', ['repo', 'clone', repo, validatedPath], {
        timeout: 300000, // 5 minutes
        maxBuffer: 100 * 1024 * 1024, // 100MB output limit
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // Disable interactive prompts
        },
      });

      // Verify cloned repository size
      const size = await this.getDirectorySize(validatedPath);
      const MAX_REPO_SIZE = 1024 * 1024 * 1024; // 1GB

      if (size > MAX_REPO_SIZE) {
        securityLogger.warn('Repository exceeds size limit', {
          requestId,
          size,
          limit: MAX_REPO_SIZE,
          timestamp: new Date().toISOString(),
        });

        await fs.rm(validatedPath, { recursive: true, force: true });
        throw new Error('Repository exceeds size limit');
      }

      // Post-creation validation (TOCTOU mitigation)
      const realPath = await fs.realpath(validatedPath);
      if (!realPath.startsWith(this.baseDir + path.sep)) {
        await fs.rm(validatedPath, { recursive: true, force: true });
        throw new Error('Security violation detected');
      }

      securityLogger.info('GitHub repository cloned securely', {
        requestId,
        repo,
        timestamp: new Date().toISOString(),
      });

      return realPath;
    } catch (error) {
      // Clean up on failure
      await fs.rm(validatedPath, { recursive: true, force: true }).catch(() => {});

      securityLogger.error('GitHub clone failed', {
        requestId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  /**
   * Create git worktree with path validation
   */
  async createGitWorktree(basePath: string, requestId?: string): Promise<string> {
    // Validate base repository path
    const validatedBasePath = await validateWorkspacePath(basePath, requestId);

    // Create unique worktree directory
    const uuid = crypto.randomUUID();
    const worktreePath = path.join(this.baseDir, `wt-${uuid}`);

    // Validate worktree path
    const validatedWorktreePath = await validateWorkspacePath(worktreePath, requestId);

    try {
      // Create worktree using execFile (not exec)
      await execFileAsync('git', [
        'worktree',
        'add',
        validatedWorktreePath,
        'HEAD',
      ], {
        cwd: validatedBasePath,
        timeout: 60000, // 1 minute timeout
      });

      // Post-creation validation
      const realPath = await fs.realpath(validatedWorktreePath);
      if (!realPath.startsWith(this.baseDir + path.sep)) {
        await fs.rm(validatedWorktreePath, { recursive: true, force: true });
        throw new Error('Security violation detected');
      }

      securityLogger.info('Git worktree created securely', {
        requestId,
        timestamp: new Date().toISOString(),
      });

      return realPath;
    } catch (error) {
      await fs.rm(validatedWorktreePath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Clean up workspace with path validation
   * SECURITY: Prevent deletion of system directories
   */
  async cleanup(workspacePath: string, requestId?: string): Promise<void> {
    // Validate path before deletion
    const validatedPath = await validateWorkspacePath(workspacePath, requestId);

    // Additional safety check: ensure it's actually a workspace directory
    const basename = path.basename(validatedPath);
    const isWorkspaceDir = basename.startsWith('gh-') ||
                           basename.startsWith('wt-') ||
                           validatedPath.includes('claude-workspaces');

    if (!isWorkspaceDir) {
      securityLogger.error('Attempted to delete non-workspace directory', {
        requestId,
        timestamp: new Date().toISOString(),
      });
      throw new Error('Invalid cleanup target');
    }

    await fs.rm(validatedPath, { recursive: true, force: true });

    securityLogger.info('Workspace cleaned up', {
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Calculate directory size recursively
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;
    const files = await fs.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
      const filePath = path.join(dirPath, file.name);

      if (file.isDirectory()) {
        totalSize += await this.getDirectorySize(filePath);
      } else {
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }
    }

    return totalSize;
  }
}
```

**Key Security Enhancements:**
- ✅ Post-creation TOCTOU validation on all operations
- ✅ `execFile()` instead of `exec()` (prevents shell injection)
- ✅ Timeout and size limits on Git operations
- ✅ Enhanced GitHub repo validation (no dots bypass)
- ✅ Request ID correlation in all logs
- ✅ Comprehensive cleanup validation

---

#### Module 3: Validation Middleware (`src/middleware/validation.ts`)

**ENHANCED SECURITY FEATURES:**

```typescript
import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { validateWorkspacePath, isAllowedPath } from '../utils/pathValidation';
import { createLogger } from '../utils/logger';

const securityLogger = createLogger('security');

// CRITICAL FIX #7: Rate limiting on workspace creation
export const workspaceCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window
  message: 'Too many workspace creation requests',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    securityLogger.warn('Rate limit exceeded for workspace creation', {
      ip: req.ip,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });

    res.status(429).json({
      error: 'Too many requests',
      details: 'Please try again later',
    });
  },
});

/**
 * Validate session creation request
 * SECURITY: Input validation and sanitization
 */
export async function validateSessionCreate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { projectType, projectPath, githubRepo, basePath } = req.body;

  // Validate project type
  const allowedTypes = ['github', 'local', 'e2b', 'worktree'];
  if (!allowedTypes.includes(projectType)) {
    securityLogger.warn('Invalid project type', {
      projectType,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });

    res.status(400).json({
      error: 'Invalid request',
      details: 'Project type not allowed',
    });
    return;
  }

  // Type-specific validation
  try {
    switch (projectType) {
      case 'github':
        // CRITICAL FIX #4: Enhanced GitHub repo validation
        if (!githubRepo || typeof githubRepo !== 'string') {
          throw new Error('GitHub repository required');
        }

        if (!/^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*[a-zA-Z0-9]$/.test(githubRepo)) {
          throw new Error('Invalid repository format');
        }

        if (githubRepo.includes('..')) {
          throw new Error('Invalid repository format');
        }
        break;

      case 'local':
        // Validate local path
        if (!projectPath || typeof projectPath !== 'string') {
          throw new Error('Project path required');
        }

        // Prevent obviously malicious paths
        if (projectPath.includes('..') || projectPath.includes('\0')) {
          securityLogger.warn('Malicious path detected', {
            requestId: req.id,
            timestamp: new Date().toISOString(),
          });
          throw new Error('Invalid path');
        }

        // Validate path (will throw if invalid)
        const validatedPath = await validateWorkspacePath(projectPath, req.id);

        // Check allowlist
        if (!isAllowedPath(validatedPath)) {
          throw new Error('Path not allowed');
        }
        break;

      case 'worktree':
        // Validate base path for worktree
        if (!basePath || typeof basePath !== 'string') {
          throw new Error('Base path required');
        }

        if (basePath.includes('..') || basePath.includes('\0')) {
          throw new Error('Invalid path');
        }

        await validateWorkspacePath(basePath, req.id);
        break;

      case 'e2b':
        // E2B sandbox - no path validation needed
        break;
    }

    // Validation passed
    next();
  } catch (error) {
    securityLogger.warn('Session validation failed', {
      projectType,
      error: error.message,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });

    res.status(400).json({
      error: 'Invalid request',
      details: 'Validation failed',
    });
  }
}

/**
 * Add request ID middleware for correlation
 */
export function addRequestId(req: Request, res: Response, next: NextFunction): void {
  req.id = req.id || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}
```

**Key Security Enhancements:**
- ✅ Rate limiting (10 requests per 15 minutes per IP)
- ✅ Request ID correlation for audit trails
- ✅ Comprehensive input validation per project type
- ✅ Null byte injection prevention
- ✅ Path traversal detection in middleware layer
- ✅ Security event logging

---

#### Module 4: Logger Utility (`src/utils/logger.ts`)

**NEW MODULE FOR SECURITY LOGGING:**

```typescript
import fs from 'fs';
import path from 'path';

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'critical';
  category: string;
  message: string;
  metadata?: Record<string, any>;
  timestamp: string;
}

export class Logger {
  private category: string;
  private logDir: string;

  constructor(category: string) {
    this.category = category;
    this.logDir = process.env.LOG_DIR || '/var/log/claude-orchestrator';

    // Ensure log directory exists
    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o750 });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  private log(level: LogEntry['level'], message: string, metadata?: Record<string, any>): void {
    const entry: LogEntry = {
      level,
      category: this.category,
      message,
      metadata,
      timestamp: new Date().toISOString(),
    };

    // Console output (structured for parsing)
    console.log(JSON.stringify(entry));

    // File output (for audit trail)
    if (this.category === 'security') {
      const logFile = path.join(this.logDir, 'security.log');
      const logLine = JSON.stringify(entry) + '\n';

      try {
        fs.appendFileSync(logFile, logLine, { mode: 0o640 });
      } catch (error) {
        console.error('Failed to write security log:', error);
      }
    }
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, any>): void {
    this.log('error', message, metadata);
  }

  critical(message: string, metadata?: Record<string, any>): void {
    this.log('critical', message, metadata);
  }
}

export function createLogger(category: string): Logger {
  return new Logger(category);
}
```

---

### Phase 3: API Integration

**Update `src/api/routes.ts`:**

```typescript
import { Router } from 'express';
import { Pool } from 'pg';
import { WorkspaceManager } from '../services/workspace';
import {
  validateSessionCreate,
  workspaceCreationLimiter,
  addRequestId
} from '../middleware/validation';
import { createLogger } from '../utils/logger';

const logger = createLogger('api');

export function createRouter(db: Pool): Router {
  const router = Router();
  const workspaceManager = new WorkspaceManager();

  // Add request ID to all requests
  router.use(addRequestId);

  // Apply rate limiting to session creation
  router.post('/sessions',
    workspaceCreationLimiter,
    validateSessionCreate,
    async (req, res) => {
      try {
        logger.info('Session creation started', {
          requestId: req.id,
          projectType: req.body.projectType,
        });

        // Prepare workspace with full security validation
        const workspacePath = await workspaceManager.prepareWorkspace(
          req.body,
          req.id
        );

        // Create session in database
        const result = await db.query(
          `INSERT INTO sessions (project_path, status, metadata)
           VALUES ($1, $2, $3) RETURNING id`,
          [workspacePath, 'initializing', JSON.stringify({
            projectType: req.body.projectType,
            requestId: req.id,
            createdAt: new Date().toISOString(),
          })]
        );

        logger.info('Session created successfully', {
          requestId: req.id,
          sessionId: result.rows[0].id,
        });

        res.status(201).json({
          sessionId: result.rows[0].id,
          workspacePath,
          requestId: req.id,
        });
      } catch (error) {
        logger.error('Session creation failed', {
          requestId: req.id,
          error: error.message,
        });

        res.status(400).json({
          error: 'Session creation failed',
          details: 'Invalid request',
          requestId: req.id,
        });
      }
    }
  );

  return router;
}
```

---

### Phase 4: Comprehensive Security Testing

**Test Suite Requirements:**

1. **Unit Tests** (`src/__tests__/pathValidation.test.ts`):
   - ✅ Path traversal attempts (`../`, `..%2F`, etc.)
   - ✅ Symlink escape attempts
   - ✅ Path separator bypass (`/tmp/workspaces-hacked`)
   - ✅ Null byte injection (`path\0/etc/passwd`)
   - ✅ Cross-platform path handling

2. **Security Tests** (`src/__tests__/security.test.ts`):
   - ✅ TOCTOU race condition simulation
   - ✅ GitHub repo command injection attempts
   - ✅ Allowlist bypass attempts
   - ✅ Rate limiting enforcement
   - ✅ Size limit enforcement

3. **Integration Tests** (`src/__tests__/workspace.test.ts`):
   - ✅ End-to-end workspace creation flows
   - ✅ Error handling and cleanup
   - ✅ Logging and audit trail verification

**Coverage Target**: >85% with 100% pass rate

---

### Phase 5: Environment Configuration

**Update `.env.example`:**

```bash
# CRITICAL: Workspace base directory (REQUIRED)
# Must be explicitly set - no default for security
# Recommended: dedicated directory with chmod 700
WORKSPACE_BASE=/opt/claude-workspaces

# API Server
API_PORT=3001

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/claude_orchestrator

# Logging
LOG_DIR=/var/log/claude-orchestrator

# Security
# Rate limiting: requests per window per IP
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10

# Resource Limits
MAX_REPO_SIZE_BYTES=1073741824  # 1GB
GIT_CLONE_TIMEOUT_MS=300000      # 5 minutes
```

**Update Deployment Documentation:**

- Document workspace base setup with secure permissions
- Add security logging configuration
- Include monitoring and alerting recommendations
- Provide incident response procedures

---

## Updated Security Checklist

### Critical Security Controls:
- [x] ✅ Symlink protection using `fs.realpath()`
- [x] ✅ TOCTOU mitigation with post-creation validation
- [x] ✅ Path separator in all `startsWith()` checks
- [x] ✅ Enhanced GitHub repo validation (no dots bypass)
- [x] ✅ Explicit WORKSPACE_BASE requirement
- [x] ✅ Security event logging with request correlation
- [x] ✅ Rate limiting on workspace creation
- [x] ✅ Resource limits (timeout, size) on Git operations
- [x] ✅ Generic error messages (no path disclosure)
- [x] ✅ Cross-platform path handling
- [x] ✅ Permission validation on workspace base

### Defense-in-Depth Layers:
1. ✅ **Layer 1**: Path validation utility (symlink + traversal protection)
2. ✅ **Layer 2**: Request validation middleware (input sanitization + rate limiting)
3. ✅ **Layer 3**: WorkspaceManager service (TOCTOU mitigation + resource limits)

---

## Ready for Phase 2 Implementation

**Status**: ✅ **READY TO PROCEED**

All critical security vulnerabilities have been addressed in the updated plan. Proceeding to Phase 2 implementation with security-hardened modules.
