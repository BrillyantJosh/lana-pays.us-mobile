import { finalizeEvent } from 'nostr-tools/pure';

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function signNostrEvent(
  privateKeyHex: string,
  kind: number,
  content: string,
  tags: string[][] = []
): NostrEvent {
  const secretKey = hexToBytes(privateKeyHex);
  const eventTemplate = {
    kind,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
  const signedEvent = finalizeEvent(eventTemplate, secretKey);
  return signedEvent as NostrEvent;
}

export async function publishToRelays(
  event: NostrEvent,
  relays: string[],
  timeout = 15000
): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = [];
  const failed: string[] = [];

  const publishToRelay = (relayUrl: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => { ws.close(); resolve(false); }, timeout);
      let ws: WebSocket;
      try { ws = new WebSocket(relayUrl); } catch { clearTimeout(timeoutId); resolve(false); return; }
      ws.onopen = () => { ws.send(JSON.stringify(['EVENT', event])); };
      ws.onmessage = (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message[0] === 'OK' && message[1] === event.id) {
            clearTimeout(timeoutId); ws.close(); resolve(message[2] === true);
          }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timeoutId); resolve(false); };
      ws.onclose = () => { clearTimeout(timeoutId); };
    });
  };

  await Promise.all(relays.map(async (relay) => {
    const ok = await publishToRelay(relay);
    if (ok) success.push(relay); else failed.push(relay);
  }));

  return { success, failed };
}
