import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { validateBucket, normalizeKey } from './path-utils.js';
import { streamWithLimitAndHash } from './stream-utils.js';

// Backs the object-storage API with a real S3 bucket. MinIO (and any other
// S3-compatible service) is just this same client pointed at a custom
// `endpoint` with `forcePathStyle` on — there's no separate MinIO client.
//
// Our "bucket" concept is a logical namespace, not a native S3 bucket: every
// object lives in one configured S3 bucket (S3_BUCKET), at key
// `<prefix><ourBucket>/<ourKey>`. This mirrors the filesystem backend
// (one storage root, buckets are subdirectories) and avoids needing
// CreateBucket/ListBuckets permissions.
export class S3Storage {
  constructor({ bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle, prefix }) {
    if (!bucket) throw new Error('S3_BUCKET is required for the s3/minio storage backend');
    this.bucket = bucket;
    this.prefix = prefix ? prefix.replace(/\/+$/, '') + '/' : '';
    this.client = new S3Client({
      region: region || 'us-east-1',
      endpoint: endpoint || undefined,
      forcePathStyle: !!forcePathStyle,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    });
  }
  objectKey(bucket, key) {
    validateBucket(bucket);
    return `${this.prefix}${bucket}/${normalizeKey(key)}`;
  }
  async putStream(bucket, key, stream, maxBytes) {
    const Key = this.objectKey(bucket, key);
    return streamWithLimitAndHash(stream, maxBytes, async (body) => {
      const upload = new Upload({ client: this.client, params: { Bucket: this.bucket, Key, Body: body } });
      try {
        await upload.done();
      } catch (e) {
        await upload.abort().catch(() => {});
        throw e;
      }
    });
  }
  async createReadStream(bucket, key, range) {
    const Key = this.objectKey(bucket, key);
    const Range = range ? `bytes=${range.start}-${range.end}` : undefined;
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key, Range }));
    return res.Body; // a Node Readable when running under Node.js
  }
  async stat(bucket, key) {
    const Key = this.objectKey(bucket, key);
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
    return { size: res.ContentLength };
  }
  async remove(bucket, key) {
    const Key = this.objectKey(bucket, key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
  }
  async exists(bucket, key) {
    try { await this.stat(bucket, key); return true; }
    catch (e) { if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false; throw e; }
  }
}
