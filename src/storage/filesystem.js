import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class FileSystemStorage {
  constructor(root, tmpRoot) { this.root = root; this.tmpRoot = tmpRoot; }
  safePath(bucket, key) {
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new Error('Invalid bucket');
    const clean = key.replace(/^\/+/, '');
    const full = path.resolve(this.root, bucket, clean);
    const base = path.resolve(this.root, bucket) + path.sep;
    if (!full.startsWith(base) || clean.includes('\\0')) throw new Error('Invalid object key');
    return full;
  }
  async putStream(bucket, key, stream, maxBytes) {
    const target = this.safePath(bucket, key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(this.tmpRoot, crypto.randomUUID() + '.upload');
    await fs.promises.mkdir(this.tmpRoot, { recursive: true });
    const hash = crypto.createHash('sha256');
    let size = 0;
    const out = fs.createWriteStream(temp, { flags: 'wx' });
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('Object exceeds MAX_OBJECT_SIZE'), { code: 'LIMIT' });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r, j) => { out.once('drain', r); out.once('error', j); });
      }
      await new Promise((r, j) => { out.end(r); out.once('error', j); });
      await fs.promises.rename(temp, target);
      return { path: target, size, sha256: hash.digest('hex') };
    } catch (e) { out.destroy(); await fs.promises.rm(temp, { force: true }); throw e; }
  }
  async createWriteStream(bucket, key) {
    const target = this.safePath(bucket, key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    return target;
  }
  stream(bucket, key) { return fs.createReadStream(this.safePath(bucket, key)); }
  stat(bucket, key) { return fs.promises.stat(this.safePath(bucket, key)); }
  async remove(bucket, key) { await fs.promises.rm(this.safePath(bucket, key), { force: true }); }
  exists(bucket, key) { return fs.promises.access(this.safePath(bucket, key)).then(() => true).catch(() => false); }
}
