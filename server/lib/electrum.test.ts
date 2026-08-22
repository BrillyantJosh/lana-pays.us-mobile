import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { fetchBalancesBatch, toWalletBalance, type ElectrumServer } from './electrum.js';

/**
 * A stand-in Electrum server. `answer` decides what (if anything) it replies to
 * each request, so a test can simulate a server that drops some addresses.
 */
function fakeElectrum(answer: (req: any) => any | undefined) {
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const reply = answer(JSON.parse(line));
        if (reply !== undefined) socket.write(JSON.stringify(reply) + '\n');
      }
    });
    socket.on('error', () => { /* client hangs up after the batch */ });
  });
  return {
    listen: () => new Promise<ElectrumServer[]>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve([{ host: '127.0.0.1', port: addr.port }]);
      });
    }),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
    connections: () => connections,
  };
}

const balanceFor = (confirmed: number, unconfirmed = 0) => ({ confirmed, unconfirmed });

describe('toWalletBalance', () => {
  it('converts lanoshi to LANA and rounds to 2 decimals', () => {
    const b = toWalletBalance('LAddr', { result: balanceFor(150_000_000, 25_000_000) });
    expect(b).toMatchObject({ wallet_id: 'LAddr', confirmed: 1.5, unconfirmed: 0.25, balance: 1.75, status: 'active' });
  });

  it('marks an empty wallet inactive, not errored', () => {
    expect(toWalletBalance('LAddr', { result: balanceFor(0) })).toMatchObject({ balance: 0, status: 'inactive' });
  });

  it('reports an Electrum error as status error', () => {
    expect(toWalletBalance('LAddr', { error: { message: 'boom' } })).toMatchObject({ status: 'error', error: 'boom', balance: 0 });
  });
});

describe('fetchBalancesBatch', () => {
  let fake: ReturnType<typeof fakeElectrum> | null = null;
  afterEach(async () => { await fake?.close(); fake = null; });

  it('fetches every address over a SINGLE connection', async () => {
    fake = fakeElectrum(req => ({ id: req.id, result: balanceFor(req.params[0].length * 100_000_000) }));
    const servers = await fake.listen();

    const out = await fetchBalancesBatch(servers, ['LaaaA', 'LbbbBB', 'LcccCCC']);

    expect(out.size).toBe(3);
    expect(out.get('LaaaA')!.balance).toBe(5);
    expect(out.get('LbbbBB')!.balance).toBe(6);
    expect(out.get('LcccCCC')!.balance).toBe(7);
    // The whole point of the batch: 3 addresses must not cost 3 TCP connections.
    expect(fake.connections()).toBe(1);
  });

  it('omits addresses the server never answered instead of reporting zero', async () => {
    fake = fakeElectrum(req => (req.params[0] === 'Lsilent' ? undefined : { id: req.id, result: balanceFor(300_000_000) }));
    const servers = await fake.listen();

    const out = await fetchBalancesBatch(servers, ['Lgood', 'Lsilent'], 300);

    expect(out.get('Lgood')!.balance).toBe(3);
    expect(out.has('Lsilent')).toBe(false); // caller keeps "unknown", never 0
  });

  it('deduplicates repeated addresses', async () => {
    let asked = 0;
    fake = fakeElectrum(req => { asked++; return { id: req.id, result: balanceFor(100_000_000) }; });
    const servers = await fake.listen();

    const out = await fetchBalancesBatch(servers, ['Lsame', 'Lsame', 'Lsame']);

    expect(asked).toBe(1);
    expect(out.size).toBe(1);
  });

  it('returns empty rather than throwing when no server accepts', async () => {
    const out = await fetchBalancesBatch([{ host: '127.0.0.1', port: 1 }], ['Lx'], 300);
    expect(out.size).toBe(0);
  });

  it('does no work for an empty address list', async () => {
    const out = await fetchBalancesBatch([{ host: '127.0.0.1', port: 1 }], []);
    expect(out.size).toBe(0);
  });
});
