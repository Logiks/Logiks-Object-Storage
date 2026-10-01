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

## Start

```bash
cp .env.example .env
docker compose up -d --build
```

Health: `GET /api/v1/health`

All API endpoints except health require `x-api-key`.

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

