# Security Attack Vector Prevention Tests

This directory contains comprehensive security tests that validate defense-in-depth protections against real-world attack vectors in the claude-orchestrator workspace management system.

## Overview

The test suite (`attack-vectors.test.ts`) implements **real filesystem operations** (no mocks) to validate that security controls actually work in practice. Each test attempts a genuine attack and verifies it's properly blocked with appropriate logging and error handling.

## Prerequisites

### Required Dependencies

```bash
npm install --save-dev jest @types/jest ts-jest
```

### Jest Configuration

Create `jest.config.js` in the project root:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**'
  ],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85
    }
  }
};
```

### Update package.json

Add test script to `package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:security": "jest src/__tests__/security",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

## Running the Tests

### Run All Security Tests

```bash
npm run test:security
```

### Run Specific Test Suite

```bash
npm test -- --testNamePattern="Path Traversal"
npm test -- --testNamePattern="Symlink Attack"
npm test -- --testNamePattern="Command Injection"
```

### Run with Coverage

```bash
npm run test:coverage -- src/__tests__/security
```

### Run in Watch Mode (Development)

```bash
npm run test:watch -- src/__tests__/security
```

## Test Coverage

### Attack Vector Categories

#### 1. Path Traversal Attacks (10 tests)
- ✅ Basic `../` traversal sequences
- ✅ URL-encoded traversal (`%2e%2e%2f`)
- ✅ Double URL-encoded traversal
- ✅ Unicode path traversal (U+2215, U+FF0E)
- ✅ Path separator bypass (`workspaces-evil` vs `workspaces/`)
- ✅ Null byte injection (`\0`)
- ✅ Backslash traversal (Windows-style)
- ✅ Mixed separator traversal
- ✅ Absolute paths outside workspace
- ✅ Valid paths within workspace (positive test)

#### 2. Symlink Attack Prevention (5 tests)
- ✅ Symlink pointing outside workspace
- ✅ Parent directory symlink escape
- ✅ TOCTOU race conditions (symlink created after validation)
- ✅ Symlink in parent directory chain
- ✅ Internal symlinks within workspace (positive test)

#### 3. Command Injection Prevention (8 tests)
- ✅ Shell metacharacters (`;`, `&&`, `|`)
- ✅ Backtick command substitution
- ✅ `$()` command substitution
- ✅ Pipe operators (`|`, `||`, `|&`)
- ✅ Redirect operators (`>`, `>>`, `<`, `2>&1`)
- ✅ Path traversal in repo names
- ✅ Valid GitHub repo names (positive test)
- ✅ Code verification: `execFile` vs `exec` usage

#### 4. Resource Exhaustion Prevention (6 tests)
- ✅ Git clone timeout enforcement
- ✅ Repository size limit enforcement
- ✅ Timeout configuration verification
- ✅ MaxBuffer limit verification
- ✅ Cleanup on failed operations
- ✅ Deep directory traversal handling

#### 5. Security Event Logging (7 tests)
- ✅ Path traversal logging
- ✅ Symlink escape logging
- ✅ Command injection logging
- ✅ Request ID correlation
- ✅ No sensitive path disclosure in logs
- ✅ Workspace creation logging
- ✅ Cleanup operation logging

#### 6. Information Disclosure Prevention (4 tests)
- ✅ Generic errors for path traversal
- ✅ Generic errors for symlink attacks
- ✅ Generic errors for command injection
- ✅ No internal paths in stack traces

#### 7. Edge Cases and Boundary Conditions (7 tests)
- ✅ Empty path handling
- ✅ Null byte handling
- ✅ Extremely long paths
- ✅ Special character handling
- ✅ Concurrent validation requests
- ✅ Case-sensitive path handling (Unix)
- ✅ Base directory permission validation

**Total: 47 comprehensive security tests**

## Test Design Principles

### 1. Real Operations, No Mocks
All tests use actual filesystem operations to validate real security behavior:
- Create real directories and symlinks
- Execute actual path validation logic
- Verify genuine security controls

### 2. Isolated Test Environments
Each test runs in a unique temporary directory:
- No test pollution or interference
- Automatic cleanup after each test
- Safe to run in parallel (future enhancement)

### 3. Security Event Verification
Tests verify not just that attacks are blocked, but also:
- Security events are properly logged
- Logs contain request IDs for correlation
- Sensitive information is not disclosed in errors

### 4. Positive and Negative Tests
Test suite includes both:
- **Negative tests**: Verify attacks are blocked
- **Positive tests**: Verify legitimate operations work

### 5. Defense-in-Depth Validation
Tests verify multiple layers of security:
- Input validation
- Path resolution and normalization
- Symlink resolution
- Allowlist verification
- Post-creation validation (TOCTOU mitigation)

## Understanding Test Output

### Successful Test Run
```
 PASS  src/__tests__/security/attack-vectors.test.ts
  Security Attack Vector Prevention
    Path Traversal Attack Prevention
      ✓ should block basic path traversal with ../ (15ms)
      ✓ should block URL-encoded path traversal (%2e%2e%2f) (8ms)
      ...
    Symlink Attack Prevention
      ✓ should block symlink pointing outside workspace (25ms)
      ...

Test Suites: 1 passed, 1 total
Tests:       47 passed, 47 total
```

### Failed Security Control
If a test fails, it indicates a security vulnerability:

```
 FAIL  src/__tests__/security/attack-vectors.test.ts
  ● Path Traversal Attack Prevention › should block basic path traversal

    Expected function to throw error, but it succeeded

      65 |       const maliciousPath = path.join(testBaseDir, '../../../etc/passwd');
      66 |
    > 67 |       await expect(validateWorkspacePath(maliciousPath)).rejects.toThrow();
         |             ^
```

**This indicates a CRITICAL security vulnerability that must be fixed immediately.**

## Common Test Scenarios

### Testing Path Traversal Protection

```typescript
// Attack attempt
const maliciousPath = path.join(testBaseDir, '../../../etc/passwd');

// Should be blocked
await expect(validateWorkspacePath(maliciousPath)).rejects.toThrow();

// Verify generic error message (no info disclosure)
try {
  await validateWorkspacePath(maliciousPath);
} catch (error) {
  expect(error.message).toBe('Invalid workspace path');
  expect(error.message).not.toContain('/etc/passwd');
}

// Verify security event was logged
const logs = capturedLogs.filter(log => log.level === 'warn');
expect(logs.length).toBeGreaterThan(0);
```

### Testing Symlink Protection

```typescript
// Create malicious symlink
const symlinkPath = path.join(testBaseDir, 'evil-link');
await fs.symlink('/etc', symlinkPath);

// Attempt to access through symlink
const targetPath = path.join(symlinkPath, 'passwd');

// Should be blocked
await expect(validateWorkspacePath(targetPath)).rejects.toThrow();

// Verify symlink escape was detected
const symlinkLogs = capturedLogs.filter(log =>
  log.message.includes('Symlink')
);
expect(symlinkLogs.length).toBeGreaterThan(0);
```

### Testing Command Injection Protection

```typescript
const manager = new WorkspaceManager(testBaseDir);

// Attempt command injection via repo name
const maliciousRepo = 'user/repo; rm -rf /';

// Should be blocked at validation stage
await expect(
  manager.cloneGitHubRepo(maliciousRepo, 'test-request-id')
).rejects.toThrow('Invalid repository format');
```

## Security Logging Verification

Tests verify that all security events are logged with:

1. **Request ID**: For correlation across distributed systems
2. **Timestamp**: For audit trail and incident response
3. **Event Type**: Categorization (warn, error, critical)
4. **Generic Messages**: No sensitive information disclosure

Example log entry:
```json
{
  "level": "warn",
  "category": "security",
  "message": "Path traversal attempt blocked",
  "metadata": {
    "requestId": "test-abc-123",
    "timestamp": "2025-12-12T10:30:45.123Z"
  }
}
```

## Troubleshooting

### Tests Fail on Windows
Some tests are skipped on Windows (symlink tests require admin privileges):
```typescript
if (process.platform !== 'win32') {
  // Symlink tests only on Unix
}
```

### Permission Denied Errors
Ensure test user has permission to create files in `/tmp`:
```bash
chmod 755 /tmp
```

Or set custom test directory:
```typescript
// Tests automatically create unique temp directories
```

### Git Command Not Found
Some tests require `git` CLI to be installed:
```bash
# Ubuntu/Debian
sudo apt-get install git

# macOS
brew install git
```

### Jest Not Found
Install Jest dependencies:
```bash
npm install --save-dev jest @types/jest ts-jest
```

## Security Best Practices Demonstrated

These tests validate critical security patterns:

1. **Input Validation**: All user inputs validated before use
2. **Path Canonicalization**: Resolve symlinks and normalize paths
3. **Allowlist Validation**: Additional defense-in-depth layer
4. **TOCTOU Mitigation**: Post-creation validation
5. **Generic Error Messages**: Prevent information disclosure
6. **Security Logging**: Audit trail for incident response
7. **execFile vs exec**: No shell injection surface
8. **Resource Limits**: Timeout and size constraints
9. **Automatic Cleanup**: No artifacts left on failure
10. **Request Correlation**: Request IDs for distributed tracing

## Integration with CI/CD

Add to GitHub Actions workflow (`.github/workflows/security-tests.yml`):

```yaml
name: Security Tests

on: [push, pull_request]

jobs:
  security-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run test:security
      - run: npm run test:coverage

      # Fail if coverage below 85%
      - name: Check coverage
        run: |
          npm run test:coverage -- --coverageThreshold='{"global":{"branches":85,"functions":85,"lines":85,"statements":85}}'
```

## Further Reading

- [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)
- [OWASP Command Injection](https://owasp.org/www-community/attacks/Command_Injection)
- [CWE-367: TOCTOU Race Condition](https://cwe.mitre.org/data/definitions/367.html)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

## Contributing

When adding new security tests:

1. Follow existing test structure
2. Use real filesystem operations (no mocks)
3. Verify security event logging
4. Check for information disclosure
5. Include both positive and negative tests
6. Document the attack vector being tested
7. Add cleanup in `afterEach` hook

## License

Same as parent project.
