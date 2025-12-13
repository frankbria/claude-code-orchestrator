# Claude Orchestrator Test Suite

## Overview

This directory contains comprehensive integration tests for the Claude Orchestrator workspace creation flows. The tests verify end-to-end functionality with real file system operations, security validations, and API endpoint integration.

## Test Structure

```text
__tests__/
├── integration/
│   └── workspace.test.ts    # End-to-end workspace creation tests
└── README.md                # This file
```

## Test Coverage

### WorkspaceManager Integration Tests

1. **Local Workspace Creation**
   - Valid path creation within WORKSPACE_BASE
   - Directory creation with correct permissions (0750)
   - Post-creation validation (TOCTOU mitigation)
   - Idempotency (calling twice with same path)
   - Path traversal attack prevention
   - Rejection of paths outside WORKSPACE_BASE

2. **GitHub Repository Cloning**
   - Valid small public repository cloning
   - Invalid repository format rejection
   - Consecutive dots rejection
   - Size limit enforcement (1GB max)
   - Cleanup on clone failure
   - Timeout handling for slow clones
   - Command injection prevention

3. **Git Worktree Creation**
   - Worktree creation from existing repository
   - Base path validation
   - Cleanup on worktree creation failure
   - README.md presence verification

4. **E2B Sandbox Workspace**
   - E2B URL return without local path validation

5. **Workspace Cleanup**
   - Proper workspace directory cleanup
   - Rejection of non-workspace directory cleanup
   - Path validation during cleanup

### API Endpoint Integration Tests

1. **POST /api/sessions - Local Workspace**
   - Session creation with local workspace
   - Request ID inclusion in response headers

2. **POST /api/sessions - GitHub Workspace**
   - Session creation with GitHub repository
   - Invalid repository format rejection

3. **POST /api/sessions - E2B Workspace**
   - Session creation with E2B sandbox

4. **Rate Limiting**
   - Enforcement of 10 requests per 15-minute window
   - Rate limit error responses (429)

5. **Authentication**
   - Rejection of requests without API key
   - Rejection of requests with invalid API key

6. **Error Handling**
   - Generic error messages (no information disclosure)
   - Request ID correlation in error responses

7. **Input Validation**
   - Invalid project type rejection
   - Missing required field validation
   - Null byte injection prevention in paths

## Running Tests

### Prerequisites

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Ensure required tools are installed:**
   - Git (for worktree tests)
   - GitHub CLI (`gh`) or git (for repository cloning)

3. **Set up test environment:**
   - Tests use `/tmp/test-workspaces` as the workspace base
   - No database setup required (tests use mocks)
   - No authentication setup required (tests use mock API keys)

### Run All Tests

```bash
npm test
```

### Run Integration Tests Only

```bash
npm run test:integration
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

## Test Design Principles

### 1. Real File System Operations

Tests use actual file system operations in `/tmp/test-workspaces` to verify:
- Directory creation and permissions
- Symlink resolution and validation
- Path traversal prevention
- Cleanup after failures

### 2. Mock Database

Tests use a `MockPool` class to simulate PostgreSQL operations without requiring a real database:
- Session creation and retrieval
- Message logging
- API key validation

This allows tests to run in isolation and verify API logic without database dependencies.

### 3. Security Logging Verification

Tests verify that security events are logged correctly:
- Path traversal attempts
- Invalid repository formats
- Rate limit violations
- Authentication failures

### 4. Cleanup and Isolation

Each test:
- Tracks created workspaces in `createdWorkspaces` array
- Cleans up after itself in `afterEach`
- Runs independently without side effects

### 5. Realistic Test Data

- Uses real public GitHub repositories (`octocat/Hello-World`)
- Creates actual git repositories for worktree tests
- Tests with realistic malicious payloads (path traversal, command injection)

## Test Environment

### Environment Variables

The test suite sets:
- `WORKSPACE_BASE=/tmp/test-workspaces` - Test workspace directory
- `LOG_DIR` - Optional (defaults to `/var/log/claude-orchestrator`)

### File System Layout

During tests:
```text
/tmp/test-workspaces/
├── test-local-workspace/          # Local workspace test
├── gh-{uuid}-{timestamp}/         # GitHub clone test
├── wt-{uuid}/                     # Worktree test
└── base-repo/                     # Base repo for worktree tests
```

All directories are cleaned up after tests complete.

## Security Testing

### Attack Scenarios Tested

1. **Path Traversal**
   - `../etc/passwd`
   - `/tmp/workspaces/../etc/passwd`
   - `../../sensitive/file`

2. **Command Injection**
   - `owner/repo; rm -rf /`
   - `owner/repo\`whoami\``
   - `owner/repo$(whoami)`
   - `owner/repo|whoami`

3. **Null Byte Injection**
   - `/test\0/malicious`

4. **Symlink Attacks**
   - Symlinks escaping workspace base
   - Parent directory symlinks (TOCTOU)

5. **Dots Bypass**
   - `owner/repo..name`
   - `owner/../malicious`

### Security Controls Verified

- Pre-creation path validation
- Post-creation validation (TOCTOU mitigation)
- Symlink resolution with `fs.realpath()`
- Path separator bypass prevention
- Allowlist verification
- Repository name validation
- Size and timeout limits

## Coverage Goals

- **Target:** 85% coverage across all modules
- **Focus areas:**
  - WorkspaceManager service (100% coverage)
  - API routes security validations
  - Error handling and cleanup logic

## Troubleshooting

### Git Clone Failures

If GitHub cloning tests fail:

1. **Check GitHub CLI installation:**
   ```bash
   gh --version
   ```

2. **Verify git is configured:**
   ```bash
   git config --global user.name
   git config --global user.email
   ```

3. **Test manual clone:**
   ```bash
   gh repo clone octocat/Hello-World /tmp/test-clone
   ```

### Permission Errors

If tests fail with permission errors:

1. **Check workspace base permissions:**
   ```bash
   ls -la /tmp/test-workspaces
   ```

2. **Manually create with correct permissions:**
   ```bash
   mkdir -p /tmp/test-workspaces
   chmod 750 /tmp/test-workspaces
   ```

### Timeout Errors

If tests timeout:

1. **Increase Jest timeout:**
   - Edit `jest.config.js` and increase `testTimeout`
   - Or add `jest.setTimeout(60000)` in test file

2. **Check network connectivity** for GitHub cloning tests

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

## Contributing

When adding new tests:

1. **Follow existing patterns:**
   - Use descriptive test names
   - Clean up created resources
   - Test both success and failure cases

2. **Verify security:**
   - Test attack scenarios
   - Verify logging occurs
   - Check error messages don't leak info

3. **Update documentation:**
   - Add new test scenarios to this README
   - Document any new environment requirements

## References

- [Jest Documentation](https://jestjs.io/)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)
- [OWASP Command Injection](https://owasp.org/www-community/attacks/Command_Injection)
