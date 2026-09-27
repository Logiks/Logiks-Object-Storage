# Logiks Object Storage

A minimal, self-hosted, S3-style object storage server built with Express. Files are streamed straight to/from disk, so uploads, downloads, and URL-fetches are **not** buffered in memory — large files (GBs) work fine.

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

## Storage layout

```text
data/
  metadata.db
  objects/
    media/
      releases/
        large.zip
  tmp/
```

