// Shared validation helpers used by every storage backend.

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;

export function validateBucket(bucket) {
  if (!BUCKET_RE.test(bucket)) throw new Error('Invalid bucket');
}

// Normalizes a slash-separated object key: strips a leading slash and rejects
// empty/"."/".." segments (path traversal) and embedded NUL bytes. Object
// stores like S3/Azure treat '/' as a plain character with no real
// directory semantics, but the SFTP backend maps keys onto real filesystem
// paths on the remote host, so traversal must be rejected centrally here
// rather than relying on any one backend to catch it.
export function normalizeKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\0')) throw new Error('Invalid object key');
  const segments = key.replace(/^\/+/, '').split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') throw new Error('Invalid object key');
  }
  return segments.join('/');
}
