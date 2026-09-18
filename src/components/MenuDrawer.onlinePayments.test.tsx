/**
 * The way in to "Online payments" is the right-side menu. Pinned: the entry is
 * there, and it opens /lana-online/payments (and closes the drawer).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.hoisted(() => {
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
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { nostrHexId: 'ab'.repeat(32), privateKeyHex: '01'.repeat(32) }, logout: () => {} }),
}));

import i18n from '@/i18n';
import MenuDrawer from './MenuDrawer';

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('menu → Online payments', () => {
  it('opens /lana-online/payments and closes the drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ isAdmin: false }), { status: 200 })));
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><MenuDrawer open onClose={onClose} /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Online payments' }));
    expect(screen.getByTestId('where').textContent).toBe('/lana-online/payments');
    expect(onClose).toHaveBeenCalled();
  });
});
