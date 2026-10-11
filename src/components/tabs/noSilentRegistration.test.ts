/**
 * A card is registered only where its holder is also named.
 *
 * Until 11 Oct 2026 the LANA tab and the remote-pay page registered every new,
 * empty card they were shown — with no name and no profile — and then failed
 * on the balance, because an empty card cannot pay in LANA. The card then
 * counted as registered, so the cash tab skipped its name step and the sale was
 * recorded under a bare hex (Živa center, 8 Oct 2026: first scan "refused",
 * second scan went through with no name asked).
 *
 * Registration belongs to the screens that ask for the name in the same step.
 * This pins the list, so a new silent caller has to be added here on purpose.
 */
import { test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

// Every one of these asks for the customer's name before it registers.
const ALLOWED = new Set([
  'components/tabs/CashTab.tsx',
  'components/tabs/RegisterCustomerTab.tsx',
  'components/tabs/RegisterTab.tsx',
]);

test('only name-asking screens call /api/register/wallet', () => {
  const callers = walk(SRC)
    .filter((p) => readFileSync(p, 'utf-8').includes('/api/register/wallet'))
    .map((p) => p.slice(SRC.length + 1).split('\\').join('/'));
  expect(callers.filter((c) => !ALLOWED.has(c))).toEqual([]);
});

test('the LANA tab and the remote-pay page say a new card cannot pay, instead of registering it', () => {
  expect(readFileSync(join(SRC, 'components/tabs/LanaTab.tsx'), 'utf-8')).toContain("t('lana.newCardNoLana')");
  expect(readFileSync(join(SRC, 'pages/PublicPay.tsx'), 'utf-8')).toContain("t('pay.newCardNoLana')");
});
