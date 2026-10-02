import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import mime from 'mime-types';
import { v4 as uuid } from 'uuid';
import { createStorage } from './storage/index.js';
import { createDb } from './db.js';

const PORT = Number(process.env.PORT || 8080);
const BACKEND = (process.env.STORAGE_BACKEND || 'filesystem').toLowerCase();
const TMP = process.env.TMP_ROOT || './data/tmp';
const DB_PATH = process.env.DB_PATH || './data/metadata.db';
const PUBLIC = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRESIGN_SECRET = process.env.PRESIGN_SECRET || 'change-this';
const MAX = Number(process.env.MAX_OBJECT_SIZE || 100 * 1024 * 1024 * 1024);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 5000);

// One or more API keys, each optionally scoped to a list of buckets.
// STORAGE_API_KEYS (preferred when you need more than one key or per-bucket
// scoping) is a JSON array, e.g.:
//   [{"key":"abc123","buckets":["media"]},{"key":"def456"}]
// A plain string entry — or the legacy single STORAGE_API_KEY — has no
// bucket restriction: full access to every bucket.
function loadApiKeys() {
  const raw = process.env.STORAGE_API_KEYS;
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('STORAGE_API_KEYS must be valid JSON, e.g. [{"key":"...","buckets":["a"]}]'); }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('STORAGE_API_KEYS must be a non-empty JSON array');
    return parsed.map(entry => {
      if (typeof entry === 'string') return { key: entry, buckets: null };
      if (!entry || typeof entry.key !== 'string' || !entry.key) throw new Error('Each STORAGE_API_KEYS entry needs a "key" string');
      const buckets = Array.isArray(entry.buckets) && entry.buckets.length ? entry.buckets : null;
      return { key: entry.key, buckets };
    });
  }
  return [{ key: process.env.STORAGE_API_KEY || 'change-me', buckets: null }];
}
const API_KEYS = loadApiKeys();

if (API_KEYS.some(k => k.key === 'change-me') || PRESIGN_SECRET === 'change-this') {
  console.warn('WARNING: using an insecure default STORAGE_API_KEY/STORAGE_API_KEYS and/or PRESIGN_SECRET. Set them before exposing this service.');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// TMP always holds local multipart-part staging files regardless of backend
// (parts land on local disk as they're uploaded, then get streamed to
// whichever backend on complete). STORAGE_ROOT only applies to the
// filesystem backend, so only create it for that backend.
fs.mkdirSync(TMP, { recursive: true });
if (BACKEND === 'filesystem' || BACKEND === 'fs') fs.mkdirSync(process.env.STORAGE_ROOT || './data/objects', { recursive: true });
const db = createDb(DB_PATH);
const storage = createStorage(process.env);
const app = express();
app.disable('x-powered-by');
// No route reads a JSON body except the few small admin/metadata endpoints
// below, which scope express.json() to themselves. A global express.json()
// would consume/reject the streaming object/multipart-part bodies before
// those handlers ever see them, so we deliberately don't register one here.

// Optional CORS support, off by default. Set CORS_ORIGIN to a comma-separated
// list of allowed origins, or "*" for any. Needed if presigned URLs or the
// API will be fetched directly from browser JS rather than a server.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
function cors(req, res, next) {
  if (!CORS_ORIGINS.length) return next();
  const origin = req.get('origin');
  const allowed = CORS_ORIGINS.includes('*') ? '*' : (origin && CORS_ORIGINS.includes(origin) ? origin : null);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key,content-type,range');
    res.setHeader('Access-Control-Expose-Headers', 'etag,content-range,content-length');
  }
  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  next();
}
app.use(cors);

// Optional simple per-IP rate limiting, off by default (RATE_LIMIT_MAX unset
// or 0). A fixed-window counter is enough to blunt casual abuse/brute-forcing
// of the API key without adding a dependency; it resets every
// RATE_LIMIT_WINDOW_MS and isn't meant to replace a real reverse-proxy limiter
// under serious load.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 0);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  if (!RATE_LIMIT_MAX) return next();
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  let b = rateBuckets.get(ip);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }; rateBuckets.set(ip, b); }
  b.count += 1;
  if (b.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}
if (RATE_LIMIT_MAX) {
  app.use(rateLimit);
  setInterval(() => { const now = Date.now(); for (const [ip, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(ip); }, RATE_LIMIT_WINDOW_MS).unref();
}

function auth(req, res, next) {
  if (req.path === '/api/v1/health' || req.path === '/api/v1/health/ready' || req.path.startsWith('/objects/')) return next();
  const key = req.get('x-api-key') || '';
  const match = API_KEYS.find(k => safeEqual(k.key, key));
  if (!match) return res.status(401).json({ error: 'Unauthorized' });
  req.apiKeyBuckets = match.buckets; // null = unrestricted
  next();
}
app.use(auth);

function allowedBucket(req, bucket) { return !req.apiKeyBuckets || req.apiKeyBuckets.includes(bucket); }
// Call at the top of any bucket-scoped handler; returns false (having
// already sent the 403) when the matched API key isn't scoped to `bucket`.
function requireBucket(req, res, bucket) {
  if (!allowedBucket(req, bucket)) { res.status(403).json({ error: 'Forbidden: API key is not scoped to this bucket' }); return false; }
  return true;
}

function sign(bucket, key, expires) {
  return crypto.createHmac('sha256', PRESIGN_SECRET).update(`${bucket}\n${key}\n${expires}`).digest('hex');
}
function publicUrl(bucket, key, expires, sig) {
  return `${PUBLIC}/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}?expires=${expires}&sig=${sig}`;
}
function verifySig(bucket, key, expires, sig) {
  if (!expires || !sig || Number(expires) < Math.floor(Date.now()/1000)) return false;
  return safeEqual(sign(bucket, key, expires), sig);
}
// Express 5 gives a `*name` wildcard as an array of path segments, not a joined string.
function wildcardParam(req, name) { const v = req.params[name]; return Array.isArray(v) ? v.join('/') : (v || ''); }
function getKey(req) { return wildcardParam(req, 'key'); }
function escapeLike(s) { return s.replace(/[\\%_]/g, c => '\\' + c); }
function metadata(bucket, key) { return db.prepare('SELECT * FROM objects WHERE bucket=? AND key=?').get(bucket,key); }

// Request headers of the form x-meta-<name> become custom per-object
// metadata, stored alongside the object and echoed back on GET/HEAD.
function extractMeta(req) {
  const out = {};
  for (const name of Object.keys(req.headers)) {
    if (/^x-meta-/i.test(name)) out[name.slice(7)] = req.headers[name];
  }
  return Object.keys(out).length ? out : null;
}
function setMetaHeaders(res, metadataJson) {
  if (!metadataJson) return;
  let obj; try { obj = JSON.parse(metadataJson); } catch { return; }
  for (const [k, v] of Object.entries(obj)) res.setHeader(`x-meta-${k}`, v);
}

function upsert(bucket,key,result,contentType,metadataObj) {
  const now = new Date().toISOString();
  const etag = `"${result.sha256}"`;
  const metadataJson = metadataObj ? JSON.stringify(metadataObj) : null;
  db.prepare(`INSERT INTO objects(bucket,key,size,sha256,content_type,etag,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bucket,key) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,content_type=excluded.content_type,etag=excluded.etag,updated_at=excluded.updated_at,metadata=excluded.metadata`)
    .run(bucket,key,result.size,result.sha256,contentType,etag,now,now,metadataJson);
  return { ...result, etag, metadata: metadataJson };
}

app.get('/api/v1/health', (_,res)=>res.json({ ok:true, service:'object-storage', backend:BACKEND, maxObjectSize:MAX }));

// Readiness: unlike /health (always 200 if the process is up), this actually
// reaches out to the active backend (HeadBucket, container properties, an
// SFTP round-trip, or an fs.access) so orchestrators can tell "process is
// alive" apart from "the storage backend behind it is actually reachable".
app.get('/api/v1/health/ready', async (_, res) => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('backend ping timed out')), READY_TIMEOUT_MS));
  try {
    await Promise.race([storage.ping(), timeout]);
    res.json({ ready: true, backend: BACKEND });
  } catch (e) {
    res.status(503).json({ ready: false, backend: BACKEND, error: e.message });
  }
});

app.put('/api/v1/objects/:bucket/*key', async (req,res,next)=>{
  try {
    const bucket=req.params.bucket, key=getKey(req);
    if (!requireBucket(req,res,bucket)) return;
    if (!key) return res.status(400).json({error:'Object key required'});
    const contentType=req.get('content-type') || mime.lookup(key) || 'application/octet-stream';
    const objMeta=extractMeta(req);
    const result=await storage.putStream(bucket,key,req,MAX,contentType);
    const meta=upsert(bucket,key,result,contentType,objMeta);
    res.status(201).json({ bucket,key,size:meta.size,sha256:meta.sha256,etag:meta.etag,contentType,metadata:objMeta||undefined,url:`${PUBLIC}/api/v1/objects/${bucket}/${key}` });
  } catch(e) { if(e.code==='LIMIT') return res.status(413).json({error:e.message}); next(e); }
});

async function serveObject(req,res,allowPresigned=true) {
  const bucket=req.params.bucket, key=getKey(req);
  if (allowPresigned && !verifySig(bucket,key,req.query.expires,req.query.sig)) return res.status(403).json({error:'Invalid or expired URL'});
  if (!requireBucket(req,res,bucket)) return;
  const meta=metadata(bucket,key); if(!meta || !(await storage.exists(bucket,key))) return res.status(404).json({error:'Object not found'});
  const stat=await storage.stat(bucket,key); const range=req.headers.range;
  res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type',meta.content_type || 'application/octet-stream'); res.setHeader('ETag',meta.etag);
  res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(path.basename(key))}`);
  setMetaHeaders(res, meta.metadata);
  if (!range) {
    res.setHeader('Content-Length',stat.size);
    const s = await storage.createReadStream(bucket,key);
    s.on('error', err => { if (!res.headersSent) res.status(500); res.end(); console.error(err); });
    return s.pipe(res);
  }
  const m=/bytes=(\d*)-(\d*)/.exec(range); if(!m) return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
  let start=m[1]?Number(m[1]):Math.max(0,stat.size-Number(m[2]));
  let end=m[2]?Number(m[2]):stat.size-1;
  if (end >= stat.size) end = stat.size - 1; // clamp an over-long range instead of rejecting it
  if(start>end || start<0 || stat.size===0) return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
  res.status(206).set('Content-Range',`bytes ${start}-${end}/${stat.size}`).set('Content-Length',end-start+1);
  const s = await storage.createReadStream(bucket,key,{start,end});
  s.on('error', err => { if (!res.headersSent) res.status(500); res.end(); console.error(err); });
  s.pipe(res);
}
app.get('/objects/:bucket/*key', (req,res,next)=>serveObject(req,res,true).catch(next));
app.get('/api/v1/objects/:bucket/*key', (req,res,next)=>serveObject(req,res,false).catch(next));
app.head('/api/v1/objects/:bucket/*key', async (req,res,next)=>{ try { const bucket=req.params.bucket; if(!requireBucket(req,res,bucket)) return; const m=metadata(bucket,getKey(req)); if(!m)return res.sendStatus(404); res.set({'Content-Length':String(m.size),'Content-Type':m.content_type||'application/octet-stream','ETag':m.etag}); setMetaHeaders(res,m.metadata); res.end(); }catch(e){next(e)} });

app.get('/api/v1/url/:bucket/*key', (req,res)=>{
  const bucket=req.params.bucket; if(!requireBucket(req,res,bucket)) return;
  const key=getKey(req), m=metadata(bucket,key); if(!m)return res.status(404).json({error:'Object not found'});
  const ttl=Math.min(Math.max(Number(req.query.ttl||3600),1),7*24*3600); const expires=Math.floor(Date.now()/1000)+ttl; const sig=sign(bucket,key,expires);
  res.json({url:publicUrl(bucket,key,expires,sig),expiresAt:new Date(expires*1000).toISOString()});
});

app.delete('/api/v1/objects/:bucket/*key', async (req,res,next)=>{try{const b=req.params.bucket; if(!requireBucket(req,res,b))return; const k=getKey(req); await storage.remove(b,k); db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(b,k);res.status(204).end()}catch(e){next(e)}});

app.get('/api/v1/objects/:bucket', (req,res)=>{
  const bucket=req.params.bucket; if(!requireBucket(req,res,bucket)) return;
  const prefix=String(req.query.prefix||''); const limit=Math.min(Number(req.query.limit||100),1000);
  const cursor=String(req.query.cursor||'');
  const rows=db.prepare('SELECT key,size,content_type,etag,created_at,updated_at FROM objects WHERE bucket=? AND key LIKE ? ESCAPE \'\\\' AND key > ? ORDER BY key LIMIT ?')
    .all(bucket,escapeLike(prefix)+'%',cursor,limit+1);
  const hasMore = rows.length > limit;
  const objects = hasMore ? rows.slice(0,limit) : rows;
  res.json({bucket,objects,nextCursor: hasMore ? objects[objects.length-1].key : null});
});

// Copies an object, server-side, by reading it from the source bucket/key and
// streaming it straight into storage.putStream for the destination — works
// the same way regardless of backend, since both ends go through the same
// storage interface. Body: { sourceBucket, sourceKey }.
app.post('/api/v1/copy/:destBucket/*destKey', express.json({limit:'8kb'}), async (req,res,next)=>{
  try {
    const destBucket=req.params.destBucket, destKey=wildcardParam(req,'destKey');
    if (!destKey) return res.status(400).json({error:'Destination key required'});
    const { sourceBucket, sourceKey } = req.body || {};
    if (!sourceBucket || !sourceKey) return res.status(400).json({error:'"sourceBucket" and "sourceKey" are required in the request body'});
    if (!requireBucket(req,res,sourceBucket) || !requireBucket(req,res,destBucket)) return;
    const srcMeta = metadata(sourceBucket, sourceKey);
    if (!srcMeta || !(await storage.exists(sourceBucket, sourceKey))) return res.status(404).json({error:'Source object not found'});
    const srcStream = await storage.createReadStream(sourceBucket, sourceKey);
    const result = await storage.putStream(destBucket, destKey, srcStream, MAX, srcMeta.content_type);
    const destMetaObj = srcMeta.metadata ? JSON.parse(srcMeta.metadata) : null;
    const meta = upsert(destBucket, destKey, result, srcMeta.content_type, destMetaObj);
    res.status(201).json({ bucket:destBucket, key:destKey, size:meta.size, sha256:meta.sha256, etag:meta.etag, contentType:srcMeta.content_type, url:`${PUBLIC}/api/v1/objects/${destBucket}/${destKey}` });
  } catch(e) { if(e.code==='LIMIT') return res.status(413).json({error:e.message}); next(e); }
});

// Deletes up to 1000 keys in one call. Each key is attempted independently —
// one failure doesn't abort the rest — and the per-key outcome is reported
// back. Body: { keys: ["a.txt", "b/c.txt", ...] }.
app.post('/api/v1/batch-delete/:bucket', express.json({limit:'1mb'}), async (req,res,next)=>{
  try {
    const bucket=req.params.bucket; if(!requireBucket(req,res,bucket)) return;
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : null;
    if (!keys || !keys.length) return res.status(400).json({error:'"keys" must be a non-empty array'});
    if (keys.length > 1000) return res.status(400).json({error:'At most 1000 keys per batch-delete request'});
    const results = [];
    for (const key of keys) {
      try {
        await storage.remove(bucket, key);
        db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(bucket, key);
        results.push({ key, deleted: true });
      } catch (e) {
        results.push({ key, deleted: false, error: e.message });
      }
    }
    res.json({ bucket, results });
  } catch(e) { next(e); }
});

// Maintenance: walks every object the DB thinks exists in `bucket` and drops
// rows whose backend object is actually gone (e.g. deleted directly through
// the cloud provider's own console, bypassing this API). One pass over the
// whole bucket, so it's meant to be run occasionally/by hand, not on a
// request path.
app.post('/api/v1/admin/reconcile/:bucket', async (req,res,next)=>{
  try {
    const bucket=req.params.bucket; if(!requireBucket(req,res,bucket)) return;
    const rows = db.prepare('SELECT key FROM objects WHERE bucket=?').all(bucket);
    let removed=0; const removedKeys=[];
    for (const row of rows) {
      if (!(await storage.exists(bucket, row.key))) {
        db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(bucket, row.key);
        removed+=1; removedKeys.push(row.key);
      }
    }
    res.json({ bucket, checked: rows.length, removed, removedKeys });
  } catch(e) { next(e); }
});

// Multipart API: each part is streamed directly to a temporary file.
// NOTE: the two fixed-shape routes (/:uploadId/complete, /:uploadId/:partNumber) must be
// registered before the /:bucket/*key wildcard below — Express matches in registration
// order, and "/multipart/<uploadId>/complete" also matches "/:bucket/*key" (bucket=<uploadId>,
// key=["complete"]), which would silently start a brand-new upload instead of completing one.
app.put('/api/v1/multipart/:uploadId/:partNumber', async (req,res,next)=>{try{const p=db.prepare("SELECT * FROM multipart_uploads WHERE upload_id=? AND status='active'").get(req.params.uploadId);if(!p)return res.status(404).json({error:'Upload not found'});if(!requireBucket(req,res,p.bucket))return;const n=Number(req.params.partNumber);if(!Number.isInteger(n)||n<1||n>10000)return res.status(400).json({error:'Invalid part number'});const file=path.join(TMP,`${p.upload_id}-${n}.part`);const hash=crypto.createHash('sha256');let size=0;const out=fs.createWriteStream(file,{flags:'w'});try{for await(const c of req){size+=c.length;if(size>MAX)throw Object.assign(new Error('Part too large'),{code:'LIMIT'});hash.update(c);if(!out.write(c))await new Promise(r=>out.once('drain',r));}await new Promise((r,j)=>{out.end(r);out.once('error',j)});}catch(e){out.destroy();await fs.promises.rm(file,{force:true});throw e;}const sha=hash.digest('hex');db.prepare('INSERT INTO multipart_parts(upload_id,part_number,path,size,sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET path=excluded.path,size=excluded.size,sha256=excluded.sha256,created_at=excluded.created_at').run(p.upload_id,n,file,size,sha,new Date().toISOString());res.status(201).json({uploadId:p.upload_id,partNumber:n,size,sha256:sha,etag:`"${sha}"`});}catch(e){if(e.code==='LIMIT')return res.status(413).json({error:e.message});next(e)}});
// Concatenates the local part files, in order, into one Readable — streamed
// straight into storage.putStream so completion works the same way against
// any backend, instead of each backend needing its own multipart assembly.
async function* concatFiles(paths) {
  for (const p of paths) {
    for await (const chunk of fs.createReadStream(p)) yield chunk;
  }
}
app.post('/api/v1/multipart/:uploadId/complete', async (req,res,next)=>{try{const p=db.prepare("SELECT * FROM multipart_uploads WHERE upload_id=? AND status='active'").get(req.params.uploadId);if(!p)return res.status(404).json({error:'Upload not found'});if(!requireBucket(req,res,p.bucket))return;const parts=db.prepare('SELECT * FROM multipart_parts WHERE upload_id=? ORDER BY part_number').all(p.upload_id);if(!parts.length)return res.status(400).json({error:'No parts'});const combined=Readable.from(concatFiles(parts.map(x=>x.path)));const result=await storage.putStream(p.bucket,p.key,combined,MAX,p.content_type);const objMeta=p.metadata?JSON.parse(p.metadata):null;const meta=upsert(p.bucket,p.key,result,p.content_type,objMeta);db.prepare("UPDATE multipart_uploads SET status='completed' WHERE upload_id=?").run(p.upload_id);for(const part of parts)await fs.promises.rm(part.path,{force:true});res.status(201).json({bucket:p.bucket,key:p.key,size:result.size,sha256:result.sha256,etag:meta.etag,url:`${PUBLIC}/api/v1/objects/${p.bucket}/${p.key}`});}catch(e){if(e.code==='LIMIT') return res.status(413).json({error:e.message}); next(e)}});
app.delete('/api/v1/multipart/:uploadId',async(req,res,next)=>{try{const p=db.prepare('SELECT * FROM multipart_uploads WHERE upload_id=?').get(req.params.uploadId);if(!p)return res.sendStatus(404);if(!requireBucket(req,res,p.bucket))return;const parts=db.prepare('SELECT path FROM multipart_parts WHERE upload_id=?').all(p.upload_id);for(const x of parts)await fs.promises.rm(x.path,{force:true});db.prepare('DELETE FROM multipart_parts WHERE upload_id=?').run(p.upload_id);db.prepare('DELETE FROM multipart_uploads WHERE upload_id=?').run(p.upload_id);res.status(204).end()}catch(e){next(e)}});
app.post('/api/v1/multipart/:bucket/*key', (req,res)=>{const b=req.params.bucket;if(!requireBucket(req,res,b))return;const k=getKey(req),id=uuid(),now=new Date().toISOString();const objMeta=extractMeta(req);db.prepare('INSERT INTO multipart_uploads(upload_id,bucket,key,content_type,created_at,metadata) VALUES(?,?,?,?,?,?)').run(id,b,k,req.get('content-type')||mime.lookup(k)||'application/octet-stream',now,objMeta?JSON.stringify(objMeta):null);res.status(201).json({uploadId:id,bucket:b,key:k});});

app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:err.message||'Internal server error'});});

const useTLS = !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
const httpServer = useTLS
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT_FILE), key: fs.readFileSync(process.env.TLS_KEY_FILE) }, app)
  : http.createServer(app);
httpServer.listen(PORT, () => console.log(`Object Storage listening on :${PORT}${useTLS ? ' (https)' : ''}`));

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close the storage backend (e.g. the SFTP connection) and the
// database — bounded by SHUTDOWN_TIMEOUT_MS so a stuck connection can't hang
// a deploy/restart forever.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);
  const forceExit = setTimeout(() => { console.warn('Shutdown timed out, forcing exit'); process.exit(1); }, SHUTDOWN_TIMEOUT_MS);
  await new Promise((resolve) => httpServer.close(resolve));
  try { await storage.close?.(); } catch (e) { console.error('Error closing storage backend:', e); }
  try { db.close(); } catch (e) { console.error('Error closing database:', e); }
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
