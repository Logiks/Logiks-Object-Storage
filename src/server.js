import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { v4 as uuid } from 'uuid';
import { FileSystemStorage } from './storage/filesystem.js';
import { createDb } from './db.js';

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.env.STORAGE_ROOT || './data/objects';
const TMP = process.env.TMP_ROOT || './data/tmp';
const DB_PATH = process.env.DB_PATH || './data/metadata.db';
const PUBLIC = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const API_KEY = process.env.STORAGE_API_KEY || 'change-me';
const PRESIGN_SECRET = process.env.PRESIGN_SECRET || 'change-this';
const MAX = Number(process.env.MAX_OBJECT_SIZE || 100 * 1024 * 1024 * 1024);

fs.mkdirSync(ROOT, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });
const db = createDb(DB_PATH);
const storage = new FileSystemStorage(ROOT, TMP);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function auth(req, res, next) {
  if (req.path === '/api/v1/health' || req.path.startsWith('/objects/')) return next();
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use(auth);

function sign(bucket, key, expires) {
  return crypto.createHmac('sha256', PRESIGN_SECRET).update(`${bucket}\n${key}\n${expires}`).digest('hex');
}
function publicUrl(bucket, key, expires, sig) {
  return `${PUBLIC}/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}?expires=${expires}&sig=${sig}`;
}
function verifySig(bucket, key, expires, sig) {
  if (!expires || !sig || Number(expires) < Math.floor(Date.now()/1000)) return false;
  const expected = sign(bucket, key, expires);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
function getKey(req) { return req.params.key || ''; }
function metadata(bucket, key) { return db.prepare('SELECT * FROM objects WHERE bucket=? AND key=?').get(bucket,key); }
function upsert(bucket,key,result,contentType) {
  const now = new Date().toISOString();
  const etag = `"${result.sha256}"`;
  db.prepare(`INSERT INTO objects(bucket,key,size,sha256,content_type,etag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(bucket,key) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,content_type=excluded.content_type,etag=excluded.etag,updated_at=excluded.updated_at`)
    .run(bucket,key,result.size,result.sha256,contentType,etag,now,now);
  return { ...result, etag };
}

app.get('/api/v1/health', (_,res)=>res.json({ ok:true, service:'object-storage', maxObjectSize:MAX }));

app.put('/api/v1/objects/:bucket/*key', async (req,res,next)=>{
  try {
    const bucket=req.params.bucket, key=getKey(req);
    if (!key) return res.status(400).json({error:'Object key required'});
    const contentType=req.get('content-type') || mime.lookup(key) || 'application/octet-stream';
    const result=await storage.putStream(bucket,key,req,MAX);
    const meta=upsert(bucket,key,result,contentType);
    res.status(201).json({ bucket,key,size:meta.size,sha256:meta.sha256,etag:meta.etag,contentType,url:`${PUBLIC}/objects/${bucket}/${key}` });
  } catch(e) { if(e.code==='LIMIT') return res.status(413).json({error:e.message}); next(e); }
});

async function serveObject(req,res,allowPresigned=true) {
  const bucket=req.params.bucket, key=getKey(req);
  if (allowPresigned && !verifySig(bucket,key,req.query.expires,req.query.sig)) return res.status(403).json({error:'Invalid or expired URL'});
  const meta=metadata(bucket,key); if(!meta || !(await storage.exists(bucket,key))) return res.status(404).json({error:'Object not found'});
  const stat=await storage.stat(bucket,key); const range=req.headers.range;
  res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type',meta.content_type || 'application/octet-stream'); res.setHeader('ETag',meta.etag);
  res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(path.basename(key))}`);
  if (!range) { res.setHeader('Content-Length',stat.size); return storage.stream(bucket,key).pipe(res); }
  const m=/bytes=(\d*)-(\d*)/.exec(range); if(!m) return res.status(416).end();
  let start=m[1]?Number(m[1]):Math.max(0,stat.size-Number(m[2])); let end=m[2]?Number(m[2]):stat.size-1;
  if(start> end || start<0 || end>=stat.size) return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
  res.status(206).set('Content-Range',`bytes ${start}-${end}/${stat.size}`).set('Content-Length',end-start+1);
  fs.createReadStream(storage.safePath(bucket,key),{start,end}).pipe(res);
}
app.get('/objects/:bucket/*key', (req,res,next)=>serveObject(req,res,true).catch(next));
app.get('/api/v1/objects/:bucket/*key', (req,res,next)=>serveObject(req,res,false).catch(next));
app.head('/api/v1/objects/:bucket/*key', async (req,res,next)=>{ try { const m=metadata(req.params.bucket,getKey(req)); if(!m)return res.sendStatus(404); res.set({'Content-Length':String(m.size),'Content-Type':m.content_type||'application/octet-stream','ETag':m.etag}).end(); }catch(e){next(e)} });

app.get('/api/v1/url/:bucket/*key', (req,res)=>{
  const key=getKey(req), m=metadata(req.params.bucket,key); if(!m)return res.status(404).json({error:'Object not found'});
  const ttl=Math.min(Math.max(Number(req.query.ttl||3600),1),7*24*3600); const expires=Math.floor(Date.now()/1000)+ttl; const sig=sign(req.params.bucket,key,expires);
  res.json({url:publicUrl(req.params.bucket,key,expires,sig),expiresAt:new Date(expires*1000).toISOString()});
});

app.delete('/api/v1/objects/:bucket/*key', async (req,res,next)=>{try{const b=req.params.bucket,k=getKey(req); await storage.remove(b,k); db.prepare('DELETE FROM objects WHERE bucket=? AND key=?').run(b,k);res.status(204).end()}catch(e){next(e)}});

app.get('/api/v1/objects/:bucket', (req,res)=>{
  const prefix=String(req.query.prefix||''); const limit=Math.min(Number(req.query.limit||100),1000);
  const rows=db.prepare('SELECT key,size,content_type,etag,created_at,updated_at FROM objects WHERE bucket=? AND key LIKE ? ORDER BY key LIMIT ?').all(req.params.bucket,prefix+'%',limit);
  res.json({bucket:req.params.bucket,objects:rows,nextCursor:null});
});

// Multipart API: each part is streamed directly to a temporary file.
app.post('/api/v1/multipart/:bucket/*key', (req,res)=>{const b=req.params.bucket,k=getKey(req),id=uuid(),now=new Date().toISOString();db.prepare('INSERT INTO multipart_uploads(upload_id,bucket,key,content_type,created_at) VALUES(?,?,?,?,?)').run(id,b,k,req.get('content-type')||mime.lookup(k)||'application/octet-stream',now);res.status(201).json({uploadId:id,bucket:b,key:k});});
app.put('/api/v1/multipart/:uploadId/:partNumber', async (req,res,next)=>{try{const p=db.prepare('SELECT * FROM multipart_uploads WHERE upload_id=? AND status="active"').get(req.params.uploadId);if(!p)return res.status(404).json({error:'Upload not found'});const n=Number(req.params.partNumber);if(!Number.isInteger(n)||n<1||n>10000)return res.status(400).json({error:'Invalid part number'});const file=path.join(TMP,`${p.upload_id}-${n}.part`);const hash=crypto.createHash('sha256');let size=0;const out=fs.createWriteStream(file,{flags:'w'});for await(const c of req){size+=c.length;if(size>MAX)throw new Error('Part too large');hash.update(c);if(!out.write(c))await new Promise(r=>out.once('drain',r));}await new Promise((r,j)=>{out.end(r);out.once('error',j)});const sha=hash.digest('hex');db.prepare('INSERT INTO multipart_parts(upload_id,part_number,path,size,sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET path=excluded.path,size=excluded.size,sha256=excluded.sha256,created_at=excluded.created_at').run(p.upload_id,n,file,size,sha,new Date().toISOString());res.status(201).json({uploadId:p.upload_id,partNumber:n,size,sha256:sha,etag:`"${sha}"`});}catch(e){next(e)}});
app.post('/api/v1/multipart/:uploadId/complete', async (req,res,next)=>{try{const p=db.prepare('SELECT * FROM multipart_uploads WHERE upload_id=? AND status="active"').get(req.params.uploadId);if(!p)return res.status(404).json({error:'Upload not found'});const parts=db.prepare('SELECT * FROM multipart_parts WHERE upload_id=? ORDER BY part_number').all(p.upload_id);if(!parts.length)return res.status(400).json({error:'No parts'});const target=storage.safePath(p.bucket,p.key);await fs.promises.mkdir(path.dirname(target),{recursive:true});const out=fs.createWriteStream(target,{flags:'w'});const hash=crypto.createHash('sha256');let size=0;for(const part of parts){if(size + part.size > MAX) throw Object.assign(new Error('Object exceeds MAX_OBJECT_SIZE'), { code: 'LIMIT' }); const input=fs.createReadStream(part.path);for await(const c of input){size+=c.length;hash.update(c);if(!out.write(c))await new Promise(r=>out.once('drain',r));}}await new Promise((r,j)=>{out.end(r);out.once('error',j)});const sha=hash.digest('hex');const meta=upsert(p.bucket,p.key,{size,sha256:sha,path:target},p.content_type);db.prepare('UPDATE multipart_uploads SET status="completed" WHERE upload_id=?').run(p.upload_id);for(const part of parts)await fs.promises.rm(part.path,{force:true});res.status(201).json({bucket:p.bucket,key:p.key,size,sha256:sha,etag:meta.etag,url:`${PUBLIC}/api/v1/objects/${p.bucket}/${p.key}`});}catch(e){if(e.code==='LIMIT') return res.status(413).json({error:e.message}); next(e)}});
app.delete('/api/v1/multipart/:uploadId',async(req,res,next)=>{try{const p=db.prepare('SELECT * FROM multipart_uploads WHERE upload_id=?').get(req.params.uploadId);if(!p)return res.sendStatus(404);const parts=db.prepare('SELECT path FROM multipart_parts WHERE upload_id=?').all(p.upload_id);for(const x of parts)await fs.promises.rm(x.path,{force:true});db.prepare('DELETE FROM multipart_parts WHERE upload_id=?').run(p.upload_id);db.prepare('DELETE FROM multipart_uploads WHERE upload_id=?').run(p.upload_id);res.status(204).end()}catch(e){next(e)}});

app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:err.message||'Internal server error'});});
app.listen(PORT,()=>console.log(`Object Storage listening on :${PORT}`));
