/**
 * Client-side Nostr event signing using nostr-tools
 */
import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export interface Kind0Content {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  website?: string;
  nip05?: string;
  language?: string;
  location?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  currency?: string;
  email?: string;
  phone?: string;
  phone_country_code?: string;
  lanoshi2lash?: string;
  lanaWalletID?: string;
  whoAreYou?: string;
  orgasmic_profile?: string;
  statement_of_responsibility?: string;
  payment_methods?: any[];
  preferred_payout?: string;
  preferred_collect?: string;
  // Legacy banking
  bankName?: string;
  bankAddress?: string;
  bankSWIFT?: string;
  bankAccount?: string;
}

export function createAndSignKind0(
  privateKeyHex: string,
  content: Kind0Content,
  tags: string[][]
) {
  const secretKey = hexToBytes(privateKeyHex);

  // Clean content: remove empty strings and undefined values
  const cleanContent: Record<string, any> = {};
  for (const [key, value] of Object.entries(content)) {
    if (value !== undefined && value !== null && value !== '') {
      cleanContent[key] = value;
    }
  }

  const template: EventTemplate = {
    kind: 0,
    tags,
    content: JSON.stringify(cleanContent),
    created_at: Math.floor(Date.now() / 1000),
  };

  return finalizeEvent(template, secretKey);
}
