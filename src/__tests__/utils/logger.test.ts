import fs from 'fs';
import path from 'path';
import { Logger, createLogger, LogEntry } from '../../utils/logger';

// Mock fs module
jest.mock('fs');

describe('Logger', () => {
  let mockExistsSync: jest.MockedFunction<typeof fs.existsSync>;
  let mockMkdirSync: jest.MockedFunction<typeof fs.mkdirSync>;
  let mockAppendFileSync: jest.MockedFunction<typeof fs.appendFileSync>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Setup mocks
    mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
    mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
    mockAppendFileSync = fs.appendFileSync as jest.MockedFunction<typeof fs.appendFileSync>;

    // Spy on console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;

    // Restore console methods
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('Logger constructor', () => {
    it('should create logger with default log directory', () => {
      delete process.env.LOG_DIR;
      mockExistsSync.mockReturnValue(true);

      const logger = new Logger('test');

      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create logger with custom log directory from environment', () => {
      process.env.LOG_DIR = '/custom/log/dir';
      mockExistsSync.mockReturnValue(true);

      const logger = new Logger('test');

      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create log directory if it does not exist', () => {
      process.env.LOG_DIR = '/var/log/claude-orchestrator';
      mockExistsSync.mockReturnValue(false);

      new Logger('test');

      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/var/log/claude-orchestrator',
        { recursive: true, mode: 0o750 }
      );
    });

    it('should not create directory if it already exists', () => {
      process.env.LOG_DIR = '/var/log/claude-orchestrator';
      mockExistsSync.mockReturnValue(true);

      new Logger('test');

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should handle directory creation errors gracefully', () => {
      process.env.LOG_DIR = '/var/log/claude-orchestrator';
      mockExistsSync.mockReturnValue(false);
      mockMkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw, just log error
      expect(() => new Logger('test')).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to create log directory:',
        expect.any(Error)
      );
    });
  });

  describe('Log level methods', () => {
    let logger: Logger;

    beforeEach(() => {
      process.env.LOG_DIR = '/var/log/test';
      mockExistsSync.mockReturnValue(true);
      logger = new Logger('test-category');
    });

    describe('info', () => {
      it('should log info message to console', () => {
        logger.info('Test info message');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"level":"info"')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"message":"Test info message"')
        );
      });

      it('should include metadata in info log', () => {
        logger.info('Test message', { userId: '123', action: 'login' });

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.metadata).toEqual({ userId: '123', action: 'login' });
      });

      it('should include timestamp in info log', () => {
        logger.info('Test message');

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      });

      it('should include category in info log', () => {
        logger.info('Test message');

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.category).toBe('test-category');
      });
    });

    describe('warn', () => {
      it('should log warning message to console', () => {
        logger.warn('Test warning');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"level":"warn"')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"message":"Test warning"')
        );
      });

      it('should include metadata in warning log', () => {
        logger.warn('Security event', { ip: '1.2.3.4', attempt: 'path_traversal' });

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.metadata).toEqual({ ip: '1.2.3.4', attempt: 'path_traversal' });
      });
    });

    describe('error', () => {
      it('should log error message to console', () => {
        logger.error('Test error');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"level":"error"')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"message":"Test error"')
        );
      });

      it('should include error details in metadata', () => {
        logger.error('Database error', { code: 'ECONNREFUSED', host: 'localhost' });

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.metadata).toEqual({ code: 'ECONNREFUSED', host: 'localhost' });
      });
    });

    describe('critical', () => {
      it('should log critical message to console', () => {
        logger.critical('System compromised');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"level":"critical"')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('"message":"System compromised"')
        );
      });

      it('should include critical incident metadata', () => {
        logger.critical('Intrusion detected', { source: '1.2.3.4', vector: 'RCE' });

        const logCall = consoleLogSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);

        expect(logEntry.metadata).toEqual({ source: '1.2.3.4', vector: 'RCE' });
      });
    });
  });

  describe('Security log file writing', () => {
    let securityLogger: Logger;

    beforeEach(() => {
      process.env.LOG_DIR = '/var/log/test';
      mockExistsSync.mockReturnValue(true);
      securityLogger = new Logger('security');
    });

    it('should write security logs to file', () => {
      securityLogger.info('Security event');

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/var/log/test/security.log',
        expect.stringContaining('"level":"info"'),
        { mode: 0o640 }
      );
    });

    it('should include all log entry fields in file', () => {
      securityLogger.warn('Path traversal blocked', { requestId: 'req-123' });

      const writeCall = mockAppendFileSync.mock.calls[0];
      const logLine = writeCall[1] as string;
      const logEntry = JSON.parse(logLine.trim());

      expect(logEntry).toMatchObject({
        level: 'warn',
        category: 'security',
        message: 'Path traversal blocked',
        metadata: { requestId: 'req-123' },
      });
      expect(logEntry.timestamp).toBeDefined();
    });

    it('should append newline to each log entry', () => {
      securityLogger.info('Test event');

      const writeCall = mockAppendFileSync.mock.calls[0];
      const logLine = writeCall[1] as string;

      expect(logLine).toMatch(/\n$/);
    });

    it('should use correct file permissions for security logs', () => {
      securityLogger.info('Test event');

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { mode: 0o640 }
      );
    });

    it('should handle file writing errors gracefully', () => {
      mockAppendFileSync.mockImplementation(() => {
        throw new Error('Disk full');
      });

      // Should not throw, just log error to console
      expect(() => securityLogger.info('Test event')).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to write security log:',
        expect.any(Error)
      );

      // Should still log to console
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should not write non-security logs to file', () => {
      const apiLogger = new Logger('api');
      apiLogger.info('API request');

      expect(mockAppendFileSync).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should write all security log levels to file', () => {
      securityLogger.info('Info event');
      securityLogger.warn('Warning event');
      securityLogger.error('Error event');
      securityLogger.critical('Critical event');

      expect(mockAppendFileSync).toHaveBeenCalledTimes(4);
    });

    it('should create proper JSON structure for aggregation', () => {
      securityLogger.info('Test event', { key: 'value', nested: { data: 123 } });

      const writeCall = mockAppendFileSync.mock.calls[0];
      const logLine = writeCall[1] as string;

      // Should be valid JSON
      expect(() => JSON.parse(logLine.trim())).not.toThrow();

      const logEntry = JSON.parse(logLine.trim());
      expect(logEntry.metadata.nested).toEqual({ data: 123 });
    });
  });

  describe('Log entry structure', () => {
    let logger: Logger;

    beforeEach(() => {
      process.env.LOG_DIR = '/var/log/test';
      mockExistsSync.mockReturnValue(true);
      logger = new Logger('test');
    });

    it('should create properly structured log entries', () => {
      logger.info('Test message', { key: 'value' });

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry: LogEntry = JSON.parse(logCall);

      expect(logEntry).toMatchObject({
        level: 'info',
        category: 'test',
        message: 'Test message',
        metadata: { key: 'value' },
      });
      expect(logEntry.timestamp).toBeDefined();
    });

    it('should handle undefined metadata', () => {
      logger.info('Test message');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.metadata).toBeUndefined();
    });

    it('should handle empty metadata object', () => {
      logger.info('Test message', {});

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.metadata).toEqual({});
    });

    it('should handle complex metadata structures', () => {
      const complexMetadata = {
        request: {
          id: 'req-123',
          path: '/api/sessions',
          headers: { 'user-agent': 'test' },
        },
        response: {
          statusCode: 200,
          duration: 123,
        },
        tags: ['api', 'success'],
      };

      logger.info('API request', complexMetadata);

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.metadata).toEqual(complexMetadata);
    });

    it('should use ISO 8601 timestamp format', () => {
      logger.info('Test message');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
      expect(logEntry.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });
  });

  describe('createLogger factory function', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('should create logger instance', () => {
      const logger = createLogger('test');
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create logger with specified category', () => {
      const logger = createLogger('custom-category');
      logger.info('Test message');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.category).toBe('custom-category');
    });

    it('should create independent logger instances', () => {
      const logger1 = createLogger('category1');
      const logger2 = createLogger('category2');

      logger1.info('Message 1');
      logger2.info('Message 2');

      const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);

      expect(log1.category).toBe('category1');
      expect(log2.category).toBe('category2');
    });
  });

  describe('Concurrent logging', () => {
    let securityLogger: Logger;

    beforeEach(() => {
      process.env.LOG_DIR = '/var/log/test';
      mockExistsSync.mockReturnValue(true);
      securityLogger = new Logger('security');
    });

    it('should handle multiple rapid log calls', () => {
      for (let i = 0; i < 100; i++) {
        securityLogger.info(`Message ${i}`);
      }

      expect(consoleLogSpy).toHaveBeenCalledTimes(100);
      expect(mockAppendFileSync).toHaveBeenCalledTimes(100);
    });

    it('should maintain log order', () => {
      securityLogger.info('First');
      securityLogger.warn('Second');
      securityLogger.error('Third');

      const firstLog = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const secondLog = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      const thirdLog = JSON.parse(consoleLogSpy.mock.calls[2][0]);

      expect(firstLog.message).toBe('First');
      expect(secondLog.message).toBe('Second');
      expect(thirdLog.message).toBe('Third');
    });
  });

  describe('Special characters and encoding', () => {
    let logger: Logger;

    beforeEach(() => {
      process.env.LOG_DIR = '/var/log/test';
      mockExistsSync.mockReturnValue(true);
      logger = new Logger('test');
    });

    it('should handle messages with quotes', () => {
      logger.info('Message with "quotes"');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.message).toBe('Message with "quotes"');
    });

    it('should handle messages with newlines', () => {
      logger.info('Message\nwith\nnewlines');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.message).toBe('Message\nwith\nnewlines');
    });

    it('should handle messages with Unicode characters', () => {
      logger.info('Message with émojis 🔒 and ユニコード');

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.message).toBe('Message with émojis 🔒 and ユニコード');
    });

    it('should handle metadata with special characters', () => {
      logger.info('Test', { path: '/tmp/test\n../../../etc/passwd' });

      const logCall = consoleLogSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.metadata.path).toBe('/tmp/test\n../../../etc/passwd');
    });
  });
});
