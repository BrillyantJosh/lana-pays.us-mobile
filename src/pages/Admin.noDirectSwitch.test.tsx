/**
 * The admin page has no switch for LANA neposredno any more (Brilly, 26 Nov
 * 2026: "ne rabim stikala, naredi da povsod dela"): every shop without a
 * company takes it. The page neither shows nor sends the old setting, and its
 * other settings are saved as before.
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
  // The page is up once its limits section is there.
  await screen.findAllByText(i18n.t('common.save'));
}

describe('no LANA direct switch on the admin page', () => {
  it('neither the section nor its words, whatever the server still has stored', async () => {
    stored = '';
    await open();
    expect(screen.queryByTestId('admin-direct-lana')).toBeNull();
    expect(screen.queryByTestId('admin-direct-lana-units')).toBeNull();
    expect(document.body.textContent).not.toContain('LANA direct (shops without a company)');
  });

  it('the other settings are saved as before, without the old setting in their body', async () => {
    stored = 'unit-1';
    await open();
    fireEvent.click(screen.getAllByText(i18n.t('common.save'))[0].closest('button')!);
    await waitFor(() => expect(puts.length).toBe(1));
    const body = JSON.parse(puts[0].body);
    expect(Object.keys(body.settings).sort()).toEqual(['customer_window_days', 'default_max_tx_amount']);
    expect(puts[0].body).not.toContain('direct_lana_units');
  });
});
