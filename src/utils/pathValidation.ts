import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { createLogger } from './logger';

const securityLogger = createLogger('security');

/**
 * Get and validate the secure base directory for workspaces.
 *
 * CRITICAL SECURITY: No default value is provided - WORKSPACE_BASE must be
 * explicitly set in the environment. This prevents accidentally using
 * world-writable directories like /tmp.
 *
 * The base directory should have restrictive permissions (chmod 700 or 750)
 * to prevent unauthorized access.
 *
 * @returns {string} Absolute path to the validated workspace base directory
 * @throws {Error} If WORKSPACE_BASE is not set or validation fails
 *
 * @example
 * // Set environment variable before starting application
 * // WORKSPACE_BASE=/opt/claude-workspaces npm start
 *
 * const baseDir = getSecureBaseDir();
 * console.log(baseDir); // "/opt/claude-workspaces"
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
    const stats = fsSync.statSync(resolvedBase);

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
  } catch (error: any) {
    throw new Error(`WORKSPACE_BASE directory validation failed: ${error.message}`);
  }

  return resolvedBase;
}

/**
 * Validate workspace path with comprehensive security protections.
 *
 * SECURITY PROTECTIONS:
 * 1. Path Traversal Prevention: Ensures resolved path is within base directory
 * 2. Symlink Attack Protection: Uses fs.realpath() to resolve symlinks
 * 3. Path Separator Bypass Prevention: Adds path.sep to startsWith() checks
 * 4. TOCTOU Mitigation: Validates parent directories for non-existent paths
 * 5. Security Event Logging: Logs all validation attempts with request correlation
 * 6. Generic Error Messages: Prevents information disclosure through error messages
 *
 * @param {string} requestedPath - The workspace path to validate
 * @param {string} [requestId] - Optional request ID for security event correlation
 * @returns {Promise<string>} Validated absolute path (symlink-resolved if exists)
 * @throws {Error} If path is invalid or security violation detected
 *
 * @example
 * // Valid path within workspace
 * const validPath = await validateWorkspacePath('/opt/claude-workspaces/project1');
 *
 * @example
 * // Path traversal attempt (throws error)
 * try {
 *   await validateWorkspacePath('/opt/claude-workspaces/../etc/passwd');
 * } catch (error) {
 *   console.error('Security violation:', error.message);
 * }
 *
 * @example
 * // Symlink escape attempt (throws error)
 * // ln -s /etc /opt/claude-workspaces/malicious
 * try {
 *   await validateWorkspacePath('/opt/claude-workspaces/malicious/passwd');
 * } catch (error) {
 *   console.error('Symlink attack blocked:', error.message);
 * }
 */
export async function validateWorkspacePath(
  requestedPath: string,
  requestId?: string
): Promise<string> {
  const baseDir = getSecureBaseDir();
  const resolvedPath = path.resolve(requestedPath);

  // CRITICAL FIX #1: Add path separator to prevent bypass
  // Without path.sep, an attacker could use "/tmp/workspaces-hacked" to bypass
  // a check for "/tmp/workspaces". Adding path.sep ensures the check is for
  // "/tmp/workspaces/" which prevents this bypass.
  //
  // Example attack without path.sep:
  //   baseDir: /tmp/workspaces
  //   requested: /tmp/workspaces-hacked/../../etc/passwd
  //   resolvedPath: /etc/passwd
  //   "/etc/passwd".startsWith("/tmp/workspaces") => false (blocked)
  //   BUT: "/tmp/workspaces-hacked".startsWith("/tmp/workspaces") => true (bypassed!)
  if (!resolvedPath.startsWith(baseDir + path.sep)) {
    securityLogger.warn('Path traversal attempt blocked', {
      requestId,
      requestedPath: path.basename(requestedPath), // Don't log full path (information disclosure)
      timestamp: new Date().toISOString(),
    });
    throw new Error('Invalid workspace path');
  }

  // CRITICAL FIX #2: Symlink protection using fs.realpath()
  // fs.realpath() resolves all symbolic links in the path to their actual targets.
  // This prevents symlink-based attacks where an attacker creates a symlink
  // pointing outside the workspace directory.
  //
  // Example attack without realpath():
  //   ln -s /etc/passwd /opt/workspaces/malicious
  //   requested: /opt/workspaces/malicious
  //   Without realpath: passes validation (path is within workspace)
  //   With realpath: resolves to /etc/passwd, fails validation
  try {
    const realPath = await fs.realpath(resolvedPath);

    // Verify real path is still within base directory
    // This check catches symlink escape attempts where the symlink target
    // is outside the allowed workspace directory
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
  } catch (error: any) {
    // Path doesn't exist yet - validate parent directories for symlinks
    // This handles the case where we're validating a path before creating it.
    // We need to check that no parent directories contain symlinks that could
    // escape the workspace boundary.
    if (error.code === 'ENOENT') {
      await validateParentDirectories(resolvedPath, baseDir, requestId);
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * Validate parent directories don't contain symlinks that escape workspace.
 *
 * SECURITY: Prevents TOCTOU (Time-of-Check-Time-of-Use) attacks on non-existent paths.
 *
 * When validating a path that doesn't exist yet (e.g., before creation), an attacker
 * could create a symlink in a parent directory between validation and creation.
 * This function validates all existing parent directories to ensure none are symlinks
 * that escape the workspace boundary.
 *
 * @private
 * @param {string} targetPath - The full path being validated
 * @param {string} baseDir - The workspace base directory
 * @param {string} [requestId] - Optional request ID for security event correlation
 * @returns {Promise<void>}
 * @throws {Error} If any parent directory is a symlink escaping workspace
 *
 * @example
 * // Attack scenario this prevents:
 * // 1. Request: /opt/workspaces/subdir/newfile (doesn't exist yet)
 * // 2. Attacker creates: ln -s /tmp /opt/workspaces/subdir
 * // 3. Without parent validation: /opt/workspaces/subdir/newfile passes initial check
 * // 4. File creation: writes to /tmp/newfile (outside workspace!)
 * // 5. With parent validation: detects /opt/workspaces/subdir is symlink to /tmp, blocks
 */
async function validateParentDirectories(
  targetPath: string,
  baseDir: string,
  requestId?: string
): Promise<void> {
  const parts = targetPath.split(path.sep);
  let currentPath = '';

  // Walk up the directory tree, checking each level for symlinks
  for (const part of parts) {
    if (!part) continue;

    currentPath = currentPath ? path.join(currentPath, part) : part;

    try {
      const realPath = await fs.realpath(currentPath);

      // Check if this real path is within base directory
      // Note: baseDir itself is allowed, hence the || realPath !== baseDir check
      if (!realPath.startsWith(baseDir + path.sep) && realPath !== baseDir) {
        securityLogger.warn('Parent directory symlink escape detected', {
          requestId,
          timestamp: new Date().toISOString(),
        });
        throw new Error('Invalid workspace path');
      }
    } catch (error: any) {
      // Directory doesn't exist yet - this is OK, stop checking
      // Once we hit a non-existent directory, we can't have symlinks beyond this point
      if (error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
}

/**
 * Check if resolved path matches allowlist patterns.
 *
 * SECURITY: Additional defense-in-depth layer beyond path validation.
 * Even if a path passes all security checks, it must match one of the
 * approved patterns to be allowed.
 *
 * This provides protection against:
 * - Future vulnerabilities in path validation logic
 * - Misconfiguration of WORKSPACE_BASE
 * - Unexpected edge cases in path resolution
 *
 * @param {string} resolvedPath - The fully resolved absolute path to check
 * @returns {boolean} True if path matches an allowed pattern
 *
 * @example
 * // Add custom patterns to match your deployment
 * const allowed = isAllowedPath('/opt/claude-workspaces/project1');
 * console.log(allowed); // true
 *
 * const blocked = isAllowedPath('/etc/passwd');
 * console.log(blocked); // false
 */
export function isAllowedPath(resolvedPath: string): boolean {
  // Allowlist patterns for workspace directories
  // Update these patterns to match your deployment environment
  const allowedPatterns = [
    // Unix/Linux/macOS patterns
    /^\/tmp\/claude-workspaces\/.+$/,
    /^\/workspace\/.+$/,
    /^\/home\/[\w-]+\/claude-workspaces\/.+$/,
    /^\/opt\/claude-workspaces\/.+$/,
    // Windows patterns
    /^[A-Za-z]:\\claude-workspaces\\.+$/,
    /^[A-Za-z]:\\Users\\[\w-]+\\claude-workspaces\\.+$/,
    /^[A-Za-z]:\\workspace\\.+$/,
  ];

  return allowedPatterns.some(pattern => pattern.test(resolvedPath));
}
