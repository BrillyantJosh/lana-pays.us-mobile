/**
 * The gate is on the SESSION, not on the login form.
 *
 * This app grows a session in four different ways and only ONE of them is the
 * login form. A new commission decision reaches, by definition, people who are
 * already signed in — so what is pinned here is that a restored session, a
 * Chrome-discarded tab and a session pushed in by a second tab are each shut
 * out, and that the app itself never renders behind the screen.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

// Any 64-hex string; every check in this file is against a stubbed fetch.
const PERSON = 'ab'.repeat(32);
const SESSION_KEY = 'lana_pays_session';

const aSession = (hex = PERSON) => ({
  walletId: 'LZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
  nostrHexId: hex,
  nostrNpubId: 'npub1zzz',
  privateKeyHex: '00'.repeat(32),
  currency: 'EUR',
  expiresAt: Date.now() + 60 * 60 * 1000,
});

const EXCLUDED_BODY = {
  excluded: true,
  ground: 'the stated ground',
  since: 1700000000,
  untilSplit: null,
  eventId: 'ev1',
};

/** See src/lib/exclusion.test.ts — this runner has no real Storage. */
const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
};

const answering = (body: any) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as any);

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as any).wasDiscarded;
});

/** Imported lazily so the storage stub is in place before i18n initialises. */
const loadProvider = async () => (await import('./AuthContext')).AuthProvider;

const theTill = () => screen.queryByText('THE TILL');
const theClosedDoor = () => screen.queryByText(/Your access is paused/i);

describe('a session restored from localStorage', () => {
  it('is shut out, and the app never renders behind the screen', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', answering(EXCLUDED_BODY));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theClosedDoor()).not.toBeNull());
    expect(theTill(), 'the till rendered behind the closed door').toBeNull();
  });

  it('has its session ENDED, not merely covered over', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', answering(EXCLUDED_BODY));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theClosedDoor()).not.toBeNull());
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('shows the commission\'s own words and the date it took effect', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', answering(EXCLUDED_BODY));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(screen.queryByText('the stated ground')).not.toBeNull());
    expect(screen.queryAllByText(/lana\.discount/i).length, 'the way to sell what you hold must stay named').toBeGreaterThan(0);
  });

  it('lets a person with no decision against them straight through', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', answering({ excluded: false, ground: null, since: null, untilSplit: null, eventId: null }));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theTill()).not.toBeNull());
    expect(theClosedDoor()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY), 'an innocent session was thrown away').not.toBeNull();
  });

  it('does not lock out a whole till when the check cannot get through', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theTill()).not.toBeNull());
    expect(theClosedDoor()).toBeNull();
  });

  it('but a KNOWN decision still stands when the check cannot get through', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    localStorage.setItem(`lana_excluded_${PERSON}`, JSON.stringify(EXCLUDED_BODY));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theClosedDoor()).not.toBeNull());
    expect(theTill()).toBeNull();
  });
});

describe('the other silent ways a session appears', () => {
  it('Chrome\'s discarded-tab recovery is gated too', async () => {
    (document as any).wasDiscarded = true;
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', answering(EXCLUDED_BODY));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);

    await waitFor(() => expect(theClosedDoor()).not.toBeNull());
    expect(theTill()).toBeNull();
  });

  it('a second tab cannot re-seed a session we just closed', async () => {
    vi.stubGlobal('fetch', answering(EXCLUDED_BODY));
    const AuthProvider = await loadProvider();

    render(<AuthProvider><div>THE TILL</div></AuthProvider>);
    await waitFor(() => expect(theTill()).not.toBeNull());   // nobody signed in yet

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: SESSION_KEY,
        newValue: JSON.stringify(aSession()),
      }));
    });

    await waitFor(() => expect(theClosedDoor()).not.toBeNull());
    expect(theTill()).toBeNull();
  });
});

describe('the first frame', () => {
  /**
   * `excluded` used to start null and be corrected by the mount effect, which
   * React runs AFTER it has painted. A restored session therefore saw the whole
   * till — balances, buttons, the customer's name — for a frame before the door
   * shut. Reading the remembered verdict in the useState initialiser makes the
   * very first render the closed one.
   *
   * These use the SERVER renderer on purpose. `render()` from testing-library
   * wraps in act() and flushes effects before it returns, so it cannot tell a
   * door that was closed on the first render apart from one closed on the
   * second — which is the whole difference being pinned here. renderToStaticMarkup
   * runs the render phase and NOTHING else: exactly what the browser paints first.
   */
  const firstPaint = async (): Promise<string> => {
    const AuthProvider = await loadProvider();
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderToStaticMarkup(<AuthProvider><div>THE TILL</div></AuthProvider>);
  };

  it('a remembered decision closes the door on the FIRST render, before any effect runs', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    localStorage.setItem(`lana_excluded_${PERSON}`, JSON.stringify(EXCLUDED_BODY));
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const html = await firstPaint();

    expect(html.includes('THE TILL'), 'the till was painted for a frame before the door shut').toBe(false);
    expect(html).toContain('Your access is paused');
  });

  it('a remembered decision for somebody ELSE does not close this person\'s door', async () => {
    const other = 'cd'.repeat(32);
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    localStorage.setItem(`lana_excluded_${other}`, JSON.stringify(EXCLUDED_BODY));
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const html = await firstPaint();

    expect(html.includes('Your access is paused'), 'somebody else\'s decision was applied').toBe(false);
    expect(html).toContain('THE TILL');
  });

  it('an EXPIRED stored session is nobody — the door is not pre-closed on a stale hex', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...aSession(), expiresAt: Date.now() - 1000 }));
    localStorage.setItem(`lana_excluded_${PERSON}`, JSON.stringify(EXCLUDED_BODY));
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const html = await firstPaint();

    expect(html.includes('Your access is paused')).toBe(false);
    expect(html).toContain('THE TILL');
  });

  it('a corrupt stored session paints the app rather than throwing before the first frame', async () => {
    localStorage.setItem(SESSION_KEY, '{not json');
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    await expect(firstPaint()).resolves.toContain('THE TILL');
  });

  it('nothing remembered still paints the app — an outage must not lock out a whole till', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(aSession()));
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    await expect(firstPaint()).resolves.toContain('THE TILL');
  });
});
