/**
 * Nostr Library for Lana Pays.Us
 * Fetches KIND 38888 (system params) from Lana relays
 */

import WebSocket from 'ws';

const LANA_RELAYS = [
  'wss://relay.lanavault.space',
  'wss://relay.lanacoin-eternity.com'
];

const KIND_38888_PUBKEY = '9eb71bf1e9c3189c78800e4c3831c1c1a93ab43b61118818c32e4490891a35b3';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Kind38888Data {
  event_id: string;
  pubkey: string;
  created_at: number;
  relays: string[];
  electrum_servers: Array<{ host: string; port: string }>;
  exchange_rates: { EUR: number; USD: number; GBP: number };
  split: string;
  split_target_lana?: number;
  split_started_at?: number;
  split_ends_at?: number;
  version: string;
  valid_from: number;
  raw_event: string;
}

async function fetchFromRelay(relayUrl: string, timeout = 15000): Promise<NostrEvent | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`Timeout connecting to ${relayUrl}`);
      ws.close();
      resolve(null);
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch (error) {
      console.error(`Failed to create WebSocket for ${relayUrl}:`, error);
      clearTimeout(timeoutId);
      resolve(null);
      return;
    }

    const subscriptionId = `kind38888_${Date.now()}`;

    ws.on('open', () => {
      console.log(`Connected to ${relayUrl}`);

      const filter = {
        kinds: [38888],
        authors: [KIND_38888_PUBKEY],
        '#d': ['main'],
        limit: 1
      };

      const req = JSON.stringify(['REQ', subscriptionId, filter]);
      ws.send(req);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message[0] === 'EVENT' && message[1] === subscriptionId) {
          const event = message[2] as NostrEvent;

          if (event.pubkey !== KIND_38888_PUBKEY) {
            console.warn(`Ignoring event from unauthorized pubkey: ${event.pubkey}`);
            return;
          }

          if (event.kind !== 38888) {
            console.warn(`Ignoring non-38888 event: kind ${event.kind}`);
            return;
          }

          console.log(`Got valid KIND 38888 event from ${relayUrl}, id: ${event.id}`);
          clearTimeout(timeoutId);
          ws.close();
          resolve(event);
        }
      } catch (error) {
        console.error(`Error parsing message from ${relayUrl}:`, error);
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${relayUrl}:`, error);
      clearTimeout(timeoutId);
      resolve(null);
    });

    ws.on('close', () => {
      clearTimeout(timeoutId);
    });
  });
}

function parseKind38888Event(event: NostrEvent): Kind38888Data {
  let content: any = {};
  try {
    content = typeof event.content === 'string' && event.content.trim().startsWith('{')
      ? JSON.parse(event.content)
      : {};
  } catch (e) {
    console.warn('Failed to parse content as JSON, using tags only');
  }

  const tags = event.tags;

  const relays = tags
    .filter(t => t[0] === 'relay')
    .map(t => t[1]);

  const electrum_servers = tags
    .filter(t => t[0] === 'electrum')
    .map(t => ({ host: t[1], port: t[2] || '5097' }));

  const fxTags = tags.filter(t => t[0] === 'fx');
  const exchange_rates = {
    EUR: parseFloat(fxTags.find(t => t[1] === 'EUR')?.[2] || '0'),
    USD: parseFloat(fxTags.find(t => t[1] === 'USD')?.[2] || '0'),
    GBP: parseFloat(fxTags.find(t => t[1] === 'GBP')?.[2] || '0')
  };

  const split = tags.find(t => t[0] === 'split')?.[1] || content.split || '';
  const split_target_lana = parseInt(tags.find(t => t[0] === 'split_target_lana')?.[1] || content.split_target_lana || '0');
  const split_started_at = parseInt(tags.find(t => t[0] === 'split_started_at')?.[1] || content.split_started_at || '0');
  const split_ends_at = parseInt(tags.find(t => t[0] === 'split_ends_at')?.[1] || content.split_ends_at || '0');
  const version = tags.find(t => t[0] === 'version')?.[1] || content.version || '1';
  const valid_from = parseInt(tags.find(t => t[0] === 'valid_from')?.[1] || content.valid_from || '0');

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    relays: relays.length > 0 ? relays : content.relays || LANA_RELAYS,
    electrum_servers: electrum_servers.length > 0 ? electrum_servers : content.electrum || [],
    exchange_rates,
    split,
    split_target_lana,
    split_started_at,
    split_ends_at,
    version,
    valid_from,
    raw_event: JSON.stringify(event)
  };
}

export async function fetchKind38888(): Promise<Kind38888Data | null> {
  console.log('Fetching KIND 38888 from Lana relays...');

  const results = await Promise.all(
    LANA_RELAYS.map(relay => fetchFromRelay(relay))
  );

  const validEvents = results.filter((e): e is NostrEvent => e !== null);

  if (validEvents.length === 0) {
    console.error('No valid KIND 38888 events received from any relay');
    return null;
  }

  validEvents.sort((a, b) => b.created_at - a.created_at);
  const newestEvent = validEvents[0];

  console.log(`Using KIND 38888 event: ${newestEvent.id} (created_at: ${newestEvent.created_at})`);
  return parseKind38888Event(newestEvent);
}

/**
 * Fetch KIND 0 (profile metadata) for a given hex pubkey from Lana relays
 */
export async function fetchKind0Profile(hexId: string): Promise<{ name?: string; display_name?: string; picture?: string } | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);
    let resolved = false;

    for (const relayUrl of LANA_RELAYS) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        continue;
      }

      const subId = `kind0_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [0],
          authors: [hexId],
          limit: 1
        }]));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[1] === subId && !resolved) {
            const event = msg[2];
            if (event.kind === 0) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              try {
                const content = JSON.parse(event.content);
                resolve({
                  name: content.name,
                  display_name: content.display_name,
                  picture: content.picture,
                });
              } catch {
                resolve(null);
              }
            }
          }
          if (msg[0] === 'EOSE' && !resolved) {
            ws.close();
          }
        } catch {}
      });

      ws.on('error', () => ws.close());
    }
  });
}

export function getLanaRelays(): string[] {
  return LANA_RELAYS;
}
