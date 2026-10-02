import SftpClient from 'ssh2-sftp-client';
import path from 'node:path';
import { validateBucket, normalizeKey } from './path-utils.js';
import { streamWithLimitAndHash } from './stream-utils.js';

// Backs the object-storage API with a remote directory tree reached over
// SFTP. "Bucket" maps onto a real subdirectory under SFTP_BASE_PATH, exactly
// like the filesystem backend — the only backend here where that's also how
// the remote side actually works.
export class SftpStorage {
  constructor({ host, port, username, password, privateKey, passphrase, basePath }) {
    if (!host || !username) throw new Error('SFTP_HOST and SFTP_USERNAME are required for the sftp storage backend');
    if (!password && !privateKey) throw new Error('Set SFTP_PASSWORD or SFTP_PRIVATE_KEY for the sftp storage backend');
    this.config = { host, port: port || 22, username, password, privateKey, passphrase };
    this.basePath = basePath || '/';
    this._client = null;
    this._connecting = null;
  }
  // Lazily connects once and reuses the connection; concurrent callers
  // during the initial connect all await the same in-flight attempt.
  // If the underlying SSH session drops (idle timeout, network blip, remote
  // restart), SftpClient re-emits 'close'/'end'/'error' — we clear the cached
  // client on any of those so the *next* call reconnects instead of handing
  // out a dead connection forever.
  async client() {
    if (this._client) return this._client;
    if (!this._connecting) {
      this._connecting = (async () => {
        const c = new SftpClient();
        await c.connect(this.config);
        // SftpClient.on() doesn't return `this`, so these can't be chained.
        const drop = () => { if (this._client === c) { this._client = null; this._connecting = null; } };
        c.on('close', drop);
        c.on('end', drop);
        c.on('error', drop);
        this._client = c;
        return c;
      })().catch((e) => { this._connecting = null; throw e; });
    }
    return this._connecting;
  }
  async close() {
    if (this._client) await this._client.end().catch(() => {});
    this._client = null;
    this._connecting = null;
  }
  remotePath(bucket, key) {
    validateBucket(bucket);
    return path.posix.join(this.basePath, bucket, normalizeKey(key));
  }
  async ensureDir(dir) {
    const c = await this.client();
    if ((await c.exists(dir)) === false) await c.mkdir(dir, true);
  }
  // contentType is accepted for interface parity but unused — SFTP has no
  // content-type attribute; it's already tracked in the metadata DB.
  async putStream(bucket, key, stream, maxBytes, _contentType) {
    const remote = this.remotePath(bucket, key);
    await this.ensureDir(path.posix.dirname(remote));
    const c = await this.client();
    // Upload under a temp name, then rename into place, so a failed/partial
    // upload never clobbers an existing object (SFTP has no atomic put).
    const temp = `${remote}.uploading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const result = await streamWithLimitAndHash(stream, maxBytes, (body) => c.put(body, temp));
      await c.rename(temp, remote);
      return result;
    } catch (e) {
      await c.delete(temp, true).catch(() => {});
      throw e;
    }
  }
  async createReadStream(bucket, key, range) {
    const c = await this.client();
    const options = range ? { start: range.start, end: range.end } : undefined;
    return c.createReadStream(this.remotePath(bucket, key), options);
  }
  async stat(bucket, key) {
    const c = await this.client();
    const s = await c.stat(this.remotePath(bucket, key));
    return { size: s.size };
  }
  async remove(bucket, key) {
    const c = await this.client();
    await c.delete(this.remotePath(bucket, key), true);
  }
  async exists(bucket, key) {
    const c = await this.client();
    return (await c.exists(this.remotePath(bucket, key))) !== false;
  }
  // Used by the /api/v1/health/ready probe to confirm the SFTP connection is
  // actually up (and reconnects it if it had dropped), not just that the
  // process is up.
  async ping() {
    const c = await this.client();
    if ((await c.exists(this.basePath)) === false) throw new Error(`SFTP_BASE_PATH "${this.basePath}" does not exist`);
  }
}
