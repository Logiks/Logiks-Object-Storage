import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateBucket } from './path-utils.js';

export class FileSystemStorage {
  constructor(root, tmpRoot) { this.root = root; this.tmpRoot = tmpRoot; }
  safePath(bucket, key) {
    validateBucket(bucket);
    if (typeof key !== 'string' || !key || key.includes('\0')) throw new Error('Invalid object key');
    const clean = key.replace(/^\/+/, '');
    const full = path.resolve(this.root, bucket, clean);
    const base = path.resolve(this.root, bucket) + path.sep;
    if (!full.startsWith(base)) throw new Error('Invalid object key');
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
  createReadStream(bucket, key, range) {
    const p = this.safePath(bucket, key);
    return range ? fs.createReadStream(p, { start: range.start, end: range.end }) : fs.createReadStream(p);
  }
  stat(bucket, key) { return fs.promises.stat(this.safePath(bucket, key)); }
  async remove(bucket, key) {
    const target = this.safePath(bucket, key);
    await fs.promises.rm(target, { force: true });
    // Best-effort: prune now-empty parent directories back up to (but not including) the bucket root.
    const bucketRoot = path.resolve(this.root, bucket);
    let dir = path.dirname(target);
    while (dir !== bucketRoot && dir.startsWith(bucketRoot + path.sep)) {
      try {
        await fs.promises.rmdir(dir);
        dir = path.dirname(dir);
      } catch {
        break; // not empty (or already gone) — stop pruning
      }
    }
  }
  exists(bucket, key) { return fs.promises.access(this.safePath(bucket, key)).then(() => true).catch(() => false); }
}
