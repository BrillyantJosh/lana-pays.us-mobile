/**
 * The till may WRITE a profile only when it is sure there is none.
 *
 * 8 Oct 2026, Živa center: a brand-new card was first scanned in the LANA tab,
 * which quietly registered it with no name and then said "not enough LANA". The
 * cashier rescanned it under cash; it was registered by then, so the till never
 * asked for a name and the sale went through as a bare hex. The till now asks
 * for the name of a registered card that has no profile anywhere — and since it
 * publishes that name as the person's KIND 0, "no profile" has to mean every
 * relay answered and none held one. These tests pin all three answers.
 */
import { test, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { fetchKind0Status } from './nostr.js';

type Behaviour =
  | { kind: 'eose' }
  | { kind: 'event-then-eose'; event: any }
  | { kind: 'close-without-eose' }
  | { kind: 'closed-msg' }
  | { kind: 'silent' };

async function startRelay(behaviour: Behaviour) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  wss.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg[0] !== 'REQ') return;
      const sub = msg[1];
      switch (behaviour.kind) {
        case 'eose': socket.send(JSON.stringify(['EOSE', sub])); break;
        case 'event-then-eose':
          socket.send(JSON.stringify(['EVENT', sub, behaviour.event]));
          socket.send(JSON.stringify(['EOSE', sub]));
          break;
        case 'close-without-eose': socket.close(); break;
        case 'closed-msg': socket.send(JSON.stringify(['CLOSED', sub, 'error: rate-limited'])); break;
        case 'silent': break;
      }
    });
  });
  return { url: `ws://127.0.0.1:${port}`, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

async function withRelays(behaviours: Behaviour[], fn: (urls: string[]) => Promise<void>) {
  const relays = await Promise.all(behaviours.map(startRelay));
  try { await fn(relays.map((r) => r.url)); } finally { await Promise.all(relays.map((r) => r.close())); }
}

const sk = generateSecretKey();
const hex = getPublicKey(sk);
const profile = (content: object, key = sk) =>
  finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(content) }, key);

test('every relay answers and none holds a profile → absent', async () => {
  await withRelays([{ kind: 'eose' }, { kind: 'eose' }, { kind: 'eose' }, { kind: 'eose' }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'absent' });
  });
});

test('a signed profile on any relay → found, real name first', async () => {
  const ev = profile({ name: 'Ana Novak', display_name: 'ana' });
  await withRelays([{ kind: 'eose' }, { kind: 'event-then-eose', event: ev }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'found', name: 'Ana Novak' });
  });
});

test('a profile with no usable name is still found — the till must not overwrite it', async () => {
  const ev = { ...profile({ about: 'x' }) };
  await withRelays([{ kind: 'event-then-eose', event: ev }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'found', name: null });
  });
});

test('a forged profile (bad signature) is ignored, not believed', async () => {
  const forged = { ...profile({ name: 'Mallory' }), sig: '00'.repeat(64) };
  await withRelays([{ kind: 'event-then-eose', event: forged }, { kind: 'eose' }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'absent' });
  });
});

test("someone else's profile served under this key is ignored", async () => {
  const other = profile({ name: 'Someone Else' }, generateSecretKey());
  await withRelays([{ kind: 'event-then-eose', event: other }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'absent' });
  });
});

test('a relay that closes before EOSE makes it unknown, never absent', async () => {
  await withRelays([{ kind: 'eose' }, { kind: 'close-without-eose' }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'unknown' });
  });
});

test('a relay that refuses the subscription (CLOSED) makes it unknown', async () => {
  await withRelays([{ kind: 'eose' }, { kind: 'closed-msg' }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'unknown' });
  });
});

test('a failed relay does not hide a profile another relay holds', async () => {
  const ev = profile({ name: 'Ana Novak' });
  await withRelays([{ kind: 'close-without-eose' }, { kind: 'event-then-eose', event: ev }], async (urls) => {
    expect(await fetchKind0Status(hex, urls, 2000)).toEqual({ status: 'found', name: 'Ana Novak' });
  });
});

test('a silent relay runs into the deadline → unknown', async () => {
  await withRelays([{ kind: 'eose' }, { kind: 'silent' }], async (urls) => {
    const started = Date.now();
    expect(await fetchKind0Status(hex, urls, 300)).toEqual({ status: 'unknown' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

test('an unreachable relay → unknown', async () => {
  expect(await fetchKind0Status(hex, ['ws://127.0.0.1:1'], 2000)).toEqual({ status: 'unknown' });
});

test('no relays, or a malformed key → unknown, without opening anything', async () => {
  expect(await fetchKind0Status(hex, [], 2000)).toEqual({ status: 'unknown' });
  expect(await fetchKind0Status('not-a-hex', ['ws://127.0.0.1:1'], 2000)).toEqual({ status: 'unknown' });
});
