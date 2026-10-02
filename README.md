# Logiks Object Storage

A minimal, self-hosted, S3-style object storage server built with Express. Files are streamed to/from the backend, so uploads, downloads, and URL-fetches are **not** buffered in memory — large files (GBs) work fine.

The HTTP API below is the same no matter which backend actually holds the bytes.

## Storage backends

Set `STORAGE_BACKEND` to pick where objects are actually stored:

| `STORAGE_BACKEND` | Backend | Required vars |
|---|---|---|
| `filesystem` (default) | Local disk | `STORAGE_ROOT` |
| `s3` | Amazon S3 (or any S3-compatible service) | `S3_BUCKET`, `S3_REGION`, credentials |
| `minio` | MinIO | `S3_BUCKET`, `S3_ENDPOINT`, credentials (same backend as `s3`, just a custom endpoint + path-style addressing) |
| `azure` | Azure Blob Storage | `AZURE_CONTAINER`, plus a connection string or account name/key |
| `sftp` | A directory on a remote host reached over SFTP | `SFTP_HOST`, `SFTP_USERNAME`, `SFTP_PASSWORD` or `SFTP_PRIVATE_KEY` |

See `.env.example` for the full list of backend-specific variables.

For every backend except SFTP (which maps onto a real remote directory tree, just like the filesystem backend), "bucket" in this API is a *logical* namespace, not a native cloud bucket: every object for a given backend lives under one configured bucket/container (`S3_BUCKET` / `AZURE_CONTAINER`), at a key of `<bucket>/<key>` — so you don't need bucket-creation permissions, just read/write access to one bucket or container.

Multipart uploads always stage parts on local disk (under `TMP_ROOT`) regardless of backend, then stream the assembled object to whichever backend is active on `complete` — so switching backends never changes how the multipart API behaves.

## Authentication & bucket scoping

Set `STORAGE_API_KEY` for a single key with full access to every bucket, or `STORAGE_API_KEYS` (takes priority when set) for multiple keys and/or per-bucket access:

```bash
STORAGE_API_KEYS='[{"key":"admin-key"},{"key":"media-only-key","buckets":["media"]}]'
```

A key with no `buckets` (or a plain string entry) has unrestricted access. A key scoped to specific buckets gets `403 Forbidden` on any other bucket. Presigned URLs (`GET /objects/...`) are authenticated by their signature instead and aren't affected by key scoping.

## Other hardening (all optional, off by default)

- **CORS** — set `CORS_ORIGIN` (comma-separated origins, or `*`) if the API or presigned URLs will be fetched directly from browser JS.
- **Rate limiting** — set `RATE_LIMIT_MAX` (requests) and `RATE_LIMIT_WINDOW_MS` (window) for basic per-IP throttling. This is a simple in-process counter meant to blunt casual abuse, not a replacement for a real limiter at the reverse-proxy/load-balancer layer under real load.
- **TLS** — set `TLS_CERT_FILE` and `TLS_KEY_FILE` to terminate TLS in this process directly. Otherwise, as usual, put a reverse proxy in front for TLS.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` stop new connections, let in-flight requests finish, then close the storage backend and database, bounded by `SHUTDOWN_TIMEOUT_MS` (default 10s) so a stuck connection can't hang a deploy.

## Start

```bash
cp .env.example .env
docker compose up -d --build
```

Liveness: `GET /api/v1/health` always returns 200 if the process is up.
Readiness: `GET /api/v1/health/ready` actually reaches out to the active backend (a HEAD on the bucket, a container check, an SFTP round-trip, or an `fs.access`) and returns 503 if it can't.

All API endpoints except both health routes require `x-api-key`.

## Upload a large file

```bash
curl -X PUT \\
  -H 'x-api-key: change-me' \\
  -H 'Content-Type: application/octet-stream' \\
  --data-binary @large.zip \\
  http://localhost:8080/api/v1/objects/media/releases/large.zip
```

The request body is streamed to disk; it is not loaded into RAM.

## Download

```bash
curl -H 'x-api-key: change-me' \\
  http://localhost:8080/api/v1/objects/media/releases/large.zip -o large.zip
```

Downloads support HTTP Range requests, which is useful for video and large-file resume.

## Generate a temporary URL

```bash
curl -H 'x-api-key: change-me' \\
  'http://localhost:8080/api/v1/url/media/releases/large.zip?ttl=3600'
```

The returned URL is signed and can be fetched without the API key until expiry.

## Multipart upload

1. `POST /api/v1/multipart/:bucket/:key`
2. `PUT /api/v1/multipart/:uploadId/:partNumber` for each part
3. `POST /api/v1/multipart/:uploadId/complete`
4. `DELETE /api/v1/multipart/:uploadId` to abort

Recommended part size: 16–64 MB. Parts are streamed to temporary files.

## Custom metadata

Any request header of the form `x-meta-<name>` on a PUT (single or multipart-initiate) is stored alongside the object and echoed back the same way on GET/HEAD:

```bash
curl -X PUT -H 'x-api-key: change-me' -H 'x-meta-owner: alice' \
  --data-binary @file.txt http://localhost:8080/api/v1/objects/media/file.txt
```

## Copy an object

Copies server-side (no download/re-upload round trip) within the same backend:

```bash
curl -X POST -H 'x-api-key: change-me' -H 'Content-Type: application/json' \
  -d '{"sourceBucket":"media","sourceKey":"releases/large.zip"}' \
  http://localhost:8080/api/v1/copy/media/archive/large.zip
```

## Batch delete

```bash
curl -X POST -H 'x-api-key: change-me' -H 'Content-Type: application/json' \
  -d '{"keys":["a.txt","b/c.txt"]}' \
  http://localhost:8080/api/v1/batch-delete/media
```

Up to 1000 keys per request; each key is attempted independently and its outcome reported back.

## Reconciliation

If an object is ever deleted directly through the cloud provider's own console/API (bypassing this service), the metadata DB won't know until something touches that key — reads already self-correct (a `GET`/`HEAD` double-checks the backend and 404s), but `list` would keep showing it. Run this occasionally to drop metadata rows whose backend object is actually gone:

```bash
curl -X POST -H 'x-api-key: change-me' http://localhost:8080/api/v1/admin/reconcile/media
```

It walks every row for that bucket in one pass, so it's meant to be run by hand/on a schedule, not on a request path.

## Storage layout (filesystem backend)

```text
data/
  metadata.db
  objects/
    media/
      releases/
        large.zip
  tmp/
```

