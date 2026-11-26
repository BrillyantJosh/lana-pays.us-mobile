/**
 * Lana-online, when the server refuses to make a link because the shop has no
 * bank account (UNIT_NO_PAYOUT_ACCOUNT, 23 Nov 2026): the seller does not read
 * the raw answer. Since 26 Nov 2026 such a shop's online payment request is a
 * LANA neposredno link, so the same press makes that link instead
 * (LanaOnlineTab.direct.e2e.test.tsx runs it against the real routes), and
 * "no bank account" is never shown. Every other refusal reads as before.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import i18n from '@/i18n';
import LanaOnlineTab from './LanaOnlineTab';
import { directReasonKey } from '@/lib/directLanaApi';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR' } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const WORDS = 'This shop has no bank account, so it cannot be paid with LANA this way. Cash works as usual.';
let createAnswer: { status: number; body: any };
/** What POST /api/direct-lana/links answers (the LANA neposredno link made instead). */
let linkAnswer: { status: number; body: any };
let linkCalls: any[] = [];

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  linkCalls = [];
  linkAnswer = { status: 409, body: { success: false, code: 'WALLET_INVALID', error: 'This shop has no valid wallet for LANA. Fix it on shop.lanapays.us.' } };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/payment-requests') && init?.method === 'POST') return json(createAnswer.status, createAnswer.body);
    if (url.startsWith('/api/payment-requests')) return json(200, { success: true, requests: [] });
    if (url === '/api/direct-lana/links' && init?.method === 'POST') {
      linkCalls.push(JSON.parse(init.body));
      return json(linkAnswer.status, linkAnswer.body);
    }
    if (url.startsWith('/api/direct-lana/links')) return json(200, { success: true, links: [] });
    return json(404, {});
  }) as any);
});

async function createLink() {
  render(<MemoryRouter><LanaOnlineTab unitCurrency="EUR" unitId={UNIT} merchantHex={'aa'.repeat(32)} /></MemoryRouter>);
  fireEvent.click(screen.getByText(i18n.t('cash.skipNoReceipt')));
  fireEvent.change(await screen.findByPlaceholderText(i18n.t('cash.invoicePlaceholder')), { target: { value: 'R-17' } });
  fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')), { target: { value: '12,50' } });
  fireEvent.click(screen.getByText(i18n.t('lanaOnline.createRequest')));
}

describe('making a link', () => {
  it('refused for a shop without a bank account: the same press asks for a LANA neposredno link, never "no bank account"', async () => {
    createAnswer = { status: 409, body: { success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT', error: WORDS, message: WORDS } };
    await createLink();
    // The shop lacks a wallet for LANA neposredno: the link's own words (there is no switch since 26 Nov 2026).
    const { key, sentence } = directReasonKey('WALLET_INVALID');
    expect(await screen.findByText(sentence ? i18n.t(key) : i18n.t('directLana.linkRefused', { reason: i18n.t(key) }))).toBeInTheDocument();
    expect(linkCalls).toEqual([{ unit_id: UNIT, amount: '12.50', currency: 'EUR', invoice_number: 'R-17' }]);
    expect(screen.queryByText(i18n.t('purchase.unitNoPayoutAccount'))).not.toBeInTheDocument();
    expect(screen.queryByText(WORDS)).not.toBeInTheDocument();
  });

  it('— and when the shop has what it needs, the link is made', async () => {
    createAnswer = { status: 409, body: { success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT', error: WORDS, message: WORDS } };
    const token = 'A'.repeat(32);
    linkAnswer = {
      status: 201,
      body: {
        success: true,
        link: {
          id: `dll_${'0'.repeat(32)}`, token, path: `/pay-direct/${token}`, sale_id: `dls_${'0'.repeat(32)}`, unit_id: UNIT,
          unit_name: 'Kmetija Novak', currency: 'EUR', invoice_cents: '1250', margin_percent: 0, pay_cents: '1250',
          invoice_number: 'R-17', note: null, status: 'open', created_at: 1795674872, expires_at: 1796279672, payment: null,
        },
      },
    };
    await createLink();
    expect((await screen.findByTestId('online-direct-url')).textContent).toBe(`${window.location.origin}/pay-direct/${token}`);
    expect(screen.queryByText(WORDS)).not.toBeInTheDocument();
  });

  it('every other refusal reads as before', async () => {
    createAnswer = { status: 400, body: { success: false, error: 'INVALID_CURRENCY' } };
    await createLink();
    expect(await screen.findByText('INVALID_CURRENCY')).toBeInTheDocument();
  });
});
