/**
 * Sending a sale from the till: the one place POST /api/brain/purchase is called.
 *
 * Every sale is signed with the key of whoever is signed in, and the signature
 * covers the exact bytes of the body (server/purchaseSeller.ts reads it). The session
 * is passed in from useAuth(), as in signedRequest.ts, and its private key goes no
 * further than the signature.
 *
 * Two headers are there only for the server's record, and decide nothing. x-till-signs
 * says this request comes from code that knows how to sign, signed or not. x-till-seller
 * names the person signed in on this tab, also past the session's 8 hours, when
 * x-lana-hex is no longer sent. It is a separate header because the exclusion gate reads
 * x-lana-hex, and what the gate is asked does not change here.
 *
 * SIGNING NEVER STOPS A SALE FROM LEAVING. signedAuthHeaders answers {} when it has no
 * key or the signing fails, and the sale goes out unsigned. What the server then does
 * with it is the server's decision, and the seller gets its answer as for any other.
 *
 * A till is expected to work on a phone whose clock is wrong. A refusal for a stale or
 * already used token means nothing was recorded for this attempt and nothing is wrong
 * with the seller, so the same bytes are signed afresh and sent once more, as of the
 * server's own time when it gave one. Any other answer goes straight back to the caller.
 */
import { signedAuthHeaders } from './signedRequest';
import { withCallerHex } from './callerIdentity';

const PURCHASE_URL = '/api/brain/purchase';
const HEX64 = /^[0-9a-f]{64}$/i;

/** The fields of the signed-in session a sale reads. */
export interface SellerSession {
  privateKeyHex?: string | null;
  nostrHexId?: string | null;
}

export async function sendPurchase(session: SellerSession | null | undefined, sale: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(sale);
  // Checked before it goes in a header: a value fetch refuses would stop the sale.
  const seller = typeof session?.nostrHexId === 'string' && HEX64.test(session.nostrHexId) ? session.nostrHexId : null;
  const post = (nowSec?: number) => fetch(PURCHASE_URL, {
    method: 'POST',
    headers: withCallerHex({
      'Content-Type': 'application/json',
      'x-till-signs': '1',
      ...(seller ? { 'x-till-seller': seller } : {}),
      ...signedAuthHeaders(session?.privateKeyHex, 'POST', PURCHASE_URL, { body, nowSec }),
    }),
    body,
  });

  const first = await post();
  if (first.status !== 401) return first;

  let refusal: any;
  try {
    refusal = await first.clone().json();
  } catch {
    return first;
  }
  if (refusal?.reason === 'STALE' && Number.isInteger(refusal?.server_time)) return post(refusal.server_time);
  if (refusal?.reason === 'REPLAYED') return post();
  return first;
}

/**
 * The words for the server's refusal of a seller, as an i18n key, or null when this
 * answer is something else. A till with this code never prints the raw refusal.
 */
export function sellerRefusalKey(status: number, data: any): string | null {
  if (status === 401 && data?.code === 'SIGNATURE_REQUIRED') return 'purchase.sellerNotConfirmed';
  if (status === 503 && data?.code === 'SELLER_CHECK_FAILED') return 'purchase.sellerNotConfirmed';
  if (status === 403 && data?.code === 'NOT_ENTITLED') return 'purchase.sellerNotEntitled';
  return null;
}
