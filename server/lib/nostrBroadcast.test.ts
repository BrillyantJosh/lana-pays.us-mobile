/**
 * The publish path must always answer.
 *
 * Until 2026-08-20 the per-relay close handler did this:
 *
 *   ws.on('close', () => { clearTimeout(timeoutId); });
 *
 * — it disarmed the timeout guard without ever resolving. A relay that closed
 * the socket without sending OK (NIP-42 auth-required, or a restart
 * mid-publish) left that promise pending forever, and since the broadcast
 * awaits Promise.all over every relay, the whole publish hung with no outer
 * bound. Latent rather than active, but one relay restart away from wedging
 * the HTTP request sitting behind it.
 *
 * These tests pin that every relay outcome settles, and that a real OK still
 * wins over the close that immediately follows it.
 */
import { test, expect } from 'vitest';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { broadcastEvent } from './nostr.js';

type Behaviour = 'close-without-ok' | 'ok-true' | 'ok-false' | 'ok-then-close';

async function startRelay(behaviour: Behaviour) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  wss.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg[0] !== 'EVENT') return;
      const id = msg[1]?.id;

      switch (behaviour) {
        case 'close-without-ok': socket.close(); break;
        case 'ok-true':          socket.send(JSON.stringify(['OK', id, true, ''])); break;
        case 'ok-false':         socket.send(JSON.stringify(['OK', id, false, 'blocked'])); break;
        case 'ok-then-close':    socket.send(JSON.stringify(['OK', id, true, ''])); socket.close(); break;
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => { wss.close(() => resolve()); }),
  };
}

const anEvent = () => ({
  id: crypto.randomBytes(32).toString('hex'),
  pubkey: 'a'.repeat(64),
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [] as string[][],
  content: 'broadcast test',
  sig: 'b'.repeat(128),
}) as any;

// vitest's 5s default timeout is the point: the per-relay guard is 10s+, so if
// any of these had to fall back to it, the test fails instead of hanging.

test('a relay that closes without OK is reported failed, not left hanging', async () => {
  const relay = await startRelay('close-without-ok');
  try {
    const r = await broadcastEvent(anEvent(), [relay.url]);
    expect(r.success).toEqual([]);
    expect(r.failed).toEqual([relay.url]);
  } finally { await relay.stop(); }
});

test('one dead relay does not strand the healthy one', async () => {
  const dead = await startRelay('close-without-ok');
  const live = await startRelay('ok-true');
  try {
    const r = await broadcastEvent(anEvent(), [dead.url, live.url]);
    expect(r.success).toEqual([live.url]);
    expect(r.failed).toEqual([dead.url]);
  } finally { await Promise.all([dead.stop(), live.stop()]); }
});

test('OK true beats the close that follows it', async () => {
  const relay = await startRelay('ok-then-close');
  try {
    const r = await broadcastEvent(anEvent(), [relay.url]);
    expect(r.success).toEqual([relay.url]);
    expect(r.failed).toEqual([]);
  } finally { await relay.stop(); }
});

test('OK false is a failure, not a success', async () => {
  const relay = await startRelay('ok-false');
  try {
    const r = await broadcastEvent(anEvent(), [relay.url]);
    expect(r.success).toEqual([]);
    expect(r.failed).toEqual([relay.url]);
  } finally { await relay.stop(); }
});

test('every relay is accounted for exactly once', async () => {
  const relays = await Promise.all([
    startRelay('ok-true'), startRelay('close-without-ok'), startRelay('ok-false'),
  ]);
  try {
    const urls = relays.map(r => r.url);
    const r = await broadcastEvent(anEvent(), urls);
    expect(r.success.length + r.failed.length).toBe(urls.length);
    expect([...r.success, ...r.failed].sort()).toEqual([...urls].sort());
  } finally { await Promise.all(relays.map(r => r.stop())); }
});
