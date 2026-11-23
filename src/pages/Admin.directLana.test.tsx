/**
 * The admin page's switch for LANA neposredno: it shows what is stored, and it
 * saves SIGNED with the admin's session key (NIP-98 bound to the exact body),
 * only that one setting. The server's own verifier judges what the page sent.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // This runner has no working Storage, and i18n reads `lang` from it at import.
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
});
import { MemoryRouter } from 'react-router-dom';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import i18n from '@/i18n';
import { verifyNip98, forgetSpentTokens } from '../../server/lib/nip98';

declare global {
  var __session: any;
}
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: globalThis.__session }) }));

import Admin from './Admin';

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
let puts: Array<{ headers: Record<string, string>; body: string }> = [];
let stored = '';
let answer: { status: number; body: any } | null = null;

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  forgetSpentTokens();
  const sk = generateSecretKey();
  globalThis.__session = { nostrHexId: getPublicKey(sk), privateKeyHex: toHex(sk) };
  puts = [];
  stored = '';
  answer = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init: any = {}) => {
    if (url.startsWith('/api/admin/check')) return json(200, { isAdmin: true });
    if (url === '/api/admin/settings' && (init.method || 'GET') === 'GET') {
      return json(200, { settings: { default_max_tx_amount: '0', customer_window_days: '1', direct_lana_units: stored } });
    }
    if (url === '/api/admin/settings' && init.method === 'PUT') {
      puts.push({ headers: init.headers, body: init.body });
      if (answer) return json(answer.status, answer.body);
      const value = JSON.parse(init.body).settings.direct_lana_units;
      return json(200, { success: true, updated: 1, direct_lana_units: value });
    }
    return json(404, {});
  }) as any);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  render(<MemoryRouter><Admin /></MemoryRouter>);
  return screen.findByTestId('admin-direct-lana');
}

describe('the LANA direct switch on the admin page', () => {
  it('shows what is stored: off, and a unit list', async () => {
    await open();
    expect((screen.getByTestId('admin-direct-lana-units') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('admin-direct-lana')).toHaveTextContent('Off by default');
  });

  it('saves only this setting, signed for exactly this body; the server\'s verifier accepts it', async () => {
    await open();
    fireEvent.change(screen.getByTestId('admin-direct-lana-units'), { target: { value: ' unit-1 ' } });
    fireEvent.click(screen.getByTestId('admin-direct-lana-save'));
    await waitFor(() => expect(screen.getByTestId('admin-direct-lana-state')).toHaveTextContent('Saved: on for unit-1.'));
    expect(puts.length).toBe(1);
    const sent = puts[0];
    expect(JSON.parse(sent.body)).toEqual({ settings: { direct_lana_units: 'unit-1' } });
    expect(sent.headers['x-admin-hex-id']).toBe(globalThis.__session.nostrHexId);
    const verdict = verifyNip98(sent.headers.Authorization, 'PUT', '/api/admin/settings', { body: Buffer.from(sent.body, 'utf8') });
    expect(verdict).toMatchObject({ ok: true, hex: globalThis.__session.nostrHexId });
    // The token is bound to the body: the same token for another value is no good.
    forgetSpentTokens();
    const other = JSON.stringify({ settings: { direct_lana_units: '*' } });
    expect(verifyNip98(sent.headers.Authorization, 'PUT', '/api/admin/settings', { body: Buffer.from(other, 'utf8') })).toMatchObject({ ok: false, reason: 'PAYLOAD_MISMATCH' });
  });

  it('empty switches it off for every shop; * for every shop without a company', async () => {
    stored = 'unit-1';
    await open();
    await waitFor(() => expect((screen.getByTestId('admin-direct-lana-units') as HTMLInputElement).value).toBe('unit-1'));
    fireEvent.change(screen.getByTestId('admin-direct-lana-units'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('admin-direct-lana-save'));
    await waitFor(() => expect(screen.getByTestId('admin-direct-lana-state')).toHaveTextContent('Saved: off for every shop.'));
    fireEvent.change(screen.getByTestId('admin-direct-lana-units'), { target: { value: '*' } });
    fireEvent.click(screen.getByTestId('admin-direct-lana-save'));
    await waitFor(() => expect(screen.getByTestId('admin-direct-lana-state')).toHaveTextContent('Saved: on for every shop without a company.'));
  });

  it('a refusal (no valid signature) is said, and nothing reads as saved', async () => {
    answer = { status: 401, body: { success: false, code: 'SIGNATURE_REQUIRED', reason: 'STALE' } };
    await open();
    fireEvent.change(screen.getByTestId('admin-direct-lana-units'), { target: { value: '*' } });
    fireEvent.click(screen.getByTestId('admin-direct-lana-save'));
    await waitFor(() => expect(screen.getByTestId('admin-direct-lana-state')).toHaveTextContent('Not saved'));
  });

  it('the other settings are saved as before, without the switch in their body', async () => {
    await open();
    // The limits section's Save, the first "Save" on the page (the Split date and the switch have their own).
    fireEvent.click(screen.getAllByText(i18n.t('common.save'))[0].closest('button')!);
    await waitFor(() => expect(puts.length).toBe(1));
    const body = JSON.parse(puts[0].body);
    expect(Object.keys(body.settings).sort()).toEqual(['customer_window_days', 'default_max_tx_amount']);
  });
});
