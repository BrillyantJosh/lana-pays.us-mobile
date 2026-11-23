// @vitest-environment node
/**
 * LANA neposredno: the money rules and the exact bytes (lib/directLanaCore.ts).
 *
 *  - the margin reads and rounds exactly as Točka obilja and letsbalance.world:
 *    the shared vectors are a byte-identical copy (sha256 pinned);
 *  - invoice + margin → total → lanoshi at the KIND 38888 price, integers only,
 *    rounded down to the lanoshi (Brilly's worked examples);
 *  - the network fee, the dust rule, the 20-coin limit;
 *  - the till's copy of the file is the server's, byte for byte;
 *  - the public description and the KIND 9350 template, exactly;
 *  - a plan whose numbers do not follow from each other is refused.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  marginPercent, withMargin, parseCents, centsText, lanoshiForCents, lanaText, feeFor, amounts, isAddress,
  addressScript, addressOfPublicKey, cardHexOf, checkPlan, saleDescription, recordTemplate, rawTime, clip,
  invoiceNumberOf, validRate, DirectLanaError, MAX_INPUTS,
} from './directLanaCore.js';
import { unitMarginPercent } from './unitFlags.js';
import { keyOf, pubOf, addressOfKey, hexOfKey, coinsOf, makePlan, previousTx } from '../fixtures/directLana.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsFile = path.resolve(here, 'points-margin.vectors.json');
const vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DirectLanaError ? e.code : `not a DirectLanaError: ${String(e)}`;
  }
  return 'no error';
};

const OWNER = keyOf(7);
const SHOP_WALLET = addressOfKey(OWNER);
const OWNER_HEX = hexOfKey(OWNER);
const CARD = keyOf(1);

describe('the shared margin vectors', () => {
  it('are a byte-identical copy of letsbalance-world apps/universal/tests/points-margin.vectors.json', () => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(vectorsFile)).digest('hex');
    expect(hash).toBe('222cd156d8b9cd64fab4f88e701a6553ae2d90dc4daf00d4f89e8edb9083ce36');
    expect(vectors.maxPercent).toBe(20);
  });

  it('marginPercent reads every tag text as Točka obilja does', () => {
    for (const [raw, want] of vectors.marginPercent) expect(marginPercent(raw), JSON.stringify(raw)).toBe(want);
  });

  it('the till reads a unit\'s margin_percent tag the same way (lib/unitFlags.ts)', () => {
    for (const [raw, want] of vectors.marginPercent) {
      const tags = raw === null ? [['d', 'u']] : [['d', 'u'], ['margin_percent', raw]];
      expect(unitMarginPercent(JSON.stringify({ tags })), JSON.stringify(raw)).toBe(want);
    }
    expect(unitMarginPercent(JSON.stringify({ tags: [['margin_percent', '10'], ['margin_percent', '10']] })), 'two tags').toBe(null);
  });

  it('withMargin: whole cents, half a cent up, for every unit-price vector', () => {
    for (const v of vectors.unitPrice) expect(withMargin(BigInt(v.cents), v.margin), v.why).toBe(BigInt(v.pay));
  });
});

describe('invoice + margin = total, in LANA at the price (rounded down to the lanoshi)', () => {
  // Brilly's examples at 0.256 € per LANA (understand2 synthesis §3).
  const cases: Array<[string, number, string, bigint, string]> = [
    ['10.00', 0, '10.00', 3_906_250_000n, '39.0625'],
    ['10.00', 10, '11.00', 4_296_875_000n, '42.96875'],
    ['10.00', 20, '12.00', 4_687_500_000n, '46.875'],
    ['7.99', 20, '9.59', 3_746_093_750n, '37.4609375'],
    ['1.25', 10, '1.38', 539_062_500n, '5.390625'],
    ['23.45', 7, '25.09', 9_800_781_250n, '98.0078125'],
    ['0.01', 20, '0.01', 3_906_250n, '0.0390625'],
  ];
  for (const [invoice, m, total, lanoshi, lana] of cases) {
    it(`${invoice} + ${m} % = ${total} = ${lana} LANA`, () => {
      const pay = withMargin(parseCents(invoice), m);
      expect(centsText(pay)).toBe(total);
      expect(lanoshiForCents(pay, '0.256')).toBe(lanoshi);
      expect(lanaText(lanoshi)).toBe(lana);
    });
  }

  it('matches letsbalance-world lana-transfer.test.mjs: 1.00 EUR at 0.128 = 781,250,000 lanoshi', () => {
    expect(lanoshiForCents(100n, '0.128')).toBe(781_250_000n);
    expect(lanoshiForCents(100n, '0.256')).toBe(390_625_000n);
  });

  it('rounds down: never a lanoshi more than the price says', () => {
    // 1 cent at 0.3: 3,333,333.33… lanoshi → 3,333,333.
    expect(lanoshiForCents(1n, '0.3')).toBe(3_333_333n);
  });

  it('reads amounts strictly: a comma or a point, at most two decimals', () => {
    expect(parseCents('10')).toBe(1000n);
    expect(parseCents('10,5')).toBe(1050n);
    expect(parseCents(' 10.50 ')).toBe(1050n);
    for (const bad of ['', '-1', '1e3', '10.505', '1.2.3', 'abc', '10.', '.5']) expect(code(() => parseCents(bad)), bad).toBe('AMOUNT_INVALID');
  });

  it('a price must be a written decimal above zero', () => {
    for (const ok of ['0.256', '1', '0.000000000000000001']) expect(validRate(ok), ok).toBe(true);
    for (const bad of ['0', '0.000', '-0.2', '1e-3', '', '0.256 ', null, 0.256]) expect(validRate(bad as any), String(bad)).toBe(false);
    expect(code(() => lanoshiForCents(100n, '0'))).toBe('RATE_UNAVAILABLE');
  });

  it('a margin outside 0..20 whole percent is refused', () => {
    for (const bad of [-1, 21, 2.5, NaN]) expect(code(() => withMargin(100n, bad)), String(bad)).toBe('MARGIN_INVALID');
  });
});

describe('the network fee, paid by the customer on top', () => {
  it('is (181 · inputs + 34 · 2 + 14) · 150 lanoshi', () => {
    expect(feeFor(1, 2)).toBe(39_450n);
    expect(feeFor(2, 2)).toBe(66_600n);
    expect(feeFor(20, 2)).toBe(555_300n);
  });

  it('change of 1000 lanoshi or less goes to the fee, so the fee is always inputs minus outputs', () => {
    const fee = feeFor(1, 2);
    const a = amounts([10_000n + fee + 1000n], 10_000n);
    expect(a).toEqual({ amount: 10_000n, fee: fee + 1000n, change: 0n });
    const b = amounts([10_000n + fee + 1001n], 10_000n);
    expect(b).toEqual({ amount: 10_000n, fee, change: 1001n });
  });

  it('refuses an amount of 1000 lanoshi or less, too little money, and more than 20 coins', () => {
    expect(code(() => amounts([1_000_000n], 1000n))).toBe('AMOUNT_TOO_SMALL');
    expect(code(() => amounts([50_000n], 20_000n))).toBe('INSUFFICIENT_FUNDS');
    expect(code(() => amounts(Array(MAX_INPUTS + 1).fill(1_000_000n), 2000n))).toBe('INPUT_LIMIT');
    expect(code(() => amounts([], 2000n))).toBe('INPUT_LIMIT');
  });
});

describe('addresses', () => {
  it('a mainnet address is Base58Check with version 0x30, never just the prefix', () => {
    expect(isAddress(SHOP_WALLET)).toBe(true);
    const flipped = SHOP_WALLET.slice(0, -1) + (SHOP_WALLET.endsWith('a') ? 'b' : 'a');
    expect(isAddress(flipped)).toBe(false);
    expect(code(() => addressScript(flipped))).toBe('ADDRESS_INVALID');
    // A Bitcoin address (version 0x00) has a valid checksum but is not LANA.
    expect(isAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe(false);
  });

  it('a compressed and an uncompressed key are two addresses; the card hex is the same x for both', () => {
    expect(addressOfKey(CARD, true)).not.toBe(addressOfKey(CARD, false));
    expect(cardHexOf(pubOf(CARD, true))).toBe(cardHexOf(pubOf(CARD, false)));
    expect(code(() => addressOfPublicKey('02' + '00'.repeat(32)))).toBe('CARD_KEY_INVALID');
  });
});

describe('the till and the server price one sale one way', () => {
  it('src/lib/directLanaCore.ts is byte for byte server/lib/directLanaCore.ts', () => {
    const server = fs.readFileSync(path.resolve(here, 'directLanaCore.ts'));
    const till = fs.readFileSync(path.resolve(here, '../../src/lib/directLanaCore.ts'));
    expect(crypto.createHash('sha256').update(till).digest('hex')).toBe(crypto.createHash('sha256').update(server).digest('hex'));
  });
});

describe('the public description and the KIND 9350 template', () => {
  const plan = makePlan({ card: CARD, recipient: SHOP_WALLET, recipientHex: OWNER_HEX, unitId: 'u-42', unitName: 'Kmetija Novak' });

  it('one item per line, as Brilly listed them; no invoice line without a number', () => {
    expect(saleDescription(plan)).toBe([
      'LanaPays.Us direct sale',
      'Unit: Kmetija Novak (u-42)',
      'Invoice amount: 10.00 EUR',
      'Margin: 10% (+1.00 EUR)',
      'Total: 11.00 EUR',
      `Price: 1 LANA = 0.256 EUR (KIND 38888 ${'e'.repeat(64)})`,
    ].join('\n'));
    expect(saleDescription({ ...plan, invoice_number: 'R-17' }).split('\n').pop()).toBe('Invoice no.: R-17');
    expect(saleDescription({ ...plan, margin_percent: 0, pay_cents: plan.invoice_cents })).toContain('Margin: 0% (+0.00 EUR)');
  });

  it('four tags in order, the content keys in order, created_at = the payment\'s time stamp', () => {
    const txid = 'a'.repeat(64);
    const r = recordTemplate(plan, txid);
    expect(r.kind).toBe(9350);
    expect(r.created_at).toBe(plan.created_at);
    expect(r.tags).toEqual([['p', OWNER_HEX], ['txid', txid], ['network', 'lanacoin:mainnet'], ['v', '1']]);
    const body = JSON.parse(r.content);
    expect(Object.keys(body)).toEqual(['v', 'network', 'txid', 'sender', 'recipient', 'amount_lanoshi', 'fee_lanoshi', 'description', 'created_at']);
    expect(body.sender).toEqual({ hex: plan.card_hex, wallet: plan.sender });
    expect(body.recipient).toEqual({ hex: OWNER_HEX, wallet: SHOP_WALLET, name: 'Kmetija Novak' });
    expect(body.amount_lanoshi).toBe('4296875000');
    expect(body.fee_lanoshi).toBe('39450');
    expect(body.description).toBe(saleDescription(plan));
    expect(body.created_at).toBe(plan.created_at);
    // Never a seller's note, a customer's name or an npub.
    expect(r.content).not.toMatch(/npub1/);
  });

  it('a long shop name is clipped to 200 characters, never in the middle of a character', () => {
    const name = clip('🍎'.repeat(150), 200);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).toBe('🍎'.repeat(100));
    expect(clip('a\nb\tc', 200)).toBe('a b c');
  });

  it('an invoice number is at most 64 characters, without control characters', () => {
    expect(invoiceNumberOf(undefined)).toBe('');
    expect(invoiceNumberOf('  R-1  ')).toBe('R-1');
    expect(code(() => invoiceNumberOf('x'.repeat(65)))).toBe('INVOICE_NUMBER_INVALID');
    expect(code(() => invoiceNumberOf('a\nb'))).toBe('INVOICE_NUMBER_INVALID');
    expect(code(() => invoiceNumberOf(42))).toBe('INVOICE_NUMBER_INVALID');
  });
});

describe('a plan whose numbers do not follow from each other is refused', () => {
  const base = () => makePlan({ card: CARD, recipient: SHOP_WALLET, recipientHex: OWNER_HEX });

  it('a whole plan passes, and says what it pays', () => {
    const p = base();
    const c = checkPlan(p);
    expect(c.amount.toString()).toBe(p.amount);
    expect(c.fee + c.amount + c.change).toBe(BigInt(p.inputs[0].value));
  });

  it('any changed number, extra key or wrong coin is refused', () => {
    const p = base();
    expect(code(() => checkPlan({ ...p, amount: String(BigInt(p.amount) + 1n) }))).toBe('PLAN_AMOUNTS_CHANGED');
    expect(code(() => checkPlan({ ...p, fee: '1' }))).toBe('PLAN_AMOUNTS_CHANGED');
    expect(code(() => checkPlan({ ...p, pay_cents: '1200' }))).toBe('PLAN_AMOUNTS_CHANGED');
    expect(code(() => checkPlan({ ...p, rate: '0.3' }))).toBe('PLAN_AMOUNTS_CHANGED');
    expect(code(() => checkPlan({ ...p, extra: 1 } as any))).toBe('PLAN_INVALID');
    expect(code(() => checkPlan({ ...p, recipient: p.sender }))).toBe('PLAN_INVALID');
    expect(code(() => checkPlan({ ...p, expires: p.created_at + 500 }))).toBe('PLAN_INVALID');
    expect(code(() => checkPlan({ ...p, card_hex: 'f'.repeat(64) }))).toBe('PLAN_INVALID');
    expect(code(() => checkPlan({ ...p, inputs: [{ ...p.inputs[0], value: String(BigInt(p.inputs[0].value) + 1n) }] }))).toBe('PLAN_INPUT_MISMATCH');
  });

  it('never a coin of the uncompressed sibling address: every coin must pay the card\'s own address', () => {
    const sibling = addressOfKey(CARD, false);
    const coins = coinsOf(sibling, [10_000_000_000n]);
    expect(code(() => checkPlan({ ...base(), inputs: coins }))).toBe('PLAN_INPUT_MISMATCH');
  });

  it('a coin stamped later than the payment is refused (the network would refuse it)', () => {
    const p = base();
    const late = previousTx(p.sender, [BigInt(p.inputs[0].value)], p.created_at + 60, 9);
    expect(rawTime(late.raw)).toBe(p.created_at + 60);
    const coin = { ...p.inputs[0], txid: late.txid, raw: late.raw };
    expect(code(() => checkPlan({ ...p, inputs: [coin] }))).toBe('PLAN_INPUT_MISMATCH');
  });

  it('a previous transaction that does not hash to its txid is refused', () => {
    const p = base();
    expect(code(() => checkPlan({ ...p, inputs: [{ ...p.inputs[0], txid: 'b'.repeat(64) }] }))).toBe('PLAN_INPUT_MISMATCH');
  });
});
