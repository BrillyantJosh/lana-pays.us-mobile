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
  it('listing unknown: never priced by the buyer\'s unit_price — not paid (fail-closed, SPEC v1.1.1)', () => {
    const r = resolveOrder(base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase()] }));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
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
    // …even when the items carry no listing price at all: listing unknown → not computable, not paid
    for (const it of i.order.items) { delete it.listingPrice; delete it.listingCreatedAt; }
    expect(resolveOrder(i).expected).toBe('');
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
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

describe('resolveOrder — a settled order stays paid (SPEC §8 step 5a)', () => {
  const A1 = `36502:${OWNER}:lst1`;
  const A2 = `36502:${OWNER}:lst2`;
  /** Paid 26.46 = 3 × 4.50 + 2 × 3.98 + 5.00; the next day line 2's listing is republished at 4.20. */
  function repricedCart(over: Partial<ResolverInput> = {}): ResolverInput {
    const i = base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase({ amount: '26.46' })], ...over });
    i.unit.shippingFee = '5.00';
    i.order.items = [
      { a: A1, qty: 3, unitPrice: '4.50', currency: 'EUR', listingPrice: '4.50', listingCreatedAt: 900 },
      { a: A2, qty: 2, unitPrice: '3.98', currency: 'EUR', listingPrice: '4.20', listingCreatedAt: 90000 },
    ];
    i.order.total = '26.46';
    return i;
  }
  it('without a stored verdict a later price change turns it into amount_mismatch (the old behaviour)', () => {
    const r = resolveOrder(repricedCart());
    expect(r.expected).toBe('26.90');
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
  });
  it('the same 30933 that settled this order event keeps it paid and pending, at the amount paid', () => {
    const r = resolveOrder(repricedCart({ settledPurchaseEventId: 'ev1' }));
    expect(r.paymentState).toBe('paid');
    expect(r.pending).toBe(true);
    expect(r.expected).toBe('26.46');
    expect(r.priceChanged).toBe(true);
    expect(r.paidBy?.eventId).toBe('ev1');
  });
  it('a later shipping-fee change does not revoke it either', () => {
    const i = base({ purchases: [purchase()], settledPurchaseEventId: 'ev1' });
    i.unit.shippingFee = '4.90';
    expect(resolveOrder(i).paymentState).toBe('paid');
    i.settledPurchaseEventId = null;
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
  });
  it('a different 30933 is judged afresh', () => {
    const r = resolveOrder(repricedCart({ settledPurchaseEventId: 'some-other-event' }));
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('a cancelled 30933 still un-pays the order', () => {
    const r = resolveOrder(repricedCart({ settledPurchaseEventId: 'ev1', purchases: [purchase({ amount: '26.46', status: 'cancelled' })] }));
    expect(r.paymentState).toBe('unpaid');
    expect(r.paidBy).toBeNull();
  });
  it('never makes an order paid that has no qualifying 30933', () => {
    expect(resolveOrder(base({ settledPurchaseEventId: 'ev1' })).paymentState).toBe('unpaid');
    expect(resolveOrder(base({ settledPurchaseEventId: 'ev1', purchases: [purchase({ pubkey: 'x'.repeat(64) })] })).paymentState).toBe('unpaid');
  });
  it('a 30933 in another currency than the order is not kept', () => {
    const r = resolveOrder(repricedCart({ settledPurchaseEventId: 'ev1', purchases: [purchase({ amount: '26.46', currency: 'GBP' })] }));
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('fulfillment still ends pending on a settled order', () => {
    const r = resolveOrder(repricedCart({ settledPurchaseEventId: 'ev1', fulfillment: { pubkey: OWNER, createdAt: 99999, status: 'shipped' } }));
    expect(r.paymentState).toBe('paid');
    expect(r.effectiveStatus).toBe('shipped');
    expect(r.pending).toBe(false);
  });
});

/**
 * Review of 2 Oct 2026. The buyer's ephemeral key lives in the buyer's
 * browser, so the buyer can sign a REPLACEMENT 36520 with the same d at any
 * time and publish it straight to the relays — every number in it is the
 * buyer's. Only the merchant-signed listing and the brain-signed 30933 count.
 */
describe('resolveOrder — fail-closed money rules (review 2 Oct 2026)', () => {
  const APPLES = `36502:${OWNER}:apples`;
  const PEARS = `36502:${OWNER}:pears`;
  /** E1 as placed and paid: 2 × apples at 5.00 + 2.50 shipping = 12.50. */
  function paidApples(over: Partial<ResolverInput> = {}): ResolverInput {
    const i = base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase()], ...over });
    i.order.items = [{ a: APPLES, qty: 2, unitPrice: '5.00', currency: 'EUR', listingPrice: '5.00', listingCreatedAt: 900 }];
    return i;
  }
  /** E2, the buyer's replacement with the same d: 10 × pears "at 1.00" + 2.50 = 12.50 (pears really cost 50.00). */
  function buyerReplacement(pearsListing: string | null, over: Partial<ResolverInput> = {}): ResolverInput {
    const i = paidApples(over);
    i.order.createdAt = 1005;
    i.order.items = [{ a: PEARS, qty: 10, unitPrice: '1.00', currency: 'EUR', listingPrice: pearsListing, listingCreatedAt: pearsListing ? 900 : null }];
    return i;
  }

  it('an item whose listing is unknown is never priced by the buyer: the order is not paid', () => {
    const r = resolveOrder(buyerReplacement(null));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
    expect(r.expected).toBe('');
    // …and a 0.00 line is not "free" either
    const zero = paidApples({ purchases: [purchase({ amount: '2.50' })] });
    zero.order.items[0] = { ...zero.order.items[0], unitPrice: '0.00', listingPrice: null, listingCreatedAt: null };
    expect(resolveOrder(zero).paymentState).toBe('amount_mismatch');
  });

  it('one unknown line makes the whole cart uncomputable', () => {
    const i = paidApples({ purchases: [purchase({ amount: '12.50' })] });
    i.order.items.push({ a: PEARS, qty: 10, unitPrice: '0.00', currency: 'EUR', listingPrice: null, listingCreatedAt: null });
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
  });

  it('the v1.0 one-item shape with no listing price at all is not paid either', () => {
    expect(resolveOrder(base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase()] })).paymentState).toBe('amount_mismatch');
    const noPair = base({ purchases: [purchase()] });
    delete noPair.listingPrice; delete noPair.listingCreatedAt;
    expect(resolveOrder(noPair).paymentState).toBe('amount_mismatch');
  });

  it('it heals by itself: once the listing is known, the same inputs are judged on the real price', () => {
    expect(resolveOrder(buyerReplacement('50.00')).paymentState).toBe('amount_mismatch');
    expect(resolveOrder(buyerReplacement('50.00')).expected).toBe('502.50');
    expect(resolveOrder(paidApples()).paymentState).toBe('paid');
  });

  it('the step-5a pin does not outlive the shop: an unknown unit is never paid, pinned or not', () => {
    const gone = { ownerHex: '', staffHexes: [], currency: '', shippingFee: '0.00', freeShippingFrom: null };
    const r = resolveOrder(paidApples({ settledPurchaseEventId: 'ev1', unit: gone }));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
    // the same with the 30933 and the order both claiming no currency
    const i = paidApples({ settledPurchaseEventId: 'ev1', unit: gone, purchases: [purchase({ currency: '' })] });
    i.order.currency = '';
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
    // …and without a pin: step 5 does not pay an unknown shop either (2 × 5.00, no fee known)
    expect(resolveOrder({ ...i, settledPurchaseEventId: null, purchases: [purchase({ currency: '', amount: '10.00' })] }).paymentState).toBe('amount_mismatch');
  });

  it('a pin needs an order that still names its items and a currency', () => {
    const noItems = paidApples({ settledPurchaseEventId: 'ev1' });
    noItems.order.items = [];
    expect(resolveOrder(noItems).paymentState).toBe('amount_mismatch');
    const noCurrency = paidApples({ settledPurchaseEventId: 'ev1', purchases: [purchase({ currency: '' })] });
    noCurrency.order.currency = '';
    expect(resolveOrder(noCurrency).paymentState).toBe('amount_mismatch');
  });

  it('a pin survives a listing that is gone later — the verdict was reached with every listing known', () => {
    const i = paidApples({ settledPurchaseEventId: 'ev1' });
    i.order.items[0] = { ...i.order.items[0], listingPrice: null, listingCreatedAt: null };
    const r = resolveOrder(i);
    expect(r.paymentState).toBe('paid');
    expect(r.expected).toBe('12.50');
  });

  it('NIP-33: only the newest version of a 30933 counts — a later cancellation un-pays the order', () => {
    const processing = purchase({ eventId: 'v1', createdAt: 1200 });
    // the brain's cancel republish (same signer, same d = tx id) carries no receipt_description
    const cancelled = purchase({ eventId: 'v2', createdAt: 1300, status: 'cancelled', receiptDescription: '' });
    for (const purchases of [[processing, cancelled], [cancelled, processing]]) {
      const r = resolveOrder(paidApples({ purchases }));
      expect(r.paymentState).toBe('unpaid');
      expect(r.paidBy).toBeNull();
      expect(r.pending).toBe(false);
    }
    // …also against a pin on the old version
    expect(resolveOrder(paidApples({ purchases: [processing, cancelled], settledPurchaseEventId: 'v1' })).paymentState).toBe('unpaid');
    // …and after pay_by it is expired, not paid
    expect(resolveOrder(paidApples({ purchases: [processing, cancelled], now: 5000 })).paymentState).toBe('expired');
  });

  it('versions are per (signer, tx id): another tx id, or a stranger\'s copy, cancels nothing', () => {
    const paying = purchase({ eventId: 'v1', createdAt: 1200 });
    const otherTx = purchase({ eventId: 'o1', txId: 'tx2', createdAt: 1300, status: 'cancelled' });
    const stranger = purchase({ eventId: 's1', pubkey: 'x'.repeat(64), createdAt: 1400, status: 'cancelled' });
    const r = resolveOrder(paidApples({ purchases: [paying, otherTx, stranger] }));
    expect(r.paymentState).toBe('paid');
    expect(r.paidBy?.eventId).toBe('v1');
  });

  it('two versions in the same second: the lowest event id is the one kept (NIP-01)', () => {
    const a = purchase({ eventId: 'a-cancel', createdAt: 1300, status: 'cancelled' });
    const b = purchase({ eventId: 'b-paid', createdAt: 1300 });
    expect(resolveOrder(paidApples({ purchases: [b, a] })).paymentState).toBe('unpaid');
    expect(resolveOrder(paidApples({ purchases: [a, b] })).paymentState).toBe('unpaid');
  });

  it('only status processing or settled is paid (SPEC §7)', () => {
    for (const status of ['processing', 'settled']) {
      expect(resolveOrder(paidApples({ purchases: [purchase({ status })] })).paymentState, status).toBe('paid');
    }
    for (const status of ['', 'refunded', 'pending', 'created', 'partial', 'Processing', 'cancelled', 'failed']) {
      const r = resolveOrder(paidApples({ purchases: [purchase({ status })] }));
      expect(r.paymentState, status).toBe('unpaid');
      expect(r.pending, status).toBe(false);
    }
  });

  it('the live order of 2 Oct 2026 keeps its verdict: 1 × 4.08, pickup, listing 4.08 republished later, 30933 processing', () => {
    const i = base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase({ amount: '4.08' })] });
    i.order.fulfillment = 'pickup'; i.order.total = '4.08';
    i.order.items = [{ a: APPLES, qty: 1, unitPrice: '4.08', currency: 'EUR', listingPrice: '4.08', listingCreatedAt: 99999 }];
    for (const settledPurchaseEventId of [null, 'ev1']) {
      const r = resolveOrder({ ...i, settledPurchaseEventId, fulfillment: { pubkey: OWNER, createdAt: 2000, status: 'rejected' } });
      expect(r).toMatchObject({ paymentState: 'paid', expected: '4.08', priceChanged: true, effectiveStatus: 'rejected', pending: false });
    }
  });
});
