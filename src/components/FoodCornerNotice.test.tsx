/**
 * The Točka obilja notice on the till's home screen (Kati / Brilly, The Rose,
 * 24. 11. 2026): the supplier sees how many orders are still to bring and a
 * button to the supplier page on mejmosefajn.org — in every one of the 12
 * languages, with nothing about the buyer and no amount.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import i18n from '@/i18n';
import en from '@/i18n/locales/en.json';
import sl from '@/i18n/locales/sl.json';
import hu from '@/i18n/locales/hu.json';
import it_ from '@/i18n/locales/it.json';
import es from '@/i18n/locales/es.json';
import pl from '@/i18n/locales/pl.json';
import pt from '@/i18n/locales/pt.json';
import de from '@/i18n/locales/de.json';
import hr from '@/i18n/locales/hr.json';
import sr from '@/i18n/locales/sr.json';
import ru from '@/i18n/locales/ru.json';
import zh from '@/i18n/locales/zh.json';
import { FoodCornerNotice, FOOD_CORNER_SUPPLIER_URL, type FoodCornerOpen } from './FoodCornerNotice';

const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
const KEYS = ['home.foodCornerTitle', 'home.foodCornerOpen'];
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

const one: FoodCornerOpen = {
  count: 3,
  units: [{ unit_id: 'u1', name: 'Kmetija Lipa', count: 3 }],
  next_delivery: '2026-11-26',
  link: FOOD_CORNER_SUPPLIER_URL,
};

describe('Točka obilja notice — i18n', () => {
  it('lists exactly 12 locales', () => expect(Object.keys(LOCALES)).toHaveLength(12));
  for (const [lang, dict] of Object.entries(LOCALES)) {
    it(`${lang} has every key, non-empty, with the same placeholders as en`, () => {
      for (const k of KEYS) {
        expect(typeof dict[k] === 'string' && dict[k].trim() !== '', `${lang}:${k}`).toBe(true);
        expect(placeholders(dict[k]), `${lang}:${k}`).toEqual(placeholders((en as Record<string, string>)[k]));
      }
    });
  }
});

describe('Točka obilja notice — what it shows', () => {
  it('shows nothing when there is nothing to bring, or when the count is not known', () => {
    const { container, rerender } = render(<FoodCornerNotice data={{ ...one, count: 0, units: [] }} />);
    expect(container.innerHTML).toBe('');
    rerender(<FoodCornerNotice data={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('says how many orders and opens the supplier page in a new tab — no day, no buyer, no amount', async () => {
    await i18n.changeLanguage('sl');
    render(<FoodCornerNotice data={one} />);
    const link = screen.getByTestId('food-corner-notice');
    expect(link.textContent).toContain('Naročila na Točki obilja: 3');
    expect(link.textContent).not.toMatch(/26|Dostavi/);
    expect(link.textContent).toContain('MejmoSeFajn.org');
    expect(link.getAttribute('href')).toBe('https://mejmosefajn.org/food-corner/supplier');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('names each shop only when the owner has orders in more than one', async () => {
    await i18n.changeLanguage('en');
    const { rerender } = render(<FoodCornerNotice data={one} />);
    expect(screen.getByTestId('food-corner-notice').textContent).not.toContain('Kmetija Lipa');
    rerender(<FoodCornerNotice data={{
      ...one, count: 5, units: [{ unit_id: 'u1', name: 'Kmetija Lipa', count: 3 }, { unit_id: 'u2', name: 'Sirarna', count: 2 }],
    }} />);
    const text = screen.getByTestId('food-corner-notice').textContent || '';
    expect(text).toContain('Točka obilja orders: 5');
    expect(text).toContain('Kmetija Lipa: 3 · Sirarna: 2');
  });

  it('never opens a link the server sent if it is not the supplier page', () => {
    render(<FoodCornerNotice data={{ ...one, link: 'https://evil.example/' }} />);
    expect(screen.getByTestId('food-corner-notice').getAttribute('href')).toBe(FOOD_CORNER_SUPPLIER_URL);
  });
});
