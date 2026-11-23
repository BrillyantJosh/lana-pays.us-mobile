/**
 * The Lana Registrar, asked about one wallet for a direct LANA sale, with this
 * server's own key (the same call as POST /api/check-wallet in index.ts).
 *
 * FAIL CLOSED. There is no brain behind a direct sale to catch a wrong answer,
 * and LANA paid from or to a wallet that is not what it seems can get the shop's
 * wallet frozen. So anything that is not a clear, complete answer is
 * "unavailable", and the sale is refused: no key configured, a timeout, any
 * non-2xx (401, 429, 5xx), a body that is not the registrar's shape, a wallet
 * that comes back as another wallet, a frozen flag that is not a boolean.
 *
 * The till's own check (LanaTab) carries on when the registrar does not answer;
 * this one never does.
 */

export type RegistrarAnswer =
  | {
      registered: true;
      wallet_type: string;
      frozen: boolean;
      freeze_reason: string | null;
      /** The owner's Nostr HEX, or null when the registrar could not tell. */
      owner: string | null;
    }
  | { registered: false };

export type RegistrarLookup = (walletId: string) => Promise<RegistrarAnswer>;

/** The registrar could not give a clear answer. Nothing may move. */
export class RegistrarUnavailable extends Error {
  readonly code = 'REGISTRAR_UNAVAILABLE';
}

const MAX_BODY = 20_000;

export async function registrarLookup(walletId: string): Promise<RegistrarAnswer> {
  const apiKey = process.env.LANA_REGISTER_API_KEY;
  if (!apiKey) throw new RegistrarUnavailable('Registrar key not configured');
  const base = process.env.LANA_REGISTRAR_URL || 'https://lanatrace.us';
  let res: Response;
  try {
    res = await fetch(`${base}/functions/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'simple_check_wallet_registration', api_key: apiKey, data: { wallet_id: walletId } }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new RegistrarUnavailable('Registrar did not answer');
  }
  if (!res.ok) throw new RegistrarUnavailable(`Registrar answered HTTP ${res.status}`);
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new RegistrarUnavailable('Registrar answer unreadable');
  }
  if (text.length > MAX_BODY) throw new RegistrarUnavailable('Registrar answer too large');
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RegistrarUnavailable('Registrar answer unreadable');
  }
  return readRegistrarAnswer(body, walletId);
}

/** The registrar's body, read strictly. Exported for tests. */
export function readRegistrarAnswer(body: any, walletId: string): RegistrarAnswer {
  if (!body || typeof body !== 'object' || body.success !== true) throw new RegistrarUnavailable('Registrar refused the question');
  if (body.registered === false) return { registered: false };
  if (body.registered !== true) throw new RegistrarUnavailable('Registrar answer incomplete');
  const w = body.wallet;
  if (!w || typeof w !== 'object' || w.wallet_id !== walletId) throw new RegistrarUnavailable('Registrar answered about another wallet');
  if (typeof w.wallet_type !== 'string' || typeof w.frozen !== 'boolean') throw new RegistrarUnavailable('Registrar answer incomplete');
  const owner = typeof w.nostr_hex_id === 'string' && /^[0-9a-f]{64}$/.test(w.nostr_hex_id) ? w.nostr_hex_id : null;
  return {
    registered: true,
    wallet_type: w.wallet_type,
    frozen: w.frozen,
    freeze_reason: typeof w.freeze_reason === 'string' && w.freeze_reason ? w.freeze_reason : null,
    owner,
  };
}
