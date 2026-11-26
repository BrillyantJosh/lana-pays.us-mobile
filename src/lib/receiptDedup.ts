/**
 * The till's side of "this receipt was already used".
 *
 * The brain refuses a purchase whose photo (receipt_hash) or invoice number
 * was already used on the same unit. That rule stays exactly as it is. What
 * this file fixes is the till around it (Alaja, 16 Oct 2026):
 *
 * - A new photo kept the previous photo's number and amount. A product photo
 *   after a receipt photo therefore went on with the old receipt's number,
 *   the pre-check (which only looks at the NEW photo) saw nothing, and the
 *   brain refused at payment.
 * - A pre-check hit on the NUMBER hid "Continue", even when the reader had
 *   simply misread the number. The only way out was to start over.
 * - A refusal at payment time offered "Scan again", which only reopens the
 *   wallet scanner — the same number, refused again.
 *
 * Now: every photo starts from empty fields; a hit on the number lets the
 * seller correct the number in place (the brain still checks whatever is
 * sent); and a refusal at payment time goes back to the field that has to
 * change. A hit on the PHOTO itself still needs a new photo.
 */

export interface DedupHit {
  by: 'receipt_image' | 'invoice';
  /** The earlier sale's time, in the seller's local time ('' when unknown). */
  date: string;
  /** The number that was refused (invoice hits only). */
  number?: string;
}

/** Brain stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in the till's local time. */
export function localDate(createdAt: string | null | undefined): string {
  if (!createdAt) return '';
  const d = new Date(String(createdAt).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * What the number and amount fields hold when a new photo arrives: nothing
 * from the previous photo. Only values handed over from another tab (a
 * payment request) survive, because they did not come from a photo.
 */
export function freshReceiptFields(handedOver?: { invoiceNumber?: string | null; amount?: number | string | null } | null): { invoiceNumber: string; amount: string } {
  return {
    invoiceNumber: handedOver?.invoiceNumber ? String(handedOver.invoiceNumber) : '',
    amount: handedOver?.amount ? String(handedOver.amount) : '',
  };
}

/**
 * May the seller go on from the receipt step? Always without a hit. After a
 * hit on the number: once a number is typed that differs from the refused
 * one. After a hit on the photo: never (a new photo is needed).
 */
export function canContinueAfterHit(hit: DedupHit | null, currentNumber: string): boolean {
  if (!hit) return true;
  if (hit.by !== 'invoice') return false;
  const typed = currentNumber.trim();
  return typed.length > 0 && typed !== (hit.number || '').trim();
}

/** The brain's 409 at payment time, as the field that has to change. */
export function duplicateRefusal(status: number, data: any, sentNumber: string): DedupHit | null {
  if (status !== 409) return null;
  if (data?.error === 'DUPLICATE_INVOICE') {
    return { by: 'invoice', date: localDate(data?.original_created_at), number: sentNumber.trim() };
  }
  if (data?.error === 'DUPLICATE_RECEIPT_IMAGE') {
    return { by: 'receipt_image', date: localDate(data?.original_created_at) };
  }
  return null;
}

/**
 * Ask the brain (through this app's proxy) whether this photo or number was
 * already used on the unit. Soft-fails to null — the brain checks again at
 * payment time, so a failed pre-check only costs the early warning.
 */
export async function checkDedup(
  unitId: string,
  probe: { receiptHash?: string | null; invoiceNumber?: string | null },
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Promise<DedupHit | null> {
  const number = (probe.invoiceNumber || '').trim();
  if (!unitId || (!probe.receiptHash && !number)) return null;
  try {
    const res = await fetch('/api/brain/purchase/check-dedup', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        unit_id: unitId,
        receipt_hash: probe.receiptHash || undefined,
        invoice_number: number || undefined,
      }),
    });
    const data = await res.json();
    if (data?.duplicate && (data.by === 'receipt_image' || data.by === 'invoice')) {
      return data.by === 'invoice'
        ? { by: 'invoice', date: localDate(data.original_created_at), number }
        : { by: 'receipt_image', date: localDate(data.original_created_at) };
    }
  } catch {
    // Soft-fail: the brain re-checks at payment time.
  }
  return null;
}

/**
 * The till's own "already used" screen, photographed and read back as a
 * receipt: the reader's words then are this app's refusal, so the photo is
 * treated as a hit on the photo. The same phrases as the LANA, cash and
 * Lana-online tabs (each keeps its own copy).
 */
const OWN_DEDUP_PHRASES = [
  'each invoice can only be funded', 'invoice number already used',
  'invoice already used for this shop', 'this description was already used',
  'every purchase is a new moment', 'the same photo cannot be used twice',
  'this receipt photo has already been uploaded',
  'vsak račun je mogoče financirati', 'številka računa je za to trgovino že uporabljena',
  'ta opis je bil že uporabljen', 'vsak nakup je nov trenutek',
  'ta slika računa je bila že naložena', 'iste slike ni mogoče uporabiti', 'bodi prisoten',
];
export function looksLikeOwnDedupError(text: string | null | undefined): boolean {
  if (!text) return false;
  const lowered = String(text).toLowerCase();
  return OWN_DEDUP_PHRASES.some(p => lowered.includes(p));
}
