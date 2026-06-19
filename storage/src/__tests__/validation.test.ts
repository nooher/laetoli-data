import { describe, it, expect } from 'vitest';
import { validateBucketName, validateObjectPath } from '../validation.js';

describe('validateBucketName', () => {
  it('accepts a normal lowercase name', () => {
    expect(validateBucketName('avatars').ok).toBe(true);
    expect(validateBucketName('public').ok).toBe(true);
    expect(validateBucketName('my-bucket_1.x').ok).toBe(true);
  });

  it('rejects empty / too short / too long', () => {
    expect(validateBucketName('').ok).toBe(false);
    expect(validateBucketName('ab').ok).toBe(false);
    expect(validateBucketName('a'.repeat(64)).ok).toBe(false);
  });

  it('rejects uppercase and bad starting chars', () => {
    expect(validateBucketName('Avatars').ok).toBe(false);
    expect(validateBucketName('-bad').ok).toBe(false);
    expect(validateBucketName('.bad').ok).toBe(false);
  });
});

describe('validateObjectPath', () => {
  it('normalizes and accepts nested paths', () => {
    const r = validateObjectPath('a/b/c.png');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('a/b/c.png');
  });

  it('strips leading slashes and collapses dots', () => {
    expect(validateObjectPath('/x/./y.txt').path).toBe('x/y.txt');
    expect(validateObjectPath('x//y.txt').path).toBe('x/y.txt');
  });

  it('normalizes backslashes (Windows) to forward slashes', () => {
    expect(validateObjectPath('a\\b\\c.txt').path).toBe('a/b/c.txt');
  });

  it('rejects traversal with ..', () => {
    expect(validateObjectPath('../etc/passwd').ok).toBe(false);
    expect(validateObjectPath('a/../../b').ok).toBe(false);
  });

  it('rejects empty, NUL bytes and too-long paths', () => {
    expect(validateObjectPath('').ok).toBe(false);
    expect(validateObjectPath('a\0b').ok).toBe(false);
    expect(validateObjectPath('x'.repeat(1100)).ok).toBe(false);
  });
});
