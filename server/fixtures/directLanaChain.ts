/**
 * A fake LANA chain for tests of LANA neposredno, read as if from "two agreeing
 * Electrum servers": confirmed coins, a mempool, blocks. A broadcast is
 * accepted (the payment waits for a block), answered oddly (no clear answer),
 * refused by both, or the servers are down. Nothing here touches a network.
 */
import { ChainUnavailable, type WithChain, type ChainRead, type Utxo, type BroadcastAnswer } from '../lib/directLanaChain.js';
import { parseLanaTx, txidOfRaw } from '../lib/directLanaTx.js';
import { addressScript, bytesToHex } from '../lib/directLanaCore.js';
import { previousTx } from './directLana.js';

type Address = { confirmed: bigint; pending: bigint; utxos: Utxo[]; history: { txid: string; height: number }[] };

export class FakeChain {
  addresses = new Map<string, Address>();
  raws = new Map<string, string>();
  mempool = new Set<string>();
  height = 300;
  mode: 'accept' | 'odd' | 'refuse' | 'down' = 'accept';
  /** Every raw transaction handed to "the servers", in order. */
  broadcasts: string[] = [];
  private salt = 10;

  reset(): void {
    this.addresses.clear();
    this.raws.clear();
    this.mempool.clear();
    this.broadcasts.length = 0;
    this.height = 300;
    this.mode = 'accept';
  }

  addr(address: string): Address {
    if (!this.addresses.has(address)) this.addresses.set(address, { confirmed: 0n, pending: 0n, utxos: [], history: [] });
    return this.addresses.get(address)!;
  }

  /** Confirmed coins for an address, each from its own previous transaction. */
  fund(address: string, values: bigint[], height = 100): void {
    const a = this.addr(address);
    for (const v of values) {
      const prev = previousTx(address, [v], 1000, this.salt++);
      this.raws.set(prev.txid, prev.raw);
      a.utxos.push({ txid: prev.txid, vout: 0, value: v.toString(), height });
      a.history.push({ txid: prev.txid, height });
      a.confirmed += v;
    }
  }

  /** The value an input spends from `address`, when it spends one of its outputs. */
  private spentFrom(address: string, prevTxid: string, vout: number): bigint | null {
    const prev = this.raws.get(prevTxid);
    const out = prev ? parseLanaTx(prev).outputs[vout] : undefined;
    return out && out.script === bytesToHex(addressScript(address)) ? out.lanoshis : null;
  }

  /** Accepted: its coins leave the payer's unspent list, it waits for a block. */
  enterMempool(raw: string): void {
    const txid = txidOfRaw(raw);
    const tx = parseLanaTx(raw);
    this.raws.set(txid, raw);
    this.mempool.add(txid);
    for (const [address, a] of this.addresses) {
      let spent = 0n;
      for (const i of tx.inputs) {
        const v = this.spentFrom(address, i.prevTxid, i.vout);
        if (v === null) continue;
        spent += v;
        a.utxos = a.utxos.filter(u => !(u.txid === i.prevTxid && u.vout === i.vout));
      }
      if (spent > 0n) {
        a.pending -= spent;
        if (!a.history.some(h => h.txid === txid)) a.history.push({ txid, height: 0 });
      }
    }
  }

  /** In block `height`: the payer's coins are gone for good, its change is a coin, the payee's output too. */
  mine(raw: string, height = this.height): void {
    const txid = txidOfRaw(raw);
    const tx = parseLanaTx(raw);
    const wasWaiting = this.mempool.has(txid);
    this.raws.set(txid, raw);
    this.mempool.delete(txid);
    for (const [address, a] of this.addresses) {
      const own = bytesToHex(addressScript(address));
      let spent = 0n;
      for (const i of tx.inputs) {
        const v = this.spentFrom(address, i.prevTxid, i.vout);
        if (v === null) continue;
        spent += v;
        a.utxos = a.utxos.filter(u => !(u.txid === i.prevTxid && u.vout === i.vout));
      }
      a.confirmed -= spent;
      if (wasWaiting) a.pending += spent;
      let received = false;
      tx.outputs.forEach((o, vout) => {
        if (o.script !== own) return;
        received = true;
        a.utxos.push({ txid, vout, value: o.lanoshis.toString(), height });
        a.confirmed += o.lanoshis;
      });
      if (spent > 0n || received) {
        a.history = a.history.filter(h => h.txid !== txid);
        a.history.push({ txid, height });
      }
    }
  }

  /** What directLana.ts gets instead of two live Electrum servers. */
  withChain: WithChain = async (servers, address, task) => {
    if (servers.length < 2 || this.mode === 'down') throw new ChainUnavailable('Electrum sources disagree');
    const a = this.addr(address);
    const read: ChainRead = {
      snapshot: {
        confirmed: a.confirmed.toString(),
        pending: a.pending.toString(),
        history: a.history.map(h => ({ ...h })),
        utxos: a.utxos.map(u => ({ ...u })),
        height: this.height,
      },
      raw: async (id) => {
        const r = this.raws.get(id);
        if (!r) throw new Error('unknown transaction');
        return r;
      },
      broadcast: async (raw): Promise<BroadcastAnswer[]> => {
        this.broadcasts.push(raw);
        if (this.mode === 'accept') {
          this.enterMempool(raw);
          return ['accepted', 'accepted'];
        }
        if (this.mode === 'odd') return ['unknown', 'unknown'];
        return ['refused', 'refused'];
      },
      holds: async (txid) => [this.mempool.has(txid), this.mempool.has(txid)],
      tipUnchanged: async () => true,
    };
    return task(read);
  };
}
