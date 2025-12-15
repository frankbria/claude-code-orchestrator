import { Request, Response, NextFunction } from 'express';
import {
  validateSessionCreate,
  workspaceCreationLimiter,
  addRequestId,
} from '../../middleware/validation';
import * as pathValidation from '../../utils/pathValidation';
import { createLogger } from '../../utils/logger';

// Mock dependencies
jest.mock('../../utils/pathValidation');

// Mock the logger module - the mock logger is created inside the factory
// and stored on the createLogger mock for tests to access
jest.mock('../../utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
  };
  return {
    createLogger: Object.assign(jest.fn(() => mockLogger), { _mockLogger: mockLogger }),
  };
});

describe('validation middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;
  let mockValidateWorkspacePath: jest.MockedFunction<typeof pathValidation.validateWorkspacePath>;
  let mockIsAllowedPath: jest.MockedFunction<typeof pathValidation.isAllowedPath>;
  let mockLogger: any;

  beforeEach(() => {
    // Get the mock logger from the createLogger mock
    mockLogger = (createLogger as any)._mockLogger;

    // Setup mock request
    mockRequest = {
      body: {},
      ip: '127.0.0.1',
    } as any;

    // Setup mock response
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };

    // Setup mock next function
    mockNext = jest.fn();

    // Setup path validation mocks
    mockValidateWorkspacePath = pathValidation.validateWorkspacePath as jest.MockedFunction<
      typeof pathValidation.validateWorkspacePath
    >;
    mockIsAllowedPath = pathValidation.isAllowedPath as jest.MockedFunction<
      typeof pathValidation.isAllowedPath
    >;

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('validateSessionCreate', () => {
    describe('project type validation', () => {
      it('should allow valid project types', async () => {
        const validTypes = ['github', 'local', 'e2b', 'worktree'];

        for (const projectType of validTypes) {
          mockRequest.body = { projectType };
          mockNext.mockClear();

          if (projectType === 'github') {
            mockRequest.body.githubRepo = 'owner/repo';
          } else if (projectType === 'local') {
            mockRequest.body.projectPath = '/tmp/test';
            mockValidateWorkspacePath.mockResolvedValue('/tmp/test');
            mockIsAllowedPath.mockReturnValue(true);
          } else if (projectType === 'worktree') {
            mockRequest.body.basePath = '/tmp/test';
            mockValidateWorkspacePath.mockResolvedValue('/tmp/test');
          }

          await validateSessionCreate(
            mockRequest as Request,
            mockResponse as Response,
            mockNext
          );

          expect(mockNext).toHaveBeenCalled();
        }
      });

      it('should reject invalid project type', async () => {
        mockRequest.body = { projectType: 'invalid' };

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Invalid request',
          details: 'Project type not allowed',
        });
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject missing project type', async () => {
        mockRequest.body = {};

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should log invalid project type attempts', async () => {
        mockRequest.body = { projectType: 'malicious' };
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Invalid project type',
          expect.objectContaining({
            projectType: 'malicious',
            requestId: 'test-request-123',
          })
        );
      });
    });

    describe('GitHub project validation', () => {
      beforeEach(() => {
        mockRequest.body = { projectType: 'github' };
      });

      it('should accept valid GitHub repository format', async () => {
        mockRequest.body.githubRepo = 'owner/repo';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should accept repository names with hyphens', async () => {
        mockRequest.body.githubRepo = 'my-org/my-repo';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should accept repository names with underscores', async () => {
        mockRequest.body.githubRepo = 'my_org/my_repo';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should accept repository names with dots', async () => {
        mockRequest.body.githubRepo = 'owner/repo.js';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should reject missing GitHub repository', async () => {
        delete mockRequest.body.githubRepo;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject non-string GitHub repository', async () => {
        mockRequest.body.githubRepo = 123;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject invalid repository format (no slash)', async () => {
        mockRequest.body.githubRepo = 'invalid-repo';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject repository with path traversal', async () => {
        mockRequest.body.githubRepo = 'owner/../etc/passwd';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject repository with consecutive dots', async () => {
        mockRequest.body.githubRepo = 'owner/repo..name';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject repository starting with special characters', async () => {
        mockRequest.body.githubRepo = '-owner/repo';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject repository ending with special characters', async () => {
        mockRequest.body.githubRepo = 'owner/repo-';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject repository with command injection attempt', async () => {
        mockRequest.body.githubRepo = 'owner/repo; rm -rf /';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should log path traversal attempts in GitHub repo', async () => {
        // Use a repo name that passes regex but contains '..' to trigger the path traversal check
        // Note: 'owner/../etc/passwd' fails regex first, so we use 'owner/repo..evil0'
        // which passes the regex pattern but contains consecutive dots
        mockRequest.body.githubRepo = 'owner/repo..evil0';
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Path traversal attempt in GitHub repo name',
          expect.objectContaining({ requestId: 'test-request-123' })
        );
      });
    });

    describe('Local project validation', () => {
      beforeEach(() => {
        mockRequest.body = { projectType: 'local' };
      });

      it('should accept valid local path', async () => {
        mockRequest.body.projectPath = '/tmp/test-workspace/project';
        mockValidateWorkspacePath.mockResolvedValue('/tmp/test-workspace/project');
        mockIsAllowedPath.mockReturnValue(true);

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should reject missing project path', async () => {
        delete mockRequest.body.projectPath;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject non-string project path', async () => {
        mockRequest.body.projectPath = 123;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject path with traversal sequences', async () => {
        mockRequest.body.projectPath = '/tmp/test/../etc/passwd';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject path with null bytes', async () => {
        mockRequest.body.projectPath = '/tmp/test\0/../../etc/passwd';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should call validateWorkspacePath with request ID', async () => {
        mockRequest.body.projectPath = '/tmp/test-workspace/project';
        (mockRequest as any).id = 'test-request-123';
        mockValidateWorkspacePath.mockResolvedValue('/tmp/test-workspace/project');
        mockIsAllowedPath.mockReturnValue(true);

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockValidateWorkspacePath).toHaveBeenCalledWith(
          '/tmp/test-workspace/project',
          'test-request-123'
        );
      });

      it('should reject path not in allowlist', async () => {
        mockRequest.body.projectPath = '/tmp/test-workspace/project';
        mockValidateWorkspacePath.mockResolvedValue('/tmp/test-workspace/project');
        mockIsAllowedPath.mockReturnValue(false);

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should handle validateWorkspacePath errors', async () => {
        mockRequest.body.projectPath = '/tmp/test/project';
        mockValidateWorkspacePath.mockRejectedValue(new Error('Invalid workspace path'));

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should log malicious path attempts (path traversal)', async () => {
        mockRequest.body.projectPath = '/tmp/test/../etc/passwd';
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Malicious path detected',
          expect.objectContaining({
            attack: 'path_traversal',
            requestId: 'test-request-123',
          })
        );
      });

      it('should log malicious path attempts (null byte)', async () => {
        mockRequest.body.projectPath = '/tmp/test\0malicious';
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Malicious path detected',
          expect.objectContaining({
            attack: 'null_byte',
            requestId: 'test-request-123',
          })
        );
      });
    });

    describe('Worktree project validation', () => {
      beforeEach(() => {
        mockRequest.body = { projectType: 'worktree' };
      });

      it('should accept valid base path', async () => {
        mockRequest.body.basePath = '/tmp/test-workspace/base';
        mockValidateWorkspacePath.mockResolvedValue('/tmp/test-workspace/base');

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
      });

      it('should reject missing base path', async () => {
        delete mockRequest.body.basePath;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject non-string base path', async () => {
        mockRequest.body.basePath = 123;

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject base path with traversal sequences', async () => {
        mockRequest.body.basePath = '/tmp/test/../etc/passwd';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject base path with null bytes', async () => {
        mockRequest.body.basePath = '/tmp/test\0malicious';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should call validateWorkspacePath for base path', async () => {
        mockRequest.body.basePath = '/tmp/test-workspace/base';
        mockValidateWorkspacePath.mockResolvedValue('/tmp/test-workspace/base');

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockValidateWorkspacePath).toHaveBeenCalledWith(
          '/tmp/test-workspace/base',
          undefined
        );
      });

      it('should log malicious base path attempts', async () => {
        mockRequest.body.basePath = '/tmp/test/../etc/passwd';
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Malicious base path detected',
          expect.objectContaining({
            attack: 'path_traversal',
            requestId: 'test-request-123',
          })
        );
      });
    });

    describe('E2B project validation', () => {
      it('should accept E2B project without path validation', async () => {
        mockRequest.body = { projectType: 'e2b' };

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockNext).toHaveBeenCalled();
        expect(mockValidateWorkspacePath).not.toHaveBeenCalled();
      });
    });

    describe('Success logging', () => {
      it('should log successful validation', async () => {
        mockRequest.body = { projectType: 'github', githubRepo: 'owner/repo' };
        (mockRequest as any).id = 'test-request-123';

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.info).toHaveBeenCalledWith(
          'Session validation passed',
          expect.objectContaining({
            projectType: 'github',
            requestId: 'test-request-123',
          })
        );
      });
    });

    describe('Error handling', () => {
      it('should return generic error message', async () => {
        mockRequest.body = { projectType: 'local', projectPath: '/tmp/test' };
        mockValidateWorkspacePath.mockRejectedValue(new Error('Specific error details'));

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Invalid request',
          details: 'Validation failed',
        });
      });

      it('should log validation failures', async () => {
        mockRequest.body = { projectType: 'local', projectPath: '/tmp/test' };
        (mockRequest as any).id = 'test-request-123';
        mockValidateWorkspacePath.mockRejectedValue(new Error('Test error'));

        await validateSessionCreate(
          mockRequest as Request,
          mockResponse as Response,
          mockNext
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Session validation failed',
          expect.objectContaining({
            projectType: 'local',
            error: 'Test error',
            requestId: 'test-request-123',
          })
        );
      });
    });
  });

  describe('addRequestId', () => {
    it('should add UUID request ID to request object', () => {
      addRequestId(mockRequest as Request, mockResponse as Response, mockNext);

      expect((mockRequest as any).id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should add request ID to response headers', () => {
      addRequestId(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'X-Request-ID',
        expect.any(String)
      );
    });

    it('should preserve existing request ID', () => {
      (mockRequest as any).id = 'existing-id-123';

      addRequestId(mockRequest as Request, mockResponse as Response, mockNext);

      expect((mockRequest as any).id).toBe('existing-id-123');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Request-ID', 'existing-id-123');
    });

    it('should call next middleware', () => {
      addRequestId(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should generate unique IDs for different requests', () => {
      const request1: any = { body: {} };
      const request2: any = { body: {} };

      addRequestId(request1, mockResponse as Response, mockNext);
      addRequestId(request2, mockResponse as Response, mockNext);

      expect(request1.id).not.toBe(request2.id);
    });
  });

  describe('workspaceCreationLimiter', () => {
    // Note: Testing rate limiter requires more complex setup with multiple requests
    // These are basic tests to verify the middleware is properly configured

    it('should be defined', () => {
      expect(workspaceCreationLimiter).toBeDefined();
    });

    it('should have correct configuration', () => {
      // Rate limiter middleware has these properties
      expect(workspaceCreationLimiter).toBeInstanceOf(Function);
    });

    // Integration test would require sending multiple requests
    // and checking for 429 status code after exceeding limit
  });

  describe('Security edge cases', () => {
    it('should handle empty request body', async () => {
      mockRequest.body = {};

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle null request body', async () => {
      mockRequest.body = null as any;

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle array instead of object', async () => {
      mockRequest.body = ['malicious', 'data'] as any;

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle very long strings', async () => {
      const longString = 'a'.repeat(10000);
      mockRequest.body = { projectType: 'github', githubRepo: longString };

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle Unicode in repository names', async () => {
      mockRequest.body = { projectType: 'github', githubRepo: 'owner/repo-émojis' };

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      // Should reject due to invalid characters
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle SQL injection attempts in paths', async () => {
      mockRequest.body = {
        projectType: 'local',
        projectPath: "/tmp/test'; DROP TABLE sessions; --",
      };

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      // Should reject due to path validation
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('should handle mixed attack vectors', async () => {
      mockRequest.body = {
        projectType: 'local',
        projectPath: '/tmp/test/../../../etc/passwd\0malicious',
      };

      await validateSessionCreate(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
