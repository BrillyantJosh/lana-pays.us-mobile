import * as net from 'net';

export interface ElectrumServer {
  host: string;
  port: number;
}

interface WalletBalance {
  wallet_id: string;
  balance: number;
  confirmed: number;
  unconfirmed: number;
  status: string;
  error?: string;
}

export async function connectElectrum(servers: ElectrumServer[], maxRetries = 2): Promise<net.Socket> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const server of servers) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const conn = net.connect(server.port, server.host, () => {
            console.log(`Connected to Electrum ${server.host}:${server.port}`);
            resolve(conn);
          });
          conn.setTimeout(10000);
          conn.on('error', reject);
          conn.on('timeout', () => reject(new Error('Connection timeout')));
        });
        return socket;
      } catch (error: any) {
        console.error(`Electrum ${server.host}:${server.port} failed:`, error.message);
      }
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Failed to connect to any Electrum server');
}

export async function electrumCall(
  method: string,
  params: any[],
  servers: ElectrumServer[],
  timeout = 30000
): Promise<any> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectElectrum(servers);
    const request = { id: Date.now(), method, params };
    const requestData = JSON.stringify(request) + '\n';

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Electrum call timeout after ${timeout}ms`));
      }, timeout);

      let responseText = '';

      socket!.on('data', (data: Buffer) => {
        responseText += data.toString();
        if (responseText.includes('\n')) {
          clearTimeout(timer);
          try {
            responseText = responseText.trim();
            const response = JSON.parse(responseText);
            if (response.error) {
              reject(new Error(`Electrum error: ${JSON.stringify(response.error)}`));
            } else {
              resolve(response.result);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Electrum response: ${e}`));
          }
        }
      });

      socket!.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket!.write(requestData);
    });
  } finally {
    if (socket) {
      try { socket.destroy(); } catch {}
    }
  }
}

export async function fetchSingleBalance(
  servers: ElectrumServer[],
  address: string,
  timeout = 30000
): Promise<WalletBalance> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectElectrum(servers);
    const request = {
      id: 1,
      method: 'blockchain.address.get_balance',
      params: [address]
    };
    socket.write(JSON.stringify(request) + '\n');

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Balance fetch timeout'));
      }, timeout);

      let buffer = '';

      socket!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          clearTimeout(timer);
          try {
            resolve(toWalletBalance(address, JSON.parse(buffer.trim())));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e}`));
          }
        }
      });

      socket!.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    if (socket) {
      try { socket.destroy(); } catch {}
    }
  }
}

const LANOSHI_DIVISOR = 100000000;

/**
 * Shape one Electrum `blockchain.address.get_balance` reply into a WalletBalance.
 * Shared by the single and batched paths so both report the SAME numbers —
 * the regulars list must never disagree with the wallet screens.
 */
export function toWalletBalance(address: string, response: any): WalletBalance {
  if (response?.result) {
    const confirmed = (response.result.confirmed || 0) / LANOSHI_DIVISOR;
    const unconfirmed = (response.result.unconfirmed || 0) / LANOSHI_DIVISOR;
    const total = confirmed + unconfirmed;
    return {
      wallet_id: address,
      balance: Math.round(total * 100) / 100,
      confirmed: Math.round(confirmed * 100) / 100,
      unconfirmed: Math.round(unconfirmed * 100) / 100,
      status: total > 0 ? 'active' : 'inactive',
    };
  }
  return {
    wallet_id: address,
    balance: 0,
    confirmed: 0,
    unconfirmed: 0,
    status: 'error',
    error: response?.error?.message || 'Unknown error',
  };
}

/**
 * Batched balance lookup — ONE socket, every address pipelined over it.
 *
 * `fetchSingleBalance` opens a fresh TCP connection per address, which is fine
 * for one wallet but pathological for a merchant's regular-customer list (157
 * customers = 157 connections, every refresh). Electrum speaks newline-delimited
 * JSON-RPC, so we write all requests up front keyed by id and match the replies
 * back as they stream in. An address that does not answer before the timeout is
 * simply ABSENT from the returned map — callers must treat missing as "unknown",
 * never as a zero balance.
 */
export async function fetchBalancesBatch(
  servers: ElectrumServer[],
  addresses: string[],
  timeout = 20000
): Promise<Map<string, WalletBalance>> {
  const out = new Map<string, WalletBalance>();
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return out;

  let socket: net.Socket;
  try {
    socket = await connectElectrum(servers);
  } catch (error: any) {
    console.error('[electrum] batch connect failed:', error.message);
    return out; // no results — callers keep whatever they already had
  }

  try {
    await new Promise<void>((resolve) => {
      const byId = new Map<number, string>();
      unique.forEach((addr, i) => byId.set(i + 1, addr));

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn(`[electrum] batch timeout: ${out.size}/${unique.length} balances in ${timeout}ms`);
        finish();
      }, timeout);

      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const response = JSON.parse(line);
            const address = byId.get(response.id);
            if (address) out.set(address, toWalletBalance(address, response));
          } catch { /* ignore a malformed line, keep reading the rest */ }
        }
        if (out.size >= unique.length) finish();
      });
      socket.on('error', (err) => {
        console.error('[electrum] batch socket error:', err.message);
        finish();
      });
      socket.on('close', finish);

      for (const [id, address] of byId) {
        socket.write(JSON.stringify({ id, method: 'blockchain.address.get_balance', params: [address] }) + '\n');
      }
    });
  } finally {
    try { socket.destroy(); } catch { /* already gone */ }
  }

  return out;
}
