// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveOrder, bindingString, toCents, centsToString, orderIdMatchesPubkey, type ResolverInput } from './orderResolver';

const BUYER = 'a'.repeat(24) + 'b'.repeat(40);
const D = BUYER.slice(0, 24) + '.' + 'c'.repeat(32);
const OWNER = 'd'.repeat(64);
const STAFF = 'e'.repeat(64);
const BRAIN = 'f'.repeat(64);
const UNIT = '1'.repeat(32);

function base(over: Partial<ResolverInput> = {}): ResolverInput {
  return {
    order: {
      d: D, pubkey: BUYER, createdAt: 1000, unitId: UNIT, status: 'placed', fulfillment: 'shipping',
      items: [{ a: `36502:${OWNER}:lst1`, qty: 2, unitPrice: '5.00', currency: 'EUR' }],
      total: '12.50', currency: 'EUR', payBy: 1000 + 1800,
    },
    purchases: [],
    fulfillment: null,
    unit: { ownerHex: OWNER, staffHexes: [STAFF], currency: 'EUR', shippingFee: '2.50', freeShippingFrom: null },
    listingPrice: '5.00',
    listingCreatedAt: 900,
    trustedSigners: new Set([BRAIN]),
    now: 1500,
    ...over,
  };
}

function purchase(over: Partial<ResolverInput['purchases'][number]> = {}) {
  return {
    pubkey: BRAIN, eventId: 'ev1', createdAt: 1200, txId: 'tx1', unitId: UNIT, invoiceNumber: D,
    receiptDescription: `Jabolka ×2 · ${bindingString(BUYER, D)}`,
    amount: '12.50', currency: 'EUR', lanaAmount: '9765432100', paymentType: 'lana', status: 'processing',
    customerHex: '9'.repeat(64), txHash: 'h'.repeat(64),
    ...over,
  };
}

describe('helpers', () => {
  it('cents round-trip', () => {
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('12.5')).toBe(1250);
    expect(toCents('12')).toBe(1200);
    expect(toCents('abc')).toBeNull();
    expect(toCents('1.234')).toBeNull();
    expect(centsToString(1250)).toBe('12.50');
    expect(centsToString(5)).toBe('0.05');
  });
  it('order id prefix rule', () => {
    expect(orderIdMatchesPubkey(D, BUYER)).toBe(true);
    expect(orderIdMatchesPubkey(D, 'x'.repeat(64))).toBe(false);
    expect(orderIdMatchesPubkey('not-an-id', BUYER)).toBe(false);
  });
});

describe('resolveOrder — payment states', () => {
  it('unpaid before pay_by', () => {
    const r = resolveOrder(base());
    expect(r.paymentState).toBe('unpaid');
    expect(r.expected).toBe('12.50');
    expect(r.pending).toBe(false);
  });
  it('expired after pay_by with no purchase', () => {
    expect(resolveOrder(base({ now: 5000 })).paymentState).toBe('expired');
  });
  it('cancelled when order says so and nothing paid', () => {
    const i = base(); i.order.status = 'cancelled';
    expect(resolveOrder(i).paymentState).toBe('cancelled');
  });
  it('paid on exact trusted match', () => {
    const r = resolveOrder(base({ purchases: [purchase()] }));
    expect(r.paymentState).toBe('paid');
    expect(r.paidBy?.txId).toBe('tx1');
    expect(r.pending).toBe(true);
    expect(r.effectiveStatus).toBe('paid');
  });
  it('paid even if order status was later republished cancelled (money wins)', () => {
    const i = base({ purchases: [purchase()] }); i.order.status = 'cancelled';
    expect(resolveOrder(i).paymentState).toBe('paid');
  });
  it('pickup: no shipping fee expected', () => {
    const i = base({ purchases: [purchase({ amount: '10.00' })] });
    i.order.fulfillment = 'pickup'; i.order.total = '10.00';
    const r = resolveOrder(i);
    expect(r.expected).toBe('10.00');
    expect(r.paymentState).toBe('paid');
  });
  it('free shipping threshold reached', () => {
    const i = base({ purchases: [purchase({ amount: '10.00' })] });
    i.unit.freeShippingFrom = '10.00';
    expect(resolveOrder(i).paymentState).toBe('paid');
  });
});

describe('resolveOrder — the money is recomputed from the merchant-signed listing', () => {
  it('amount_mismatch when 30933 amount is 1 cent short', () => {
    const r = resolveOrder(base({ purchases: [purchase({ amount: '12.49' })] }));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
    expect(r.paidBy).not.toBeNull();
  });
  it('buyer-stated cheap total is ignored: expected comes from listing price', () => {
    const i = base({ purchases: [purchase({ amount: '0.01' })] });
    i.order.items[0].unitPrice = '0.00'; i.order.total = '0.01';
    const r = resolveOrder(i);
    expect(r.expected).toBe('12.50');
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('currency mismatch → amount_mismatch', () => {
    expect(resolveOrder(base({ purchases: [purchase({ currency: 'GBP' })] })).paymentState).toBe('amount_mismatch');
  });
  it('overpayment is also a mismatch (equality, not ≥)', () => {
    expect(resolveOrder(base({ purchases: [purchase({ amount: '20.00' })] })).paymentState).toBe('amount_mismatch');
  });
  it('priceChanged flag when listing republished after order', () => {
    expect(resolveOrder(base({ listingCreatedAt: 2000 })).priceChanged).toBe(true);
  });
  it('falls back to order unit_price when listing unknown', () => {
    const r = resolveOrder(base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase()] }));
    expect(r.paymentState).toBe('paid');
    expect(r.priceChanged).toBe(false);
  });
});

describe('resolveOrder — identity & binding rules (squatting defences)', () => {
  it('untrusted author is ignored', () => {
    expect(resolveOrder(base({ purchases: [purchase({ pubkey: 'x'.repeat(64) })] })).paymentState).toBe('unpaid');
  });
  it('cancelled / failed 30933 do not count', () => {
    expect(resolveOrder(base({ purchases: [purchase({ status: 'cancelled' })] })).paymentState).toBe('unpaid');
    expect(resolveOrder(base({ purchases: [purchase({ status: 'failed' })] })).paymentState).toBe('unpaid');
  });
  it('cash purchases never pay a shop order', () => {
    expect(resolveOrder(base({ purchases: [purchase({ paymentType: 'cash' })] })).paymentState).toBe('unpaid');
  });
  it('different unit / invoice is ignored', () => {
    expect(resolveOrder(base({ purchases: [purchase({ unitId: '2'.repeat(32) })] })).paymentState).toBe('unpaid');
    expect(resolveOrder(base({ purchases: [purchase({ invoiceNumber: 'other' })] })).paymentState).toBe('unpaid');
  });
  it('missing receipt_description binding is ignored (squatted session)', () => {
    expect(resolveOrder(base({ purchases: [purchase({ receiptDescription: 'Jabolka ×2' })] })).paymentState).toBe('unpaid');
  });
  it('order signed by a key whose prefix does not match d is never paid', () => {
    const i = base({ purchases: [purchase()] });
    i.order.pubkey = 'z'.repeat(64);
    expect(resolveOrder(i).paymentState).toBe('unpaid');
  });
  it('newest qualifying 30933 wins', () => {
    const r = resolveOrder(base({ purchases: [purchase({ eventId: 'old', createdAt: 1100, amount: '12.49' }), purchase({ eventId: 'new', createdAt: 1300 })] }));
    expect(r.paymentState).toBe('paid');
    expect(r.paidBy?.eventId).toBe('new');
  });
});

describe('resolveOrder — fulfillment & pending', () => {
  it('owner-signed shipped clears pending', () => {
    const r = resolveOrder(base({ purchases: [purchase()], fulfillment: { pubkey: OWNER, createdAt: 1400, status: 'shipped' } }));
    expect(r.effectiveStatus).toBe('shipped');
    expect(r.pending).toBe(false);
  });
  it('staff-signed fulfillment is accepted', () => {
    const r = resolveOrder(base({ purchases: [purchase()], fulfillment: { pubkey: STAFF, createdAt: 1400, status: 'delivered' } }));
    expect(r.effectiveStatus).toBe('delivered');
  });
  it('fulfillment signed by a stranger is ignored (still pending)', () => {
    const r = resolveOrder(base({ purchases: [purchase()], fulfillment: { pubkey: 'q'.repeat(64), createdAt: 1400, status: 'shipped' } }));
    expect(r.effectiveStatus).toBe('paid');
    expect(r.pending).toBe(true);
  });
  it('non-terminal fulfillment keeps pending', () => {
    const r = resolveOrder(base({ purchases: [purchase()], fulfillment: { pubkey: OWNER, createdAt: 1400, status: 'packed' } }));
    expect(r.pending).toBe(true);
  });
  it('unpaid order is never pending even with a fulfillment event', () => {
    const r = resolveOrder(base({ fulfillment: { pubkey: OWNER, createdAt: 1400, status: 'shipped' } }));
    expect(r.pending).toBe(false);
  });
});

describe('resolveOrder — several items of one shop (SPEC v1.1.0)', () => {
  const A1 = `36502:${OWNER}:lst1`;
  const A2 = `36502:${OWNER}:lst2`;
  /** 3 × 4.50 + 2 × 3.98 + 5.00 shipping = 26.46 */
  function twoItems(over: Partial<ResolverInput> = {}): ResolverInput {
    const i = base({ listingPrice: null, listingCreatedAt: null, ...over });
    i.unit.shippingFee = '5.00';
    i.order.items = [
      { a: A1, qty: 3, unitPrice: '4.50', currency: 'EUR', listingPrice: '4.50', listingCreatedAt: 900 },
      { a: A2, qty: 2, unitPrice: '3.98', currency: 'EUR', listingPrice: '3.98', listingCreatedAt: 950 },
    ];
    i.order.total = '26.46';
    return i;
  }
  it('each item is priced by its own listing: paid exactly → paid', () => {
    const r = resolveOrder(twoItems({ purchases: [purchase({ amount: '26.46' })] }));
    expect(r.expected).toBe('26.46');
    expect(r.paymentState).toBe('paid');
    expect(r.priceChanged).toBe(false);
  });
  it('paid as if every item cost item 1 (4.50 × 5 + 5.00) → amount_mismatch', () => {
    const r = resolveOrder(twoItems({ purchases: [purchase({ amount: '27.50' })] }));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
  });
  it('a top-level v1.0 listingPrice is never applied to the items of a multi-item order', () => {
    const i = twoItems({ listingPrice: '4.50', purchases: [purchase({ amount: '26.46' })] });
    expect(resolveOrder(i).paymentState).toBe('paid');
    // …even when the items carry no listing price at all (listing unknown → signed unit_price)
    for (const it of i.order.items) { delete it.listingPrice; delete it.listingCreatedAt; }
    expect(resolveOrder(i).expected).toBe('26.46');
  });
  it('the buyer cannot lower one line: expected uses that line\'s listing price', () => {
    const i = twoItems({ purchases: [purchase({ amount: '22.48' })] });
    i.order.items[1].unitPrice = '1.99'; i.order.total = '22.48';
    const r = resolveOrder(i);
    expect(r.expected).toBe('26.46');
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('shipping is computed once, from the subtotal of ALL lines', () => {
    const i = twoItems({ purchases: [purchase({ amount: '21.46' })] });
    i.unit.freeShippingFrom = '20.00'; // each line alone is under 20, together 21.46
    i.order.total = '21.46';
    const r = resolveOrder(i);
    expect(r.expected).toBe('21.46');
    expect(r.paymentState).toBe('paid');
  });
  it('priceChanged when ANY item\'s listing was republished after the order', () => {
    const i = twoItems();
    i.order.items[1].listingCreatedAt = 2000;
    expect(resolveOrder(i).priceChanged).toBe(true);
  });
  it('one item with its own listingPrice wins over the v1.0 top-level price', () => {
    const i = base({ listingPrice: '9.99', purchases: [purchase()] });
    i.order.items[0].listingPrice = '5.00';
    expect(resolveOrder(i).paymentState).toBe('paid');
  });
});
