/**
 * NIP-04 DM helpers — query and publish KIND 4 encrypted direct messages.
 * Server only relays signed/encrypted ciphertext; encryption + decryption
 * happen in the browser so private keys never touch the server.
 */
import WebSocket from 'ws';

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Query KIND 4 events for one user (both sent + received) across a list of
 * relays in parallel. De-dupes by event.id and returns chronological order.
 */
export async function fetchDmEvents(
  relays: string[],
  userPubkey: string,
  since: number,
  isPolling: boolean,
): Promise<SignedEvent[]> {
  const timeout = isPolling ? 5000 : 15000;
  const queryRelays = isPolling ? relays.slice(0, 2) : relays;
  const limit = isPolling ? 50 : 500;

  const [sent, received] = await Promise.all([
    queryEvents(queryRelays, { kinds: [4], authors: [userPubkey], since, limit }, timeout),
    queryEvents(queryRelays, { kinds: [4], '#p': [userPubkey], since, limit }, timeout),
  ]);

  const seen = new Set<string>();
  const merged: SignedEvent[] = [];
  for (const e of [...sent, ...received]) {
    if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
  }
  merged.sort((a, b) => a.created_at - b.created_at);
  return merged;
}

/**
 * Broadcast a single signed event to all relays in parallel.
 * Returns the count of relays that confirmed acceptance.
 */
export async function publishToRelays(relays: string[], event: SignedEvent): Promise<number> {
  const results = await Promise.all(relays.map(url => publishOne(url, event)));
  return results.filter(Boolean).length;
}

// ─── internals ──────────────────────────────────────────────────────────

/**
 * Generic one-shot REQ across relays (parallel, until EOSE or timeout).
 * Results are concatenated as-is — callers de-dupe by event.id. Exported for
 * the shop-order sync (server/lib/orderSync.ts).
 */
export function queryEvents(
  relays: string[],
  filter: Record<string, any>,
  timeout: number,
): Promise<SignedEvent[]> {
  const all: SignedEvent[] = [];
  return Promise.all(relays.map(url => fetchOne(url, filter, timeout)))
    .then(results => {
      for (const list of results) all.push(...list);
      return all;
    });
}

function fetchOne(relayUrl: string, filter: Record<string, any>, timeout: number): Promise<SignedEvent[]> {
  return new Promise(resolve => {
    const events: SignedEvent[] = [];
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      resolve(events); return;
    }
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(events); }, timeout);
    const subId = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    ws.on('open', () => ws.send(JSON.stringify(['REQ', subId, filter])));
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) events.push(msg[2]);
        else if (msg[0] === 'EOSE') { clearTimeout(timer); ws.close(); resolve(events); }
      } catch {}
    });
    ws.on('error', () => { clearTimeout(timer); resolve(events); });
    ws.on('close', () => { clearTimeout(timer); resolve(events); });
  });
}

function publishOne(relayUrl: string, event: SignedEvent): Promise<boolean> {
  return new Promise(resolve => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      resolve(false); return;
    }
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer); ws.close(); resolve(msg[2] === true);
        }
      } catch {}
    });
    ws.on('error', () => { clearTimeout(timer); resolve(false); });
    // A relay may close without ever sending OK (NIP-42 auth-required, or a
    // restart mid-publish). This must answer too: the timeout guard is already
    // cleared by then, so nothing else would ever settle this promise.
    ws.on('close', () => { clearTimeout(timer); resolve(false); });
  });
}
