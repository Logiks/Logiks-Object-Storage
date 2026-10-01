import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';

// Pipes `source` into a fresh PassThrough while hashing it and enforcing
// `maxBytes`, running `uploadFn(body)` concurrently against that PassThrough.
// `uploadFn` must return a Promise that resolves once the destination has
// fully consumed `body`. Resolves to { size, sha256 } once both the read
// side and the upload are done; rejects (destroying `body`, which should
// abort the upload) if the source errors or exceeds maxBytes.
//
// This gives every network-backed storage backend (S3, Azure, SFTP) the same
// streaming-with-limit-and-hash behavior that FileSystemStorage already has,
// without buffering the whole object in memory.
export async function streamWithLimitAndHash(source, maxBytes, uploadFn) {
  const body = new PassThrough();
  const hash = crypto.createHash('sha256');
  let size = 0;

  const uploadPromise = uploadFn(body);

  const pump = (async () => {
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) {
          throw Object.assign(new Error('Object exceeds MAX_OBJECT_SIZE'), { code: 'LIMIT' });
        }
        hash.update(chunk);
        if (!body.write(chunk)) await new Promise((r, j) => { body.once('drain', r); body.once('error', j); });
      }
      body.end();
    } catch (e) {
      body.destroy(e);
      throw e;
    }
  })();

  await Promise.all([pump, uploadPromise]);
  return { size, sha256: hash.digest('hex') };
}
