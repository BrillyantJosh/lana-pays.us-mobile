/**
 * The chain, as LANA neposredno reads it: from TWO Electrum servers that must
 * agree, or not at all.
 *
 * The rest of this server reads one Electrum server, the first that answers
 * (lib/electrum.ts). That is fine for showing a balance. It is not enough for a
 * payment this server sends itself: one server that is behind, or wrong, could
 * show a coin as unspent that is gone, or miss a payment still waiting for its
 * block. So every direct sale reads the card's balance, history, unspent coins
 * and the chain tip from every server KIND 38888 names (at most three), and goes
 * on only when two of them answered exactly the same. Previous transactions are
 * read from both and must be identical and hash to their id. A payment is sent
 * to both, and counts as accepted only where a server answered with exactly its
 * txid: a reply without an error field may still be a refusal in other words
 * (lib/electrum.ts resolves any such reply, and the python Electrum server
 * passes a node's refusal on as a plain string).
 *
 * Ported from letsbalance-world apps/api/src/modules/pays-us/chain.ts and
 * apps/api/src/modules/community/electrum.ts (session).
 */
import net from 'node:net';
import { parseLanaTx, txidOfRaw, TXID } from './directLanaTx.js';

export type ElectrumEndpoint = { host: string; port: number };

export type Utxo = { txid: string; vout: number; value: string; height: number };

export type Snapshot = {
  confirmed: string;
  pending: string;
  history: { txid: string; height: number }[];
  utxos: Utxo[];
  height: number;
};

/** What one server said to one broadcast. */
export type BroadcastAnswer = 'accepted' | 'refused' | 'unknown';

export interface ChainRead {
  snapshot: Snapshot;
  /** A previous transaction, identical from both agreeing servers. */
  raw(txid: string): Promise<string>;
  /** Send to both agreeing servers; what each said. */
  broadcast(raw: string): Promise<BroadcastAnswer[]>;
  /** Does each agreeing server hold exactly this transaction (in a block or waiting for one)? */
  holds(txid: string, raw: string): Promise<boolean[]>;
  /** The chain tip is still the one the snapshot was read at, on both servers. */
  tipUnchanged(): Promise<boolean>;
}

export type WithChain = <T>(servers: ElectrumEndpoint[], address: string, task: (chain: ChainRead) => Promise<T>) => Promise<T>;

/** The chain could not be read the way a payment needs it. Nothing was sent. */
export class ChainUnavailable extends Error {
  readonly code = 'CHAIN_UNAVAILABLE';
}

/** A JSON-RPC error answer: the server refused, in so many words. */
export class RpcRefused extends Error {}

export interface Session {
  call(method: string, params: unknown[]): Promise<any>;
  close(): void;
}
export type Connector = (server: ElectrumEndpoint) => Promise<Session>;

const METHODS = [
  'blockchain.address.get_balance',
  'blockchain.address.get_history',
  'blockchain.address.listunspent',
  'blockchain.transaction.broadcast',
  'blockchain.transaction.get',
  'blockchain.headers.subscribe',
];

/**
 * One bounded JSON-RPC connection. Three time limits: to connect, of silence
 * while an answer is owed, and of the whole connection. Once a payment has been
 * handed to the server the connection waits as long as it lives: giving up
 * early on a slow answer would leave a sent payment with an unknown outcome
 * sooner than it needs to.
 */
export function session(socket: net.Socket, limits = { connectMs: 5_000, quietMs: 12_000, lifeMs: 25_000 }): Session {
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let seq = 0;
  let buffer = '';
  let closed = false;
  let patient = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    clearTimeout(connecting);
    clearTimeout(quiet);
    socket.destroy();
    for (const p of pending.values()) p.reject(new Error('Electrum unavailable'));
    pending.clear();
  };
  const deadline = setTimeout(close, limits.lifeMs);
  const connecting = setTimeout(close, limits.connectMs);
  socket.once('connect', () => clearTimeout(connecting));
  const listen = (heard: boolean) => {
    if (heard || !pending.size || patient) {
      clearTimeout(quiet);
      quiet = undefined;
    }
    if (pending.size && !quiet && !closed && !patient) quiet = setTimeout(close, limits.quietMs);
  };
  socket.on('error', close);
  socket.on('close', close);
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 4_000_000) return close();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const response = JSON.parse(line);
        const p = pending.get(response?.id);
        if (!p) continue;
        pending.delete(response.id);
        if (response.error) p.reject(new RpcRefused(typeof response.error?.message === 'string' ? response.error.message : 'refused'));
        else p.resolve(response.result);
      } catch {
        close();
      }
    }
    listen(true);
  });
  return {
    close,
    call(method, params) {
      if (closed || seq >= 250 || !METHODS.includes(method)) return Promise.reject(new Error('Read unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        if (method === 'blockchain.transaction.broadcast') patient = true;
        listen(false);
        socket.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
  };
}

/** A plain TCP connection to one Electrum server KIND 38888 names. */
export const connectElectrum: Connector = async (server) => {
  if (!/^[a-z0-9.-]+$/i.test(server.host) || !server.host.includes('.') || server.port !== 5097) {
    throw new Error('Unsupported Electrum endpoint');
  }
  return session(net.connect({ host: server.host, port: server.port }));
};

const integer = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('Unsafe chain value');
  return v;
};

async function readSnapshot(client: Session, address: string) {
  const [b, h, u, t] = await Promise.all([
    client.call('blockchain.address.get_balance', [address]),
    client.call('blockchain.address.get_history', [address]),
    client.call('blockchain.address.listunspent', [address]),
    client.call('blockchain.headers.subscribe', []),
  ]);
  if (!Array.isArray(h) || h.length > 10_000 || !Array.isArray(u) || u.length > 5_000) throw new Error('Wallet too large');
  const confirmed = integer(b?.confirmed);
  const pending = integer(b?.unconfirmed);
  const height = integer(t?.block_height ?? t?.height);
  if (confirmed < 0 || BigInt(confirmed) + BigInt(pending) < 0n || height < 1) throw new Error('Invalid chain state');
  const history = h.map((row: any) => {
    if (!TXID.test(row?.tx_hash)) throw new Error('Invalid history');
    return { txid: row.tx_hash as string, height: integer(row.height) };
  }).sort((x, y) => x.txid.localeCompare(y.txid));
  const utxos = u.map((row: any) => {
    if (!TXID.test(row?.tx_hash) || integer(row.value) <= 0 || integer(row.tx_pos) < 0) throw new Error('Invalid unspent coin');
    return { txid: row.tx_hash as string, vout: row.tx_pos as number, value: String(row.value), height: integer(row.height) };
  }).sort((x, y) => x.txid.localeCompare(y.txid) || x.vout - y.vout);
  if (new Set(history.map(r => r.txid)).size !== history.length
    || new Set(utxos.map(r => `${r.txid}:${r.vout}`)).size !== utxos.length) {
    throw new Error('Duplicate chain records');
  }
  const snapshot: Snapshot = { confirmed: String(confirmed), pending: String(pending), history, utxos, height };
  return { client, snapshot, tip: JSON.stringify(t), key: JSON.stringify({ snapshot, t }) };
}

/**
 * Read `address` from every server and run `task` on two that agree. Throws
 * ChainUnavailable when fewer than two servers are named, or when no two of
 * them said exactly the same.
 */
export function makeWithChain(connector: Connector = connectElectrum): WithChain {
  return async (servers, address, task) => {
    const list = servers.slice(0, 3);
    if (list.length < 2) throw new ChainUnavailable('Two Electrum sources required');
    const clients: Session[] = [];
    try {
      const opened = await Promise.allSettled(list.map(s => connector(s)));
      for (const o of opened) if (o.status === 'fulfilled') clients.push(o.value);
      const read = await Promise.allSettled(clients.map(c => readSnapshot(c, address)));
      const good = read.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
      const a = good.find(x => good.some(y => y !== x && y.key === x.key));
      const b = a && good.find(y => y !== a && y.key === a.key);
      if (!a || !b) throw new ChainUnavailable('Electrum sources disagree');
      const cache = new Map<string, Promise<string>>();
      const raw = (id: string): Promise<string> => {
        if (!TXID.test(id)) return Promise.reject(new Error('Invalid transaction id'));
        let promise = cache.get(id);
        if (!promise) {
          if (cache.size >= 100) return Promise.reject(new Error('Too many transactions'));
          promise = Promise.all([
            a.client.call('blockchain.transaction.get', [id]),
            b.client.call('blockchain.transaction.get', [id]),
          ]).then(([x, y]) => {
            if (typeof x !== 'string' || x.length > 200_000 || x !== y || txidOfRaw(x) !== id) {
              throw new ChainUnavailable('Transaction sources disagree');
            }
            parseLanaTx(x);
            return x.toLowerCase();
          });
          cache.set(id, promise);
        }
        return promise;
      };
      return await task({
        snapshot: a.snapshot,
        raw,
        async broadcast(bytes) {
          const id = txidOfRaw(bytes);
          const results = await Promise.allSettled([
            a.client.call('blockchain.transaction.broadcast', [bytes]),
            b.client.call('blockchain.transaction.broadcast', [bytes]),
          ]);
          return results.map((r): BroadcastAnswer => {
            if (r.status === 'fulfilled') return typeof r.value === 'string' && r.value.toLowerCase() === id ? 'accepted' : 'unknown';
            return r.reason instanceof RpcRefused ? 'refused' : 'unknown';
          });
        },
        async holds(txid, bytes) {
          const results = await Promise.allSettled([
            a.client.call('blockchain.transaction.get', [txid]),
            b.client.call('blockchain.transaction.get', [txid]),
          ]);
          return results.map(r => r.status === 'fulfilled' && typeof r.value === 'string' && r.value.toLowerCase() === bytes.toLowerCase());
        },
        async tipUnchanged() {
          try {
            const tips = await Promise.all([
              a.client.call('blockchain.headers.subscribe', []),
              b.client.call('blockchain.headers.subscribe', []),
            ]);
            return tips.every(t => JSON.stringify(t) === a.tip);
          } catch {
            return false;
          }
        },
      });
    } finally {
      clients.forEach(c => c.close());
    }
  };
}

export const withChain: WithChain = makeWithChain();

/**
 * True while an unconfirmed transaction spends from this wallet. Coins that are
 * only arriving do not count: anyone can send to a public address, so they must
 * not decide when it may pay (Brilly, 11 Nov 2026, letsbalance-world chain.ts).
 * Both servers drop a confirmed coin from the unspent list the moment an
 * unconfirmed transaction spends it, while the confirmed balance still counts it.
 */
export const spendingPending = (s: Snapshot): boolean =>
  BigInt(s.pending) < 0n
  || s.utxos.reduce((n, u) => (u.height > 0 ? n + BigInt(u.value) : n), 0n) !== BigInt(s.confirmed);
