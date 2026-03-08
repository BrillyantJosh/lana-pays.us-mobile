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
  const LANOSHI_DIVISOR = 100000000;

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
            const response = JSON.parse(buffer.trim());
            if (response.result) {
              const confirmed = (response.result.confirmed || 0) / LANOSHI_DIVISOR;
              const unconfirmed = (response.result.unconfirmed || 0) / LANOSHI_DIVISOR;
              const total = confirmed + unconfirmed;
              resolve({
                wallet_id: address,
                balance: Math.round(total * 100) / 100,
                confirmed: Math.round(confirmed * 100) / 100,
                unconfirmed: Math.round(unconfirmed * 100) / 100,
                status: total > 0 ? 'active' : 'inactive'
              });
            } else {
              resolve({
                wallet_id: address,
                balance: 0,
                confirmed: 0,
                unconfirmed: 0,
                status: 'error',
                error: response.error?.message || 'Unknown error'
              });
            }
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
