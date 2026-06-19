import { describe, it, expect } from 'vitest';
import {
  parseTransform,
  transformCacheKey,
  isTransformable,
  outputMime,
  runTransform,
  MAX_DIMENSION,
  type TransformParams,
} from '../transform.js';

describe('parseTransform — no transform intent', () => {
  it('returns null params when no transform query keys are present', () => {
    expect(parseTransform({}).params).toBeNull();
    expect(parseTransform({ token: 'abc', foo: 'bar' }).params).toBeNull();
  });

  it('returns null when only resize/quality given (nothing to do)', () => {
    expect(parseTransform({ resize: 'cover' }).params).toBeNull();
    expect(parseTransform({ quality: '80' }).params).toBeNull();
    expect(parseTransform({ resize: 'fill', quality: '50' }).params).toBeNull();
  });
});

describe('parseTransform — valid params', () => {
  it('parses width + format with default resize cover', () => {
    const r = parseTransform({ width: '40', format: 'webp' });
    expect(r.error).toBeUndefined();
    expect(r.params).toEqual({ width: 40, resize: 'cover', format: 'webp' });
  });

  it('parses height + resize + quality', () => {
    const r = parseTransform({ height: '200', resize: 'contain', quality: '70' });
    expect(r.params).toEqual({ height: 200, resize: 'contain', quality: 70 });
  });

  it('allows a format-only transform (re-encode, no resize)', () => {
    const r = parseTransform({ format: 'jpeg' });
    expect(r.params).toEqual({ resize: 'cover', format: 'jpeg' });
  });

  it('lowercases the format', () => {
    expect(parseTransform({ format: 'WEBP', width: '10' }).params?.format).toBe('webp');
  });
});

describe('parseTransform — clamping', () => {
  it('clamps width/height to MAX_DIMENSION', () => {
    const r = parseTransform({ width: '999999', height: '5000' });
    expect(r.params?.width).toBe(MAX_DIMENSION);
    expect(r.params?.height).toBe(MAX_DIMENSION);
  });

  it('keeps in-range dimensions intact', () => {
    expect(parseTransform({ width: '1500' }).params?.width).toBe(1500);
  });
});

describe('parseTransform — bad params → error (400)', () => {
  it('rejects non-numeric width', () => {
    expect(parseTransform({ width: 'abc' }).error).toMatch(/width/);
  });
  it('rejects zero / negative dimensions', () => {
    expect(parseTransform({ width: '0' }).error).toMatch(/width/);
    expect(parseTransform({ height: '-5' }).error).toMatch(/height/);
  });
  it('rejects an unknown resize mode', () => {
    expect(parseTransform({ width: '10', resize: 'squish' }).error).toMatch(/resize/);
  });
  it('rejects an unknown format', () => {
    expect(parseTransform({ format: 'gif' }).error).toMatch(/format/);
  });
  it('rejects out-of-range quality', () => {
    expect(parseTransform({ width: '10', quality: '0' }).error).toMatch(/quality/);
    expect(parseTransform({ width: '10', quality: '101' }).error).toMatch(/quality/);
  });
});

describe('transformCacheKey', () => {
  const params: TransformParams = { width: 40, resize: 'cover', format: 'webp' };
  const fp = { size: 1234, mtimeMs: 1700000000000 };

  it('is deterministic for identical inputs', () => {
    expect(transformCacheKey('b', 'a.png', params, fp)).toBe(
      transformCacheKey('b', 'a.png', params, fp),
    );
  });

  it('differs when params differ', () => {
    const k1 = transformCacheKey('b', 'a.png', params, fp);
    const k2 = transformCacheKey('b', 'a.png', { ...params, width: 80 }, fp);
    expect(k1).not.toBe(k2);
  });

  it('differs when the source fingerprint differs (re-upload busts cache)', () => {
    const k1 = transformCacheKey('b', 'a.png', params, fp);
    const k2 = transformCacheKey('b', 'a.png', params, { ...fp, mtimeMs: fp.mtimeMs + 1000 });
    expect(k1).not.toBe(k2);
  });

  it('is namespaced by bucket and carries the format extension', () => {
    const k = transformCacheKey('photos', 'a.png', params, fp);
    expect(k.startsWith('photos/')).toBe(true);
    expect(k.endsWith('.webp')).toBe(true);
  });
});

describe('isTransformable', () => {
  it('accepts raster image mimes', () => {
    expect(isTransformable('image/png')).toBe(true);
    expect(isTransformable('image/jpeg')).toBe(true);
    expect(isTransformable('image/webp')).toBe(true);
  });
  it('rejects non-images and svg', () => {
    expect(isTransformable('application/pdf')).toBe(false);
    expect(isTransformable('text/plain')).toBe(false);
    expect(isTransformable('image/svg+xml')).toBe(false);
    expect(isTransformable(undefined)).toBe(false);
  });
});

describe('outputMime', () => {
  it('uses the target format mime when a format is set', () => {
    expect(outputMime({ resize: 'cover', format: 'webp' }, 'image/png')).toBe('image/webp');
  });
  it('keeps the source mime when no format change', () => {
    expect(outputMime({ width: 10, resize: 'cover' }, 'image/png')).toBe('image/png');
  });
});

// Real sharp round-trip — skipped automatically if the native binary is not
// installed on this host (the Docker build is the real target). Generates a
// PNG with sharp, resizes to 40px webp, asserts the output metadata.
describe('runTransform (sharp round-trip)', () => {
  it('resizes a generated PNG to 40px webp', async () => {
    let sharp: typeof import('sharp').default;
    try {
      sharp = (await import('sharp')).default;
    } catch {
      console.warn('[transform.test] sharp binary not installed — skipping round-trip');
      return;
    }
    const src = await sharp({
      create: { width: 200, height: 120, channels: 3, background: { r: 10, g: 120, b: 80 } },
    })
      .png()
      .toBuffer();

    const out = await runTransform(src, { width: 40, resize: 'cover', format: 'webp' }, 'image/png');
    expect(out.mime).toBe('image/webp');
    expect(out.width).toBe(40);

    // Verify by re-reading the output with sharp.
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(40);
  });

  it('rejects a non-image buffer (caller falls back to original)', async () => {
    try {
      await import('sharp');
    } catch {
      return; // no binary → skip
    }
    await expect(
      runTransform(Buffer.from('not an image at all'), { width: 10, resize: 'cover' }, 'image/png'),
    ).rejects.toBeTruthy();
  });
});
