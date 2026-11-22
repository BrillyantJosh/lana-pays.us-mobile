/**
 * The merchant's optional note on a Lana-online payment request — what the
 * payment is for, or who it is for. Descriptive only: it is stored with the
 * request and shown back, nothing about the money reads it.
 *
 * The server keeps it as ONE line of at most REQUEST_NOTE_MAX characters
 * (server/lib/requestNote.ts). The field follows the same rules while the
 * merchant types, so what they see is what is saved. Characters are counted
 * as code points, so an emoji counts once and is never cut in half (the
 * textarea's own maxLength would count it twice).
 */

export const REQUEST_NOTE_MAX = 200;

/** While typing: a line break or tab becomes a space; the text stops at the limit. */
export function typedNote(value: string): string {
  const oneLine = value.replace(/[\r\n\t]+/g, ' ');
  const chars = Array.from(oneLine);
  return chars.length > REQUEST_NOTE_MAX ? chars.slice(0, REQUEST_NOTE_MAX).join('') : oneLine;
}

/** What goes in the request body: the trimmed note, or nothing at all. */
export function noteToSend(value: string): string | undefined {
  const v = value.trim();
  return v ? v : undefined;
}

/** How many characters the note has, as the counter shows it. */
export function noteLength(value: string): number {
  return Array.from(value).length;
}
