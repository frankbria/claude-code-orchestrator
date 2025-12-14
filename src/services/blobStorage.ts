// src/services/blobStorage.ts
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from '../utils/logger';

const logger = createLogger('blob-storage');

/**
 * Configuration for blob storage
 */
export interface BlobStorageConfig {
  /** Storage type: 'local' or 's3' */
  storageType: 'local' | 's3';
  /** Local storage path (for local storage) */
  localPath?: string;
  /** S3 bucket name (for S3 storage) */
  s3Bucket?: string;
  /** S3 region (for S3 storage) */
  s3Region?: string;
  /** Custom S3 endpoint for MinIO/other S3-compatible services */
  s3Endpoint?: string;
}

/**
 * Custom error class for blob storage operations
 */
export class BlobStorageError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly key?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'BlobStorageError';
  }
}

/**
 * Threshold in bytes for determining inline vs blob storage
 * Results larger than this will be stored as blobs
 */
export const INLINE_THRESHOLD = 100 * 1024; // 100KB

/**
 * BlobStorage service for storing and retrieving large tool results
 * Supports both local filesystem and S3-compatible storage backends
 */
export class BlobStorage {
  private config: BlobStorageConfig;
  private s3Client?: S3Client;

  constructor(config?: Partial<BlobStorageConfig>) {
    // Load configuration from environment variables with defaults
    this.config = {
      storageType: (process.env.BLOB_STORAGE as 'local' | 's3') || config?.storageType || 'local',
      localPath: process.env.BLOB_LOCAL_PATH || config?.localPath || '/var/orchestrator/blobs',
      s3Bucket: process.env.S3_BUCKET || config?.s3Bucket,
      s3Region: process.env.S3_REGION || config?.s3Region || 'us-east-1',
      s3Endpoint: process.env.S3_ENDPOINT || config?.s3Endpoint,
    };

    // Initialize S3 client if using S3 storage
    if (this.config.storageType === 's3') {
      if (!this.config.s3Bucket) {
        throw new BlobStorageError(
          'S3_BUCKET environment variable is required when BLOB_STORAGE=s3',
          'init'
        );
      }

      const s3Config: any = {
        region: this.config.s3Region,
      };

      // Add custom endpoint for MinIO/other S3-compatible services
      if (this.config.s3Endpoint) {
        s3Config.endpoint = this.config.s3Endpoint;
        s3Config.forcePathStyle = true; // Required for MinIO
      }

      this.s3Client = new S3Client(s3Config);
      logger.info('S3 blob storage initialized', {
        bucket: this.config.s3Bucket,
        region: this.config.s3Region,
        endpoint: this.config.s3Endpoint || 'default',
      });
    } else {
      // Ensure local storage directory exists
      this.ensureLocalDir();
      logger.info('Local blob storage initialized', {
        path: this.config.localPath,
      });
    }
  }

  /**
   * Ensure local storage directory exists with secure permissions
   */
  private ensureLocalDir(): void {
    const localPath = this.config.localPath!;
    try {
      if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true, mode: 0o750 });
        logger.info('Created blob storage directory', { path: localPath });
      }
    } catch (error) {
      logger.error('Failed to create blob storage directory', {
        path: localPath,
        error: (error as Error).message,
      });
      throw new BlobStorageError(
        `Failed to create blob storage directory: ${localPath}`,
        'init',
        undefined,
        error as Error
      );
    }
  }

  /**
   * Store content in blob storage
   * @param key - Unique key/path for the blob (e.g., 'sessions/uuid/tools/timestamp-toolname.txt')
   * @param content - Content to store
   * @returns URI of the stored blob (file:// or s3://)
   */
  async put(key: string, content: string): Promise<string> {
    try {
      if (this.config.storageType === 's3') {
        return await this.putS3(key, content);
      } else {
        return await this.putLocal(key, content);
      }
    } catch (error) {
      if (error instanceof BlobStorageError) {
        throw error;
      }
      logger.error('Failed to store blob', {
        key,
        storageType: this.config.storageType,
        error: (error as Error).message,
      });
      throw new BlobStorageError(
        `Failed to store blob: ${(error as Error).message}`,
        'put',
        key,
        error as Error
      );
    }
  }

  /**
   * Store content in local filesystem
   */
  private async putLocal(key: string, content: string): Promise<string> {
    const filePath = path.join(this.config.localPath!, key);
    const dirPath = path.dirname(filePath);

    // Ensure parent directory exists
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o750 });
    }

    // Write file with restricted permissions
    await fs.promises.writeFile(filePath, content, { mode: 0o640 });

    const uri = `file://${filePath}`;
    logger.info('Blob stored locally', { key, uri, size: content.length });
    return uri;
  }

  /**
   * Store content in S3
   */
  private async putS3(key: string, content: string): Promise<string> {
    if (!this.s3Client || !this.config.s3Bucket) {
      throw new BlobStorageError('S3 client not initialized', 'put', key);
    }

    const command = new PutObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      Body: content,
      ContentType: 'text/plain',
    });

    await this.s3Client.send(command);

    const uri = `s3://${this.config.s3Bucket}/${key}`;
    logger.info('Blob stored in S3', { key, uri, size: content.length });
    return uri;
  }

  /**
   * Retrieve content from blob storage by URI
   * @param uri - URI of the blob (file:// or s3://)
   * @returns Content of the blob
   */
  async get(uri: string): Promise<string> {
    try {
      if (uri.startsWith('file://')) {
        return await this.getLocal(uri);
      } else if (uri.startsWith('s3://')) {
        return await this.getS3(uri);
      } else {
        throw new BlobStorageError(`Unknown URI scheme: ${uri}`, 'get', uri);
      }
    } catch (error) {
      if (error instanceof BlobStorageError) {
        throw error;
      }
      logger.error('Failed to retrieve blob', {
        uri,
        error: (error as Error).message,
      });
      throw new BlobStorageError(
        `Failed to retrieve blob: ${(error as Error).message}`,
        'get',
        uri,
        error as Error
      );
    }
  }

  /**
   * Retrieve content from local filesystem
   */
  private async getLocal(uri: string): Promise<string> {
    const filePath = uri.replace('file://', '');

    // Security check: ensure path is within the configured local storage directory
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(this.config.localPath!);
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new BlobStorageError(
        'Path traversal attempt detected',
        'get',
        uri
      );
    }

    if (!fs.existsSync(filePath)) {
      throw new BlobStorageError(`Blob not found: ${uri}`, 'get', uri);
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    logger.info('Blob retrieved locally', { uri, size: content.length });
    return content;
  }

  /**
   * Retrieve content from S3
   */
  private async getS3(uri: string): Promise<string> {
    if (!this.s3Client) {
      throw new BlobStorageError('S3 client not initialized', 'get', uri);
    }

    const { bucket, key } = this.parseS3Uri(uri);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);

    if (!response.Body) {
      throw new BlobStorageError('Empty response from S3', 'get', uri);
    }

    // Convert stream to string
    const content = await this.streamToString(response.Body as Readable);
    logger.info('Blob retrieved from S3', { uri, size: content.length });
    return content;
  }

  /**
   * Get a readable stream for the blob content
   * @param uri - URI of the blob (file:// or s3://)
   * @returns Readable stream
   */
  async getStream(uri: string): Promise<Readable> {
    try {
      if (uri.startsWith('file://')) {
        return this.getStreamLocal(uri);
      } else if (uri.startsWith('s3://')) {
        return await this.getStreamS3(uri);
      } else {
        throw new BlobStorageError(`Unknown URI scheme: ${uri}`, 'getStream', uri);
      }
    } catch (error) {
      if (error instanceof BlobStorageError) {
        throw error;
      }
      logger.error('Failed to get blob stream', {
        uri,
        error: (error as Error).message,
      });
      throw new BlobStorageError(
        `Failed to get blob stream: ${(error as Error).message}`,
        'getStream',
        uri,
        error as Error
      );
    }
  }

  /**
   * Get readable stream from local filesystem
   */
  private getStreamLocal(uri: string): Readable {
    const filePath = uri.replace('file://', '');

    // Security check: ensure path is within the configured local storage directory
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(this.config.localPath!);
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new BlobStorageError(
        'Path traversal attempt detected',
        'getStream',
        uri
      );
    }

    if (!fs.existsSync(filePath)) {
      throw new BlobStorageError(`Blob not found: ${uri}`, 'getStream', uri);
    }

    return fs.createReadStream(filePath, { encoding: 'utf-8' });
  }

  /**
   * Get readable stream from S3
   */
  private async getStreamS3(uri: string): Promise<Readable> {
    if (!this.s3Client) {
      throw new BlobStorageError('S3 client not initialized', 'getStream', uri);
    }

    const { bucket, key } = this.parseS3Uri(uri);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);

    if (!response.Body) {
      throw new BlobStorageError('Empty response from S3', 'getStream', uri);
    }

    return response.Body as Readable;
  }

  /**
   * Delete a blob from storage
   * @param uri - URI of the blob to delete
   */
  async delete(uri: string): Promise<void> {
    try {
      if (uri.startsWith('file://')) {
        await this.deleteLocal(uri);
      } else if (uri.startsWith('s3://')) {
        await this.deleteS3(uri);
      } else {
        throw new BlobStorageError(`Unknown URI scheme: ${uri}`, 'delete', uri);
      }
    } catch (error) {
      if (error instanceof BlobStorageError) {
        throw error;
      }
      logger.error('Failed to delete blob', {
        uri,
        error: (error as Error).message,
      });
      throw new BlobStorageError(
        `Failed to delete blob: ${(error as Error).message}`,
        'delete',
        uri,
        error as Error
      );
    }
  }

  /**
   * Delete blob from local filesystem
   */
  private async deleteLocal(uri: string): Promise<void> {
    const filePath = uri.replace('file://', '');

    // Security check: ensure path is within the configured local storage directory
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(this.config.localPath!);
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new BlobStorageError(
        'Path traversal attempt detected',
        'delete',
        uri
      );
    }

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      logger.info('Blob deleted locally', { uri });
    }
  }

  /**
   * Delete blob from S3
   */
  private async deleteS3(uri: string): Promise<void> {
    if (!this.s3Client) {
      throw new BlobStorageError('S3 client not initialized', 'delete', uri);
    }

    const { bucket, key } = this.parseS3Uri(uri);

    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    await this.s3Client.send(command);
    logger.info('Blob deleted from S3', { uri });
  }

  /**
   * Parse S3 URI into bucket and key components
   */
  private parseS3Uri(uri: string): { bucket: string; key: string } {
    // s3://bucket-name/path/to/key
    const match = uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
      throw new BlobStorageError(`Invalid S3 URI format: ${uri}`, 'parse', uri);
    }
    return { bucket: match[1], key: match[2] };
  }

  /**
   * Convert a readable stream to string
   */
  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  /**
   * Check if blob storage is enabled
   */
  isEnabled(): boolean {
    return this.config.storageType === 's3' || this.config.storageType === 'local';
  }

  /**
   * Get storage configuration (for diagnostics)
   */
  getConfig(): Readonly<BlobStorageConfig> {
    return { ...this.config };
  }

  /**
   * Generate a unique blob key for a tool result
   * @param sessionId - Session UUID
   * @param tool - Tool name
   * @returns Unique key for the blob
   */
  static generateKey(sessionId: string, tool: string): string {
    const timestamp = Date.now();
    const sanitizedTool = tool.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `sessions/${sessionId}/tools/${timestamp}-${sanitizedTool}.txt`;
  }
}

// Singleton instance for default usage
let defaultInstance: BlobStorage | null = null;

/**
 * Get the default blob storage instance
 * Creates one if not already initialized
 */
export function getBlobStorage(): BlobStorage {
  if (!defaultInstance) {
    defaultInstance = new BlobStorage();
  }
  return defaultInstance;
}

/**
 * Reset the default blob storage instance (for testing)
 */
export function resetBlobStorage(): void {
  defaultInstance = null;
}
