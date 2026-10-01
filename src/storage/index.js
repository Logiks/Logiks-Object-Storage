import fs from 'node:fs';
import { FileSystemStorage } from './filesystem.js';
import { S3Storage } from './s3.js';
import { AzureBlobStorage } from './azure.js';
import { SftpStorage } from './sftp.js';

// Picks and constructs the active storage backend from environment
// variables. STORAGE_BACKEND selects it; each backend reads its own set of
// vars (documented in .env.example). Defaults to the local filesystem so
// existing deployments keep working unchanged.
export function createStorage(env = process.env) {
  const backend = (env.STORAGE_BACKEND || 'filesystem').toLowerCase();
  const tmpRoot = env.TMP_ROOT || './data/tmp';
  switch (backend) {
    case 'filesystem':
    case 'fs':
      return new FileSystemStorage(env.STORAGE_ROOT || './data/objects', tmpRoot);

    case 's3':
    case 'minio': // MinIO is just S3 with a custom endpoint — same client, same backend.
      return new S3Storage({
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || 'us-east-1',
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        // MinIO (and most self-hosted S3-compatible services) need path-style
        // addressing; default it on automatically when STORAGE_BACKEND=minio.
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' || backend === 'minio',
        prefix: env.S3_PREFIX || '',
      });

    case 'azure':
      return new AzureBlobStorage({
        connectionString: env.AZURE_STORAGE_CONNECTION_STRING || undefined,
        accountName: env.AZURE_STORAGE_ACCOUNT || undefined,
        accountKey: env.AZURE_STORAGE_KEY || undefined,
        container: env.AZURE_CONTAINER,
        prefix: env.AZURE_PREFIX || '',
      });

    case 'sftp':
      return new SftpStorage({
        host: env.SFTP_HOST,
        port: Number(env.SFTP_PORT || 22),
        username: env.SFTP_USERNAME,
        password: env.SFTP_PASSWORD || undefined,
        privateKey: env.SFTP_PRIVATE_KEY ? fs.readFileSync(env.SFTP_PRIVATE_KEY) : undefined,
        passphrase: env.SFTP_PASSPHRASE || undefined,
        basePath: env.SFTP_BASE_PATH || '/',
      });

    default:
      throw new Error(`Unknown STORAGE_BACKEND: "${backend}". Expected filesystem, s3, minio, azure, or sftp.`);
  }
}
