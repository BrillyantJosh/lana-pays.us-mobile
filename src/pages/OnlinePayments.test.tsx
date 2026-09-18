/**
 * The "Online payments" page as a merchant sees it, against a stubbed server.
 *
 * Pinned: the request is signed and carries no hex; "marked paid" is green and
 * says MARKED; a status the server could not check is grey with a "?" and never
 * green; a customer who has not paid yet leaves the investor line as a dash;
 * the bank reward is its own line; and a refused signature is explained by its
 * cause (the device clock, or a fresh sign-in) — never "refresh".
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { KEY } = vi.hoisted(() => {
  // This runner has no real Storage, and i18n reads `lang` from it at import.
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
  return { KEY: '01'.repeat(32) };
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { privateKeyHex: KEY, nostrHexId: 'ab'.repeat(32) } }),
}));

import i18n from '@/i18n';
import OnlinePayments from './OnlinePayments';

const legNA = { invoice: { state: 'not_applicable', marked_paid_at: null }, reward: null, checked_at: null };

const BODY = {
  success: true,
  checked_at: '2026-09-18T10:15:00.000Z',
  total: 4,
  limit: 20,
  offset: 0,
  units: [{ unit_id: 'u1', name: 'Shop One' }, { unit_id: 'u2', name: 'Shop Two' }],
  requests: [
    { id: 'r1', unit_id: 'u1', unit_name: 'Shop One', created_at: '2026-09-18 09:00:00', invoice_number: 'INV-1', amount_fiat: 10, currency: 'EUR',
      customer_status: 'waiting', paid_at: null, tx_hash: null, customer_name: null, investor: legNA },
    { id: 'r2', unit_id: 'u1', unit_name: 'Shop One', created_at: '2026-09-17 09:00:00', invoice_number: 'INV-2', amount_fiat: 20, currency: 'EUR',
      customer_status: 'paid', paid_at: '2026-09-17 10:00:00', tx_hash: 'a'.repeat(64), customer_name: 'Buyer',
      investor: { invoice: { state: 'marked_paid', marked_paid_at: '2026-09-17 12:00:00' }, reward: null, checked_at: '2026-09-18T10:15:00.000Z' } },
    { id: 'r3', unit_id: 'u2', unit_name: 'Shop Two', created_at: '2026-09-16 09:00:00', invoice_number: 'INV-3', amount_fiat: 30, currency: 'EUR',
      customer_status: 'paid', paid_at: '2026-09-16 10:00:00', tx_hash: null, customer_name: null,
      investor: { invoice: { state: 'unknown', marked_paid_at: null }, reward: null, checked_at: null } },
    { id: 'r4', unit_id: 'u2', unit_name: 'Shop Two', created_at: '2026-09-15 09:00:00', invoice_number: 'INV-4', amount_fiat: 40, currency: 'EUR',
      customer_status: 'paid', paid_at: '2026-09-15 10:00:00', tx_hash: null, customer_name: null,
      investor: { invoice: { state: 'waiting', marked_paid_at: null },
        reward: { state: 'marked_paid', marked_paid_at: '2026-09-16 08:00:00', amount_fiat: 1.5, currency: 'EUR' }, checked_at: '2026-09-18T10:15:00.000Z' } },
  ],
};

const respond = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const renderPage = () => render(<MemoryRouter><OnlinePayments /></MemoryRouter>);

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OnlinePayments page', () => {
  it('signs the request and sends no hex', async () => {
    const fetchSpy = respond(200, BODY);
    vi.stubGlobal('fetch', fetchSpy);
    renderPage();
    await screen.findByText('Invoice #INV-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/^\/api\/payment-requests\/overview\?/);
    expect(String(url)).not.toContain('hex');
    expect(init.headers.Authorization).toMatch(/^Nostr /);
  });

  it('green only for "marked paid"; unknown is grey with a "?"', async () => {
    vi.stubGlobal('fetch', respond(200, BODY));
    renderPage();
    const marked = await screen.findAllByText(/^The investor marked it paid on /);
    for (const el of marked) expect(el.closest('span.rounded-full')!.className).toContain('emerald');

    const unknown = screen.getByText('Status could not be checked');
    const pill = unknown.closest('span.rounded-full')!;
    expect(pill.className).not.toContain('emerald');
    expect(pill.className).toContain('bg-muted');
    expect(pill.querySelector('svg')).not.toBeNull(); // the "?" icon
  });

  it('before the customer pays, the investor line is a muted dash, not a badge', async () => {
    vi.stubGlobal('fetch', respond(200, BODY));
    renderPage();
    const na = await screen.findByText('Not yet — the customer has not paid');
    expect(na.closest('span.rounded-full')).toBeNull();
  });

  it('a bank reward gets its own line with its amount', async () => {
    vi.stubGlobal('fetch', respond(200, BODY));
    renderPage();
    await screen.findByText('Reward (€1.50):');
    expect(screen.getByText('Invoice:')).toBeTruthy();
    expect(screen.getByText('The investor has not paid yet')).toBeTruthy();
  });

  it('says that "marked paid" is not a bank confirmation', async () => {
    vi.stubGlobal('fetch', respond(200, BODY));
    renderPage();
    expect(await screen.findByText(/It is not a bank confirmation/)).toBeTruthy();
  });

  it('offers "All units" when there is more than one unit', async () => {
    vi.stubGlobal('fetch', respond(200, BODY));
    renderPage();
    expect(await screen.findByRole('option', { name: 'All units' })).toBeTruthy();
  });

  for (const [reason, expected] of [
    ['STALE', /clock is more than a minute off/],
    ['BAD_TIME', /clock is more than a minute off/],
    ['BAD_SIG', /Log out and sign in again/],
    ['MISSING', /Log out and sign in again/],
  ] as const) {
    it(`a 401 ${reason} is explained, never with "refresh"`, async () => {
      vi.stubGlobal('fetch', respond(401, { success: false, error: 'SIGNATURE_REQUIRED', reason }));
      renderPage();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(expected);
      expect(alert.textContent!.toLowerCase()).not.toContain('refresh');
    });
  }

  it('any other failure says the list could not be loaded', async () => {
    vi.stubGlobal('fetch', respond(500, { success: false }));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/));
  });
});
