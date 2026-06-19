# Image Transforms

**Resize / reformat images on the fly.** Add transform query params to any
storage download URL and the storage service (`storage/`, `:9998`) returns a
resized/reformatted variant of the image — no separate upload, no extra
endpoint. This is the Supabase Storage `getPublicUrl(..., { transform })`
feature, served by our own sovereign service (powered by
[`sharp`](https://sharp.pixelplumbing.com)).

```
  GET /storage/object/:bucket/path/to/photo.jpg?width=400&format=webp
        │  (same public/private auth rules as a normal download)
        ▼
  storage service
        │  stored object is a raster image?  ── no ──►  serve ORIGINAL bytes
        │  yes
        ▼
  cache hit?  ── yes ──►  serve cached variant
        │  no
        ▼
  sharp pipeline (resize → format → quality)
        │  cache result on disk under _transforms/  (keyed by params + source)
        ▼
  bytes + Content-Type: image/<format>
```

No params → the original bytes are streamed exactly as before. **Nothing about
the existing download behaviour changes** unless you ask for a transform.

## Parameters

Append to the query string of `GET /object/:bucket/*` **or** the signed-URL
`GET /signed/:bucket/*`:

| Param     | Type    | Values                              | Default | Notes |
|-----------|---------|-------------------------------------|---------|-------|
| `width`   | int     | `1`–`2000`                          | —       | Clamped to max 2000. |
| `height`  | int     | `1`–`2000`                          | —       | Clamped to max 2000. |
| `resize`  | enum    | `cover` · `contain` · `fill`        | `cover` | Fit mode when resizing. |
| `format`  | enum    | `webp` · `jpeg` · `png` · `avif`    | —       | Re-encodes; sets `Content-Type`. |
| `quality` | int     | `1`–`100`                           | encoder default | Where the encoder supports it. |

A real transform requires **at least one of `width`, `height`, or `format`**.
`resize`/`quality` alone do nothing and fall through to the original.

### Examples

```
# 400px-wide WebP thumbnail of a public image
/storage/object/avatars/jane.jpg?width=400&format=webp

# 200×200 contain-fit JPEG at quality 70
/storage/object/photos/team.png?width=200&height=200&resize=contain&format=jpeg&quality=70

# Same, via a time-limited signed URL for a private bucket
/storage/signed/private/contract-scan.png?token=<jwt>&width=800&format=webp
```

## The image-only rule

Transforms apply **only to raster images** — the stored MIME must start with
`image/` (SVG is excluded; it is a vector format, not a sharp resize target).

- **Non-image object + transform params** → the **original bytes** are returned
  unchanged (the params are ignored, not an error). This keeps URLs robust when
  a bucket mixes media types.
- **Corrupt image / sharp failure** → falls back to the **original bytes**
  (logged as a warning). A bad image never returns a 500.
- **Clearly-malformed params** (e.g. `width=abc`, `format=gif`,
  `quality=200`) → **`400`** with a Kiswahili error message, before any work.

## Auth

Transforms respect the **exact same** public/private rules as a normal
download:

- **Public bucket** → anonymous transform requests are allowed.
- **Private bucket** → a valid bearer (or a valid signed-URL `token`) is
  required, just like a plain download. A private object cannot be read — let
  alone transformed — without authorization.

## Caching

Transformed variants are cached on disk under `STORAGE_ROOT/_transforms/`,
keyed by a SHA-256 hash of **bucket + path + every transform param + the source
object's size and mtime**.

- Repeat requests for the same variant are served straight from the cache.
- **Natural invalidation:** different params → a different key → a fresh render.
- **Re-uploads bust the cache:** the source size+mtime is part of the key, so
  overwriting an object yields a new key and a fresh render.
- The cache is **best-effort**: a cache read or write failure never breaks
  serving — the service just renders (or re-renders) the variant.

`_transforms/` lives alongside the buckets but can never collide with one
(bucket names must start with an alphanumeric, so the leading `_` is reserved).
It is safe to delete the whole directory at any time to reclaim space; variants
are regenerated on demand.

## SDK (`@laetoli/data`)

The client mirrors supabase-js:

```ts
import { createClient } from '@laetoli/data';
const db = createClient(URL, KEY);

// Public bucket — transform-aware public URL
const { publicUrl } = db.storage
  .from('avatars')
  .getPublicUrl('jane.jpg', { transform: { width: 400, format: 'webp' } });
// → .../storage/object/avatars/jane.jpg?width=400&format=webp

// Convenience helper (transform-first)
const url = db.storage
  .from('photos')
  .transformUrl('team.png', { width: 200, height: 200, resize: 'cover', format: 'avif' });

// Private bucket — sign the URL, then append the same params:
const { data } = await db.storage.from('private').createSignedUrl('scan.png', 3600);
const thumb = `${data.signedUrl}&width=800&format=webp`;
```

`buildTransformQuery(opts)` is also exported if you want to assemble the query
string yourself.

## Deployment note

`sharp` ships prebuilt native binaries (incl. linux-musl x64 + arm64), so the
storage `Dockerfile` (`node:22-alpine`) installs it via `npm install` with **no
extra build deps** — it works on a Raspberry Pi (arm64) and an x64 VPS alike.
If a future `sharp` release lacks a prebuild for your arch, add `vips-dev
build-base python3` to the image and let it compile from source.
