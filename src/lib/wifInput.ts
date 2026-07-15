/** Classify a scanned/typed private-key input the same way LanaTab does:
 *  reject LanaCoin wallet ADDRESSES and Nostr keys — we need a WIF. */

export type WifInputKind = 'wif' | 'address' | 'nostr';

export function classifyWifInput(raw: string): WifInputKind {
  const trimmed = raw.trim();
  if (trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35) return 'address';
  if (trimmed.startsWith('npub') || trimmed.startsWith('nsec')) return 'nostr';
  return 'wif';
}
