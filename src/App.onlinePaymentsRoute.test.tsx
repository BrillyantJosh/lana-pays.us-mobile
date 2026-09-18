/**
 * /lana-online/payments is a route of the app, behind sign-in. Pinned: a
 * signed-in session at that path gets the Online payments page; no session
 * gets sent to /login instead of the page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ session: null as null | Record<string, string> }));

vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ session: auth.session, isLoading: false }),
}));
// Every page is a stub: this file is about the route table, not the pages.
vi.mock('./pages/OnlinePayments', () => ({ default: () => <div>ONLINE-PAYMENTS-PAGE</div> }));
vi.mock('./pages/Index', () => ({ default: () => <div>INDEX-PAGE</div> }));
vi.mock('./pages/Login', () => ({ default: () => <div>LOGIN-PAGE</div> }));
vi.mock('./pages/Admin', () => ({ default: () => <div>ADMIN-PAGE</div> }));
vi.mock('./pages/PublicPay', () => ({ default: () => <div>PUBLIC-PAY-PAGE</div> }));
vi.mock('./pages/LanaOnlineHistory', () => ({ default: () => <div>HISTORY-PAGE</div> }));
vi.mock('./pages/OrdersHistory', () => ({ default: () => <div>ORDERS-PAGE</div> }));
vi.mock('./pages/NotFound', () => ({ default: () => <div>NOT-FOUND-PAGE</div> }));

import App from './App';

afterEach(() => { auth.session = null; window.history.pushState({}, '', '/'); });

describe('the /lana-online/payments route', () => {
  it('a signed-in merchant gets the Online payments page', async () => {
    auth.session = { nostrHexId: 'ab'.repeat(32) };
    window.history.pushState({}, '', '/lana-online/payments');
    render(<App />);
    expect(await screen.findByText('ONLINE-PAYMENTS-PAGE')).toBeTruthy();
    expect(screen.queryByText('NOT-FOUND-PAGE')).toBeNull();
  });

  it('without a session it goes to sign-in, not to the page', async () => {
    window.history.pushState({}, '', '/lana-online/payments');
    render(<App />);
    expect(await screen.findByText('LOGIN-PAGE')).toBeTruthy();
    expect(screen.queryByText('ONLINE-PAYMENTS-PAGE')).toBeNull();
  });
});
