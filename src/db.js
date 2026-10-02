import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export function createDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS objects (
    bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    content_type TEXT, etag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(bucket,key)
  );
  CREATE TABLE IF NOT EXISTS multipart_uploads (
    upload_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL,
    content_type TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS multipart_parts (
    upload_id TEXT NOT NULL, part_number INTEGER NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(upload_id, part_number)
  );`);
  // Migration: add the `metadata` column (JSON-encoded x-meta-* headers) to
  // databases created before it existed. CREATE TABLE IF NOT EXISTS above
  // never alters an existing table, so this has to be done separately and
  // idempotently.
  const columns = db.prepare("PRAGMA table_info(objects)").all().map(c => c.name);
  if (!columns.includes('metadata')) db.exec('ALTER TABLE objects ADD COLUMN metadata TEXT');
  const mpColumns = db.prepare("PRAGMA table_info(multipart_uploads)").all().map(c => c.name);
  if (!mpColumns.includes('metadata')) db.exec('ALTER TABLE multipart_uploads ADD COLUMN metadata TEXT');
  return db;
}
