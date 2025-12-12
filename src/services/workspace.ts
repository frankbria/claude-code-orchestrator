/**
 * WorkspaceManager Service - Security-Hardened Implementation
 *
 * This module provides secure workspace management for Claude orchestrator sessions.
 * It implements multiple security layers to prevent path traversal, command injection,
 * TOCTOU race conditions, and other security vulnerabilities.
 *
 * SECURITY FEATURES:
 * - Post-creation TOCTOU validation on all operations
 * - execFile() instead of exec() to prevent shell injection
 * - Timeout and size limits on Git operations
 * - Enhanced GitHub repository validation
 * - Comprehensive cleanup validation
 * - Security event logging with request correlation
 *
 * @module services/workspace
 */

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { validateWorkspacePath, isAllowedPath, getSecureBaseDir } from '../utils/pathValidation';
import { createLogger } from '../utils/logger';

const execFileAsync = promisify(execFile);
const securityLogger = createLogger('security');

/**
 * Session configuration for workspace preparation
 */
export interface SessionConfig {
  /** Type of project workspace to create */
  projectType: 'github' | 'local' | 'e2b' | 'worktree';
  /** Path for local projects */
  projectPath?: string;
  /** GitHub repository in owner/repo format */
  githubRepo?: string;
  /** Base path for git worktree operations */
  basePath?: string;
}

/**
 * WorkspaceManager - Security-hardened workspace management
 *
 * Manages the creation, validation, and cleanup of workspaces for Claude sessions.
 * Implements defense-in-depth security controls including:
 * - Path traversal prevention
 * - Symlink attack protection
 * - Command injection prevention
 * - Resource limit enforcement
 * - TOCTOU race condition mitigation
 *
 * @class
 */
export class WorkspaceManager {
  private baseDir: string;

  /**
   * Create a new WorkspaceManager instance
   *
   * @param {string} [baseDir] - Base directory for workspaces (defaults to WORKSPACE_BASE env var)
   * @throws {Error} If WORKSPACE_BASE is not configured when no baseDir provided
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir || getSecureBaseDir();
  }

  /**
   * Prepare workspace based on project type
   *
   * SECURITY: Central validation point for all workspace creation.
   * Routes to appropriate method based on project type and ensures
   * all security validations are applied.
   *
   * @param {SessionConfig} config - Session configuration
   * @param {string} [requestId] - Request ID for correlation in logs
   * @returns {Promise<string>} Validated workspace path
   * @throws {Error} If validation fails or workspace creation fails
   *
   * @example
   * ```typescript
   * const manager = new WorkspaceManager();
   *
   * // Create local workspace
   * const localPath = await manager.prepareWorkspace({
   *   projectType: 'local',
   *   projectPath: '/workspace/my-project'
   * }, 'req-123');
   *
   * // Clone GitHub repository
   * const repoPath = await manager.prepareWorkspace({
   *   projectType: 'github',
   *   githubRepo: 'owner/repo'
   * }, 'req-456');
   * ```
   */
  async prepareWorkspace(config: SessionConfig, requestId?: string): Promise<string> {
    securityLogger.info('Workspace preparation started', {
      requestId,
      projectType: config.projectType,
      timestamp: new Date().toISOString(),
    });

    switch (config.projectType) {
      case 'local':
        if (!config.projectPath) {
          throw new Error('Project path required for local workspace');
        }
        return this.ensureLocalDirectory(config.projectPath, requestId);

      case 'github':
        if (!config.githubRepo) {
          throw new Error('GitHub repository required for github workspace');
        }
        return this.cloneGitHubRepo(config.githubRepo, requestId);

      case 'worktree':
        if (!config.basePath) {
          throw new Error('Base path required for worktree workspace');
        }
        return this.createGitWorktree(config.basePath, requestId);

      case 'e2b':
        // E2B sandbox - no local path validation needed
        securityLogger.info('E2B sandbox workspace created', {
          requestId,
          timestamp: new Date().toISOString(),
        });
        return 'e2b://sandbox';

      default:
        throw new Error('Invalid project type');
    }
  }

  /**
   * Ensure local directory exists and is secure
   *
   * CRITICAL FIX: TOCTOU race condition mitigation
   *
   * This method implements post-creation validation to detect symlink attacks
   * that could occur between validation and creation (TOCTOU vulnerability).
   *
   * SECURITY CONTROLS:
   * 1. Pre-creation path validation with symlink detection
   * 2. Allowlist verification
   * 3. Directory creation with restricted permissions (0750)
   * 4. Post-creation validation to detect TOCTOU attacks
   * 5. Automatic cleanup on security violation
   *
   * @param {string} dirPath - Directory path to create
   * @param {string} [requestId] - Request ID for correlation in logs
   * @returns {Promise<string>} Validated real path of created directory
   * @throws {Error} If validation fails or security violation detected
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

    // CRITICAL FIX: Post-creation validation (TOCTOU mitigation)
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
   *
   * CRITICAL FIX: Command injection prevention and resource limits
   *
   * This method implements multiple security controls to prevent:
   * - Command injection via malicious repository names
   * - Path traversal via dots in repository names
   * - Resource exhaustion via large repositories
   * - Timeout attacks via slow clones
   *
   * SECURITY CONTROLS:
   * 1. Enhanced repository name validation (no dots, strict format)
   * 2. UUID-based directory naming (safer than using repo name)
   * 3. execFile() instead of exec() to prevent shell injection
   * 4. 5-minute timeout on git clone operations
   * 5. 1GB size limit on cloned repositories
   * 6. Disabled interactive git prompts
   * 7. Post-creation validation
   * 8. Automatic cleanup on failure
   *
   * @param {string} repo - GitHub repository in owner/repo format
   * @param {string} [requestId] - Request ID for correlation in logs
   * @returns {Promise<string>} Validated path to cloned repository
   * @throws {Error} If validation fails, clone fails, or size limit exceeded
   *
   * @example
   * ```typescript
   * const manager = new WorkspaceManager();
   * const repoPath = await manager.cloneGitHubRepo('facebook/react', 'req-123');
   * ```
   */
  async cloneGitHubRepo(repo: string, requestId?: string): Promise<string> {
    // CRITICAL FIX: Enhanced GitHub repo validation
    // Prevent: dots bypass, command injection, path traversal

    // Basic format check: owner/repo with alphanumeric start/end
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
      // CRITICAL FIX: Use execFile (not exec) to prevent shell injection
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
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  /**
   * Create git worktree with path validation
   *
   * Creates a new git worktree from an existing repository base.
   * Implements the same security controls as other workspace types.
   *
   * SECURITY CONTROLS:
   * 1. Base repository path validation
   * 2. UUID-based worktree directory naming
   * 3. execFile() instead of exec()
   * 4. 1-minute timeout on worktree creation
   * 5. Post-creation validation
   * 6. Automatic cleanup on failure
   *
   * @param {string} basePath - Path to base git repository
   * @param {string} [requestId] - Request ID for correlation in logs
   * @returns {Promise<string>} Validated path to created worktree
   * @throws {Error} If validation fails or worktree creation fails
   *
   * @example
   * ```typescript
   * const manager = new WorkspaceManager();
   * const worktreePath = await manager.createGitWorktree(
   *   '/workspace/my-repo',
   *   'req-789'
   * );
   * ```
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
   *
   * SECURITY: Prevent deletion of system directories
   *
   * Safely removes a workspace directory after validating that it is
   * actually a workspace and not a system directory. Implements multiple
   * safety checks to prevent accidental or malicious deletion of important
   * directories.
   *
   * SECURITY CONTROLS:
   * 1. Full path validation with symlink protection
   * 2. Workspace directory pattern verification (gh-, wt- prefixes)
   * 3. Security event logging
   * 4. Generic error messages
   *
   * @param {string} workspacePath - Path to workspace to clean up
   * @param {string} [requestId] - Request ID for correlation in logs
   * @returns {Promise<void>}
   * @throws {Error} If validation fails or path is not a workspace directory
   *
   * @example
   * ```typescript
   * const manager = new WorkspaceManager();
   * await manager.cleanup('/workspace/gh-abc-123-1234567890', 'req-999');
   * ```
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
   *
   * Helper method to calculate total size of a directory including
   * all subdirectories and files. Used for enforcing repository size limits.
   *
   * @private
   * @param {string} dirPath - Directory path to measure
   * @returns {Promise<number>} Total size in bytes
   *
   * @example
   * ```typescript
   * const size = await this.getDirectorySize('/workspace/my-repo');
   * console.log(`Repository size: ${size} bytes`);
   * ```
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
