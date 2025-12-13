# Security Tests Quick Start

## Install & Run (30 seconds)

```bash
# 1. Install dependencies (if not already installed)
npm install

# 2. Run security tests
npm run test:security

# 3. View coverage
npm run test:coverage -- src/__tests__/security
```

## What Gets Tested

✅ **Path Traversal** - `../../../etc/passwd`, URL-encoded, Unicode variants
✅ **Symlink Attacks** - Escape attempts, TOCTOU race conditions
✅ **Command Injection** - Shell metacharacters in repo names
✅ **Resource Exhaustion** - Timeouts, size limits, cleanup
✅ **Security Logging** - Events logged with request IDs
✅ **Info Disclosure** - Generic error messages only
✅ **Edge Cases** - Null bytes, long paths, special chars

## Expected Output

```
 PASS  src/__tests__/security/attack-vectors.test.ts (12.5s)
  Security Attack Vector Prevention
    Path Traversal Attack Prevention
      ✓ should block basic path traversal (15ms)
      ✓ should block URL-encoded path traversal (8ms)
      ✓ should block Unicode path traversal (10ms)
      ...
    Symlink Attack Prevention
      ✓ should block symlink pointing outside workspace (25ms)
      ...

Test Suites: 1 passed, 1 total
Tests:       47 passed, 47 total
Snapshots:   0 total
Time:        12.5s
```

## Run Specific Test Categories

```bash
# Path traversal tests only
npm test -- --testNamePattern="Path Traversal"

# Symlink tests only
npm test -- --testNamePattern="Symlink"

# Command injection tests only
npm test -- --testNamePattern="Command Injection"

# Resource exhaustion tests only
npm test -- --testNamePattern="Resource Exhaustion"

# Security logging tests only
npm test -- --testNamePattern="Security Event Logging"
```

## Watch Mode (Development)

```bash
npm run test:watch -- src/__tests__/security
```

This will re-run tests automatically when you modify files.

## Common Issues

### Symlink Tests Skipped on Windows
**Solution**: This is expected. Symlink tests require Unix-like OS or admin privileges on Windows.

### "WORKSPACE_BASE not set" Error
**Solution**: Tests automatically set `WORKSPACE_BASE` to a temp directory. If you see this error, check the `beforeEach` hook is running.

### Permission Denied on `/tmp`
**Solution**: Tests create directories in `/tmp`. Ensure your user has write permissions:
```bash
chmod 755 /tmp
```

### Git Command Not Found
**Solution**: Some tests verify git operations. Install git:
```bash
# Ubuntu/Debian
sudo apt-get install git

# macOS
brew install git
```

## What If Tests Fail?

**CRITICAL**: A failing test indicates a security vulnerability!

1. **Read the test output** - It shows exactly which attack was not blocked
2. **Check recent code changes** - Did you modify path validation or workspace management?
3. **Do NOT disable the test** - Fix the security issue
4. **Review the attack vector** - Understand what the test is protecting against

Example failure:
```
 FAIL  src/__tests__/security/attack-vectors.test.ts
  ● Path Traversal › should block basic path traversal

    Expected function to throw error, but it succeeded

      67 |       await expect(validateWorkspacePath(maliciousPath)).rejects.toThrow();
```

This means `validateWorkspacePath()` allowed a path traversal attack through!

## Coverage Requirements

Tests enforce **85% minimum coverage**:

```bash
npm run test:coverage
```

If coverage is below 85%, build will fail:
```
Jest: "global" coverage threshold for branches (85%) not met: 82%
```

**Solution**: Add tests for uncovered code paths.

## Integration with CI/CD

Tests run automatically in GitHub Actions on every push/PR.

See `.github/workflows/security-tests.yml` (if configured).

## Next Steps

- Read [README.md](./README.md) for detailed documentation
- Review [attack-vectors.test.ts](./attack-vectors.test.ts) to understand test structure
- Add more tests for new security features

## Need Help?

1. Check [README.md](./README.md) for detailed documentation
2. Review test comments - each test is heavily documented
3. Read OWASP security guides linked in README
4. Check Jest documentation: https://jestjs.io/

## Key Files

- `attack-vectors.test.ts` - Main test suite (47 tests)
- `README.md` - Comprehensive documentation
- `jest.config.js` - Jest configuration (project root)
- `package.json` - Test scripts and dependencies
