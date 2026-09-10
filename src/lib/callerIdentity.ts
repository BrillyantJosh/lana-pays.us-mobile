/**
 * Who is holding the phone — as a NAME the server can gate on.
 *
 * Several routes in this app take money or spend money while carrying no
 * identity for the person operating the till at all: /api/brain/purchase names
 * only the customer and the unit, and the receipt upload/analyse routes name
 * nobody whatsoever. A gate cannot refuse a name it is never handed, so an
 * excluded MERCHANT kept selling and kept spending the receipt-analysis budget.
 *
 * This module supplies that missing name from the session already stored on the
 * device, as `x-lana-hex` on JSON requests and as a `hex` field on multipart
 * ones (multer fills req.body for text fields, so the server can read it there).
 *
 * WHAT THIS IS NOT. It is not authentication. Nothing signs it, and a caller who
 * wants to send a different hex — or none — can. It closes the case where the
 * server simply had no name to judge; it cannot close the case of a caller who
 * lies about the name. That needs signed requests, which is a separate decision.
 */

/** Where AuthContext keeps the signed-in session. One definition, imported there. */
export const SESSION_KEY = 'lana_pays_session';

const HEX64 = /^[0-9a-f]{64}$/i;

/** The signed-in person's pubkey, or null when nobody is signed in here. */
export function callerHex(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const hex = typeof parsed?.nostrHexId === 'string' ? parsed.nostrHexId.trim() : '';
    if (!HEX64.test(hex)) return null;
    // An expired session is nobody: the app is about to drop it anyway.
    if (!(Number(parsed?.expiresAt) > Date.now())) return null;
    return hex.toLowerCase();
  } catch {
    return null;
  }
}

/** JSON request headers with the caller's name attached when there is one. */
export function withCallerHex(headers: Record<string, string> = {}): Record<string, string> {
  const hex = callerHex();
  return hex ? { ...headers, 'x-lana-hex': hex } : { ...headers };
}

/**
 * A multipart body with the caller's name attached.
 *
 * Returns the same FormData so it can be used inline at the call site. Adds
 * nothing when nobody is signed in — the server then refuses the request, which
 * is the right answer for a route that costs money.
 */
export function withCallerField(form: FormData): FormData {
  const hex = callerHex();
  if (hex) form.append('hex', hex);
  return form;
}
