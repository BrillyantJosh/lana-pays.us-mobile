/**
 * Lana Online Shop — in-browser decryption of KIND 36522 delivery details.
 *
 * The buyer encrypted the details (NIP-44 v2) to the unit owner's hex with
 * their per-order ephemeral key; the server only ever stored the ciphertext.
 * Decryption happens HERE, with the merchant's session key, and the plaintext
 * lives only in React state — never in a request, localStorage or a log.
 */

import * as nip44 from 'nostr-tools/nip44';

export interface DeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

export interface DeliveryDetails {
  v: number;
  name: string;
  email?: string;
  phone?: string;
  address: DeliveryAddress;
  note?: string;
  pickup_slot?: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Decrypt a raw 36522 event with the merchant's private key. Throws when the
 * ciphertext is not addressed to this key or the payload is not the SPEC §4
 * details JSON.
 */
export function decryptDeliveryDetails(
  privateKeyHex: string,
  event: { pubkey: string; content: string },
): DeliveryDetails {
  const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(privateKeyHex), event.pubkey);
  const plaintext = nip44.v2.decrypt(event.content, conversationKey);
  const raw = JSON.parse(plaintext);
  if (!raw || typeof raw !== 'object') throw new Error('bad payload');
  const address = raw.address && typeof raw.address === 'object' ? raw.address : {};
  return {
    v: Number(raw.v) || 1,
    name: str(raw.name),
    email: str(raw.email) || undefined,
    phone: str(raw.phone) || undefined,
    address: {
      line1: str(address.line1),
      line2: str(address.line2) || undefined,
      city: str(address.city),
      postcode: str(address.postcode),
      country: str(address.country),
    },
    note: str(raw.note) || undefined,
    pickup_slot: str(raw.pickup_slot) || undefined,
  };
}
