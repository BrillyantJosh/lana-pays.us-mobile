/**
 * The "Online payments" page as a merchant sees it, against a stubbed server.
 *
 * Pinned: the request is signed and carries no hex; "marked paid" is green and
 * says MARKED; a status the server could not check is grey with a "?" and never
 * green; a customer who has not paid yet leaves the investor line as a dash;
 * the bank reward is its own line; and a refused signature is explained by its
 * cause (the device clock, or a fresh sign-in) — never "refresh".
 *
 * And: a cancelled or expired request says nothing about the customer on the
 * investor line; a payment in flight, a watchdog-reset request and the dedup
 * self-heal each have their own non-green state; staff see no investor line
 * and one note; a brain that answered nothing is ONE note, not a "?" per row;
 * "checked at" is the oldest real brain read, and absent when there was none;
 * SQLite UTC times are shown in local time; a new unit or page never shows the
 * previous selection's rows; a slow older answer never overwrites a newer
 * one; paging and a unit change send the right offset.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { KEY } = vi.hoisted(() => {
  // Dates are asserted in Slovenian local time (UTC+2 in September).
  process.env.TZ = 'Europe/Ljubljana';
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
  investor_available: true,
  investor_owner_only: false,
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
    expect(screen.getByText('The investor has not marked it paid yet')).toBeTruthy();
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

// ── helpers for the multi-request tests ────────────────────────────────

const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

const row = (over: Record<string, unknown>) => ({
  id: 'x', unit_id: 'u1', unit_name: 'Shop One', created_at: '2026-09-18 09:00:00', invoice_number: 'INV-X', amount_fiat: 10, currency: 'EUR',
  customer_status: 'waiting', paid_at: null, tx_hash: null, customer_name: null, investor: legNA, ...over,
});

const body = (requests: unknown[], over: Record<string, unknown> = {}) => ({ ...BODY, total: requests.length, requests, ...over });

const queryOf = (call: unknown[]) => new URL(String(call[0]), 'http://x').searchParams;

describe('what each state says', () => {
  it('a cancelled or expired request says nothing about the customer on the investor line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([
      row({ id: 'w', invoice_number: 'W' }),
      row({ id: 'c', invoice_number: 'C', customer_status: 'cancelled' }),
      row({ id: 'e', invoice_number: 'E', customer_status: 'expired' }),
    ]))));
    renderPage();
    await screen.findByText('Invoice #C');
    // Only the open request says the customer has not paid yet.
    expect(screen.getAllByText('Not yet — the customer has not paid')).toHaveLength(1);
    expect(screen.getAllByTestId('investor-dash')).toHaveLength(2);
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
  });

  it('in flight, watchdog-reset and dedup self-heal each have their own state — none green, none "waiting"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([
      row({ id: 'p', invoice_number: 'P', customer_status: 'processing' }),
      row({ id: 'u', invoice_number: 'U', customer_status: 'unverified', investor: { invoice: { state: 'unknown', marked_paid_at: null }, reward: null, checked_at: null } }),
      row({ id: 'd', invoice_number: 'D', customer_status: 'paid_unconfirmed', paid_at: '2026-09-18 09:30:00', investor: { invoice: { state: 'unknown', marked_paid_at: null }, reward: null, checked_at: null } }),
    ]))));
    renderPage();
    const inFlight = await screen.findByText('Payment in progress');
    expect(inFlight.closest('span.rounded-full')!.className).toContain('amber');
    const lost = screen.getByText('Payment could not be verified').closest('span.rounded-full')!;
    expect(lost.className).toContain('bg-muted');
    expect(lost.querySelector('svg')).not.toBeNull();
    const dedup = screen.getByText('Paid (not confirmed by the system)').closest('span.rounded-full')!;
    expect(dedup.className).not.toContain('emerald');
    expect(dedup.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText('Waiting for payment')).toBeNull();
    expect(screen.queryByText('Not yet — the customer has not paid')).toBeNull();
  });

  it('staff: no investor line on their rows, and one note that it is the owner\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([
      row({ id: 's1', invoice_number: 'S1', customer_status: 'paid', paid_at: '2026-09-18 09:30:00', investor: null }),
      row({ id: 's2', invoice_number: 'S2', investor: null }),
    ], { investor_owner_only: true }))));
    renderPage();
    await screen.findByText('Invoice #S1');
    expect(screen.queryByText('Investor:')).toBeNull();
    expect(screen.getAllByText("Only the unit's owner can see the investor status.")).toHaveLength(1);
    expect(screen.queryByText(/Investor status checked/)).toBeNull();
  });

  it('a brain that answered nothing is one note — not a "?" on every paid row', async () => {
    const unknownLeg = { invoice: { state: 'unknown', marked_paid_at: null }, reward: null, checked_at: null };
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([
      row({ id: 'q1', invoice_number: 'Q1', customer_status: 'paid', paid_at: '2026-09-18 09:30:00', investor: unknownLeg }),
      row({ id: 'q2', invoice_number: 'Q2', customer_status: 'paid', paid_at: '2026-09-18 09:40:00', investor: unknownLeg }),
    ], { investor_available: false }))));
    renderPage();
    await screen.findByText('Invoice #Q1');
    expect(screen.getAllByText('Investor status cannot be checked at the moment.')).toHaveLength(1);
    expect(screen.queryByText('Status could not be checked')).toBeNull();
    expect(screen.queryByText(/Investor status checked/)).toBeNull();
  });
});

describe('times', () => {
  it('"checked at" is the OLDEST real brain read on screen, in local time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([
      row({ id: 'n', invoice_number: 'N', customer_status: 'paid', paid_at: '2026-09-18 09:30:00',
        investor: { invoice: { state: 'marked_paid', marked_paid_at: '2026-09-18 08:00:00' }, reward: null, checked_at: '2026-09-18T08:15:00.000Z' } }),
      row({ id: 'o', invoice_number: 'O', customer_status: 'paid', paid_at: '2026-09-18 09:30:00',
        investor: { invoice: { state: 'waiting', marked_paid_at: null }, reward: null, checked_at: '2026-09-18T08:05:00.000Z' } }),
    ]))));
    renderPage();
    expect(await screen.findByText('Investor status checked at 10:05')).toBeTruthy();
  });

  it('no investor status read → no "checked at" at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([row({ id: 'w', invoice_number: 'W' })]))));
    renderPage();
    await screen.findByText('Invoice #W');
    expect(screen.queryByText(/Investor status checked/)).toBeNull();
  });

  it('a SQLite UTC time is shown in local time (UTC+2 in Ljubljana in September)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json200(body([row({ id: 't', invoice_number: 'T', created_at: '2026-09-18 09:00:00' })]))));
    renderPage();
    await screen.findByText('Invoice #T');
    const line = screen.getByText(/18\/09\/2026, \d\d:\d\d$/);
    expect(line.textContent).toContain('18/09/2026, 11:00');
    expect(line.textContent).not.toContain('09:00');
  });
});

describe('changing the selection', () => {
  const TWO_UNITS = BODY.units;
  const u1Rows = [row({ id: 'a', invoice_number: 'U1-PAID', customer_status: 'paid', paid_at: '2026-09-18 09:30:00',
    investor: { invoice: { state: 'marked_paid', marked_paid_at: '2026-09-18 08:00:00' }, reward: null, checked_at: '2026-09-18T08:15:00.000Z' } })];
  const u2Rows = [row({ id: 'b', unit_id: 'u2', unit_name: 'Shop Two', invoice_number: 'U2-ONLY' })];

  it('while another unit loads, the previous unit\'s rows are not shown under its filter', async () => {
    const second = deferred();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json200(body(u1Rows, { units: TWO_UNITS })))
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = renderPage();
    await screen.findByText('Invoice #U1-PAID');

    fireEvent.change(container.querySelector('select')!, { target: { value: 'u2' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Invoice #U1-PAID')).toBeNull();
    expect(screen.queryByText(/The investor marked it paid/)).toBeNull();
    expect(container.querySelector('select')).not.toBeNull(); // the selector stays

    second.resolve(json200(body(u2Rows, { units: TWO_UNITS })));
    expect(await screen.findByText('Invoice #U2-ONLY')).toBeTruthy();
  });

  it('a slow older answer never overwrites a newer one', async () => {
    const toU1 = deferred();
    const toU2 = deferred();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json200(body(u1Rows, { units: TWO_UNITS })))
      .mockReturnValueOnce(toU1.promise)
      .mockReturnValueOnce(toU2.promise);
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = renderPage();
    await screen.findByText('Invoice #U1-PAID');
    const select = container.querySelector('select')!;

    fireEvent.change(select, { target: { value: 'u1' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fireEvent.change(select, { target: { value: 'u2' } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));

    toU2.resolve(json200(body(u2Rows, { units: TWO_UNITS })));
    await screen.findByText('Invoice #U2-ONLY');
    toU1.resolve(json200(body(u1Rows, { units: TWO_UNITS })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Invoice #U2-ONLY')).toBeTruthy();
    expect(screen.queryByText('Invoice #U1-PAID')).toBeNull();
  });

  it('paging sends the next offset, and "next" is disabled on the last page', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const off = Number(new URL(url, 'http://x').searchParams.get('offset'));
      return json200(body([row({ id: `p${off}`, invoice_number: `PAGE-${off}` })], { total: 45 }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderPage();
    await screen.findByText('Invoice #PAGE-0');
    expect(screen.getByText('1 / 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByText('Invoice #PAGE-20');
    expect(queryOf(fetchSpy.mock.calls[1]).get('offset')).toBe('20');

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByText('Invoice #PAGE-40');
    expect(queryOf(fetchSpy.mock.calls[2]).get('offset')).toBe('40');
    expect(screen.getByText('3 / 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Previous/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('changing the unit starts again at the first page', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      const off = Number(q.get('offset'));
      return json200(body([row({ id: `${q.get('unit_id') || 'all'}${off}`, invoice_number: `${q.get('unit_id') || 'ALL'}-${off}` })], { total: 45 }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = renderPage();
    await screen.findByText('Invoice #ALL-0');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByText('Invoice #ALL-20');

    fireEvent.change(container.querySelector('select')!, { target: { value: 'u2' } });
    await screen.findByText('Invoice #u2-0');
    const last = queryOf(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]);
    expect(last.get('unit_id')).toBe('u2');
    expect(last.get('offset')).toBe('0');
    expect(within(container).getByText('1 / 3')).toBeTruthy();
  });
});
