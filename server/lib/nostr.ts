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
export async function fetchKind0Profile(hexId: string): Promise<{ name?: string; display_name?: string; picture?: string; currency?: string } | null> {
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
                  currency: content.currency,
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

/**
 * Fetch KIND 30901 (Business Unit) events from Lana relays
 * If sinceTimestamp is provided, only fetch events newer than that
 * Otherwise fetch all history
 */
export interface Kind30901Event {
  unit_id: string;
  event_id: string;
  pubkey: string;
  created_at: number;
  name: string;
  owner_hex: string;
  authorized_hex: string[];  // all p tags
  receiver_name?: string;
  receiver_address?: string;
  receiver_zip?: string;
  receiver_city?: string;
  receiver_country?: string;
  bank_name?: string;
  bank_swift?: string;
  bank_account?: string;
  longitude?: string;
  latitude?: string;
  country?: string;
  currency?: string;
  category?: string;
  category_detail?: string;
  image?: string;
  logo?: string;
  status: string;
  lanapays_payout_method: string;
  lanapays_payout_wallet?: string;
  opening_hours_json?: string;
  content: string;
  raw_event: string;
}

function parseKind30901Event(event: NostrEvent): Kind30901Event | null {
  const tags = event.tags;
  const getTag = (name: string) => tags.find(t => t[0] === name)?.[1];

  const unit_id = getTag('unit_id') || getTag('d');
  const name = getTag('name');

  // All p tags = authorized personnel (owner + staff)
  const authorized_hex = tags.filter(t => t[0] === 'p').map(t => t[1]);

  // owner_hex tag preferred; fall back to 'owner' tag if it's a valid 64-char hex;
  // otherwise use the first p tag as the owner
  let owner_hex = getTag('owner_hex');
  if (!owner_hex) {
    const ownerTag = getTag('owner');
    if (ownerTag && /^[0-9a-f]{64}$/i.test(ownerTag)) {
      owner_hex = ownerTag;
    } else if (authorized_hex.length > 0) {
      owner_hex = authorized_hex[0];
    }
  }

  if (!unit_id || !name || !owner_hex) {
    const allTagNames = tags.map(t => t[0]);
    console.warn(`KIND 30901 missing required tags (unit_id=${!!unit_id}, name=${!!name}, owner_hex=${!!owner_hex}), skipping event ${event.id}. Tags: [${allTagNames.join(',')}], p_tags: [${authorized_hex.map(h => h.slice(0,12)+'...').join(',')}]`);
    return null;
  }

  return {
    unit_id,
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    name,
    owner_hex,
    authorized_hex,
    receiver_name: getTag('receiver_name'),
    receiver_address: getTag('receiver_address'),
    receiver_zip: getTag('receiver_zip'),
    receiver_city: getTag('receiver_city'),
    receiver_country: getTag('receiver_country'),
    bank_name: getTag('bank_name'),
    bank_swift: getTag('bank_swift'),
    bank_account: getTag('bank_account'),
    longitude: getTag('longitude'),
    latitude: getTag('latitude'),
    country: getTag('country'),
    currency: getTag('currency'),
    category: getTag('category'),
    category_detail: getTag('category_detail'),
    image: getTag('image'),
    logo: getTag('logo'),
    status: getTag('status') || 'active',
    lanapays_payout_method: getTag('lanapays_payout_method') || 'fiat',
    lanapays_payout_wallet: getTag('lanapays_payout_wallet'),
    opening_hours_json: getTag('opening_hours_json'),
    content: event.content || '',
    raw_event: JSON.stringify(event),
  };
}

export async function fetchKind30901(sinceTimestamp?: number, relays?: string[]): Promise<Kind30901Event[]> {
  const useRelays = relays && relays.length > 0 ? relays : LANA_RELAYS;
  console.log(`Fetching KIND 30901 from ${useRelays.length} relays${sinceTimestamp ? ` (since ${sinceTimestamp})` : ' (full history)'}...`);

  const allEvents: Kind30901Event[] = [];

  const fetchFromRelayKind30901 = (relayUrl: string, timeout = 15000): Promise<NostrEvent[]> => {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const timeoutId = setTimeout(() => {
        console.log(`KIND 30901 timeout for ${relayUrl}`);
        ws.close();
        resolve(events);
      }, timeout);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeoutId);
        resolve([]);
        return;
      }

      const subId = `kind30901_${Date.now()}`;

      ws.on('open', () => {
        const filter: any = { kinds: [30901] };
        if (sinceTimestamp) filter.since = sinceTimestamp;
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            events.push(msg[2] as NostrEvent);
          }
          if (msg[0] === 'EOSE') {
            clearTimeout(timeoutId);
            ws.close();
            resolve(events);
          }
        } catch {}
      });

      ws.on('error', () => {
        clearTimeout(timeoutId);
        resolve(events);
      });

      ws.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  };

  const results = await Promise.all(
    useRelays.map(relay => fetchFromRelayKind30901(relay))
  );

  // Deduplicate by unit_id (d tag), keep newest event per unit_id
  const byUnitId = new Map<string, NostrEvent>();
  for (const relayEvents of results) {
    for (const event of relayEvents) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      const existing = byUnitId.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        byUnitId.set(dTag, event);
      }
    }
  }

  for (const event of byUnitId.values()) {
    const parsed = parseKind30901Event(event);
    if (parsed) allEvents.push(parsed);
  }

  console.log(`KIND 30901: found ${allEvents.length} business units`);
  return allEvents;
}

/**
 * KIND 30903 — Unit Suspension events
 */
export interface Kind30903Event {
  unit_id: string;
  event_id: string;
  pubkey: string;
  created_at: number;
  status: string;        // "suspended" or "active"
  reason: string;
  content: string;
  active_until?: number; // unix timestamp, undefined = indefinite
}

function parseKind30903Event(event: NostrEvent): Kind30903Event | null {
  const tags = event.tags;
  const getTag = (name: string) => tags.find(t => t[0] === name)?.[1];

  const unit_id = getTag('unit_id') || getTag('d');
  const status = getTag('status');

  if (!unit_id || !status) return null;

  const activeUntilStr = getTag('active_until');

  return {
    unit_id,
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    status,
    reason: getTag('reason') || '',
    content: event.content || '',
    active_until: activeUntilStr ? parseInt(activeUntilStr) : undefined,
  };
}

export async function fetchKind30903(relays?: string[]): Promise<Kind30903Event[]> {
  const useRelays = relays && relays.length > 0 ? relays : LANA_RELAYS;
  console.log(`Fetching KIND 30903 from ${useRelays.length} relays...`);

  const fetchFromRelayKind30903 = (relayUrl: string, timeout = 15000): Promise<NostrEvent[]> => {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(events);
      }, timeout);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeoutId);
        resolve([]);
        return;
      }

      const subId = `kind30903_${Date.now()}`;

      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', subId, { kinds: [30903] }]));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            events.push(msg[2] as NostrEvent);
          }
          if (msg[0] === 'EOSE') {
            clearTimeout(timeoutId);
            ws.close();
            resolve(events);
          }
        } catch {}
      });

      ws.on('error', () => { clearTimeout(timeoutId); resolve(events); });
      ws.on('close', () => { clearTimeout(timeoutId); });
    });
  };

  const results = await Promise.all(
    useRelays.map(relay => fetchFromRelayKind30903(relay))
  );

  // Deduplicate by unit_id, keep newest
  const byUnitId = new Map<string, NostrEvent>();
  for (const relayEvents of results) {
    for (const event of relayEvents) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      const existing = byUnitId.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        byUnitId.set(dTag, event);
      }
    }
  }

  const parsed: Kind30903Event[] = [];
  for (const event of byUnitId.values()) {
    const p = parseKind30903Event(event);
    if (p) parsed.push(p);
  }

  console.log(`KIND 30903: found ${parsed.length} suspension events`);
  return parsed;
}

export function getLanaRelays(): string[] {
  return LANA_RELAYS;
}

/**
 * Fetch full KIND 0 profile content for a given hex pubkey
 */
export async function fetchKind0Full(hexId: string): Promise<{ content: any; tags: string[][]; created_at: number } | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 8000);
    let resolved = false;

    for (const relayUrl of LANA_RELAYS) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        continue;
      }

      const subId = `kind0full_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

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
                resolve({ content, tags: event.tags || [], created_at: event.created_at });
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

/**
 * Broadcast a pre-signed Nostr event to relays
 */
export async function broadcastEvent(event: NostrEvent, relays?: string[]): Promise<{ success: string[]; failed: string[] }> {
  const useRelays = relays && relays.length > 0 ? relays : LANA_RELAYS;
  const success: string[] = [];
  const failed: string[] = [];

  const broadcastToRelay = (relayUrl: string, timeout = 10000): Promise<boolean> => {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        ws.close();
        resolve(false);
      }, timeout);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeoutId);
        resolve(false);
        return;
      }

      ws.on('open', () => {
        ws.send(JSON.stringify(['EVENT', event]));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'OK') {
            clearTimeout(timeoutId);
            ws.close();
            resolve(msg[2] === true);
          }
        } catch {}
      });

      ws.on('error', () => {
        clearTimeout(timeoutId);
        resolve(false);
      });

      ws.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  };

  const results = await Promise.all(
    useRelays.map(async (relay) => {
      const ok = await broadcastToRelay(relay);
      if (ok) success.push(relay);
      else failed.push(relay);
    })
  );

  return { success, failed };
}

/**
 * Languages list for KIND 0 lang tag
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'en-US', name: 'English (US)', nativeName: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)', nativeName: 'English (UK)' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'es-419', name: 'Spanish (LatAm)', nativeName: 'Español (LatAm)' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'sr', name: 'Serbian', nativeName: 'Srpski' },
  { code: 'bs', name: 'Bosnian', nativeName: 'Bosanski' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
];
