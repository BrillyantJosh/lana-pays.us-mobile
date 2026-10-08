// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { receiptUploadTarget, DEFAULT_RECEIPT_UPLOAD_URL } from './receiptUpload.js';

describe('receiptUploadTarget — the key comes from the environment or not at all', () => {
  it('refuses when RECEIPT_UPLOAD_KEY is missing', () => {
    const t = receiptUploadTarget({});
    expect(t.ok).toBe(false);
    if (t.ok === false) expect(t.error).toMatch(/RECEIPT_UPLOAD_KEY is not set/);
  });

  it('refuses a blank or whitespace-only key (an empty line in .env is not a key)', () => {
    expect(receiptUploadTarget({ RECEIPT_UPLOAD_KEY: '' }).ok).toBe(false);
    expect(receiptUploadTarget({ RECEIPT_UPLOAD_KEY: '   ' }).ok).toBe(false);
  });

  it('uses the key from the environment, trimmed', () => {
    const t = receiptUploadTarget({ RECEIPT_UPLOAD_KEY: ' test-key \n' });
    expect(t).toEqual({ ok: true, url: DEFAULT_RECEIPT_UPLOAD_URL, key: 'test-key' });
  });

  it('takes RECEIPT_UPLOAD_URL when set, the default when unset or blank', () => {
    const set = receiptUploadTarget({ RECEIPT_UPLOAD_KEY: 'k', RECEIPT_UPLOAD_URL: 'https://example.test/api/upload' });
    expect(set.ok && set.url).toBe('https://example.test/api/upload');
    const blank = receiptUploadTarget({ RECEIPT_UPLOAD_KEY: 'k', RECEIPT_UPLOAD_URL: ' ' });
    expect(blank.ok && blank.url).toBe(DEFAULT_RECEIPT_UPLOAD_URL);
  });
});

describe('server/index.ts — no upload key written in the source', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');

  it('has no `RECEIPT_UPLOAD_KEY || …` / `?? …` fallback', () => {
    // This repo is public. A fallback literal here is a key published to the
    // world — which is exactly what production ran on until 8 Oct 2026.
    expect(src).not.toMatch(/RECEIPT_UPLOAD_KEY\s*(\|\||\?\?)/);
  });

  it('sends X-Upload-Key only from the environment-derived target', () => {
    const headers = src.match(/'X-Upload-Key'\s*:\s*[^,}\n]+/g) ?? [];
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) expect(h).toMatch(/:\s*receiptTarget\.key\s*$/);
  });
});
