/**
 * The merchant's own NOTE on a Lana-online payment request — what the payment
 * is for, or who it is for (Brilly + Kati Rina, 22 Nov 2026).
 *
 * DESCRIPTIVE ONLY. It is stored on the request row and shown back to the
 * merchant (tab list, history, "Online payments") and to the payer on the
 * public /pay page. It never goes to the brain, never into a signed event,
 * never into a URL, and nothing about amount, split, recipients or freezing
 * reads it.
 *
 * One line of plain text, at most REQUEST_NOTE_MAX characters (code points, so
 * an emoji is never cut in half). Line breaks and tabs become spaces; control
 * characters and the invisible direction marks that can reorder text on screen
 * are dropped. Empty after cleaning → null (no note). Anything that is not a
 * string → null: an object is not stringified into "[object Object]".
 * React escapes it on display; this is not an HTML sanitizer and need not be.
 */

export const REQUEST_NOTE_MAX = 200;

/** C0/C1 controls (incl. \t \n \r) and DEL — turned into a space. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
/** LRM/RLM, bidi embeddings/overrides/isolates, BOM — removed. */
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
/** A surrogate half without its partner. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanRequestNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw
    .replace(LONE_SURROGATE, '')
    .replace(CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  if (chars.length <= REQUEST_NOTE_MAX) return flat;
  return chars.slice(0, REQUEST_NOTE_MAX).join('').trimEnd();
}
