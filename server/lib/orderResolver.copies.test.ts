// @vitest-environment node
/**
 * server/lib/orderResolver.ts decides whether an order is paid. It is ONE
 * file kept byte-identical in three apps — lanaeco-shop (the portal),
 * lana-pays.us-mobile (this app, the merchant's) and lana-pays-shop (the
 * payment broker) — so the three judge every order alike. Each repo carries
 * this same test with this same constant: a copy edited in one repo alone
 * goes red here, and the fix is to change all three (and the constant in all
 * three) together.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** sha256 of server/lib/orderResolver.ts, SPEC v1.1.2 (round 5, 5 Oct 2026) — the same in all three repos. */
const ORDER_RESOLVER_SHA256 = '025236780df21c02d439792d19a4c97b0108a9ea25610b33c07c969e7ac1a417';

describe('orderResolver.ts is the shared copy', () => {
  it('its sha256 is the one all three repos pin', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'orderResolver.ts');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(sha).toBe(ORDER_RESOLVER_SHA256);
  });
});
