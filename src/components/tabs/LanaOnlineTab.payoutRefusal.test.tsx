/**
 * Lana-online, when the server refuses to make a link because the shop has no
 * bank account (UNIT_NO_PAYOUT_ACCOUNT, 23 Nov 2026): the seller reads why, in
 * their language, not the raw answer. Every other refusal reads as before.
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

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR' } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const WORDS = 'This shop has no bank account, so it cannot be paid with LANA this way. Cash works as usual.';
let createAnswer: { status: number; body: any };

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/payment-requests') && init?.method === 'POST') return json(createAnswer.status, createAnswer.body);
    if (url.startsWith('/api/payment-requests')) return json(200, { success: true, requests: [] });
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
  it('refused for a shop without a bank account: the reason in words', async () => {
    createAnswer = { status: 409, body: { success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT', error: WORDS, message: WORDS } };
    await createLink();
    expect(await screen.findByText(i18n.t('purchase.unitNoPayoutAccount'))).toBeInTheDocument();
  });

  it('every other refusal reads as before', async () => {
    createAnswer = { status: 400, body: { success: false, error: 'INVALID_CURRENCY' } };
    await createLink();
    expect(await screen.findByText('INVALID_CURRENCY')).toBeInTheDocument();
  });
});
