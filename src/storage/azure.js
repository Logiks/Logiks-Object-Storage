import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { validateBucket, normalizeKey } from './path-utils.js';
import { streamWithLimitAndHash } from './stream-utils.js';

// Backs the object-storage API with Azure Blob Storage. As with S3, "bucket"
// here is a logical namespace rather than a native container: every object
// lives in one configured container (AZURE_CONTAINER), at blob name
// `<prefix><ourBucket>/<ourKey>`.
export class AzureBlobStorage {
  constructor({ connectionString, accountName, accountKey, container, prefix }) {
    if (!container) throw new Error('AZURE_CONTAINER is required for the azure storage backend');
    this.prefix = prefix ? prefix.replace(/\/+$/, '') + '/' : '';
    if (connectionString) {
      this.service = BlobServiceClient.fromConnectionString(connectionString);
    } else if (accountName && accountKey) {
      const cred = new StorageSharedKeyCredential(accountName, accountKey);
      this.service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, cred);
    } else {
      throw new Error('Set AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_KEY');
    }
    this.container = this.service.getContainerClient(container);
    this._containerReady = null;
  }
  async ensureContainer() {
    if (!this._containerReady) this._containerReady = this.container.createIfNotExists();
    await this._containerReady;
  }
  blobName(bucket, key) {
    validateBucket(bucket);
    return `${this.prefix}${bucket}/${normalizeKey(key)}`;
  }
  async putStream(bucket, key, stream, maxBytes) {
    await this.ensureContainer();
    const block = this.container.getBlockBlobClient(this.blobName(bucket, key));
    return streamWithLimitAndHash(stream, maxBytes, (body) => block.uploadStream(body));
  }
  async createReadStream(bucket, key, range) {
    const block = this.container.getBlockBlobClient(this.blobName(bucket, key));
    const offset = range ? range.start : undefined;
    const count = range ? range.end - range.start + 1 : undefined;
    const res = await block.download(offset, count);
    return res.readableStreamBody;
  }
  async stat(bucket, key) {
    const block = this.container.getBlockBlobClient(this.blobName(bucket, key));
    const props = await block.getProperties();
    return { size: props.contentLength };
  }
  async remove(bucket, key) {
    const block = this.container.getBlockBlobClient(this.blobName(bucket, key));
    await block.deleteIfExists();
  }
  async exists(bucket, key) {
    const block = this.container.getBlockBlobClient(this.blobName(bucket, key));
    return block.exists();
  }
}
