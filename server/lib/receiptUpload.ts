/**
 * Where receipt photos are forwarded (the upload server behind
 * files.lanapays.us) and the key that server checks in `X-Upload-Key`.
 *
 * The key comes ONLY from RECEIPT_UPLOAD_KEY. It used to fall back to a value
 * written in this repository — a public GitHub repo — and production never set
 * the variable, so every receipt upload ran on a key anyone could read
 * (8 Oct 2026). There is no fallback any more: a missing or blank key means
 * the route refuses the upload with RECEIPT_UPLOAD_NOT_CONFIGURED instead of
 * sending a known value.
 *
 * The URL is not a secret and keeps its default.
 */

export const DEFAULT_RECEIPT_UPLOAD_URL = 'http://65.21.189.205:3099/api/upload';

// Check `target.ok === false`, not `!target.ok`: tsconfig.server.json runs
// without strictNullChecks, where `!` does not narrow this union.
export type ReceiptUploadTarget =
  | { ok: true; url: string; key: string }
  | { ok: false; error: string };

export function receiptUploadTarget(env: Record<string, string | undefined>): ReceiptUploadTarget {
  const key = (env.RECEIPT_UPLOAD_KEY ?? '').trim();
  if (!key) {
    return {
      ok: false,
      error: 'RECEIPT_UPLOAD_KEY is not set — receipt uploads are refused until it is set in .env (it must equal the key on the files.lanapays.us upload server)',
    };
  }
  const url = (env.RECEIPT_UPLOAD_URL ?? '').trim() || DEFAULT_RECEIPT_UPLOAD_URL;
  return { ok: true, url, key };
}
