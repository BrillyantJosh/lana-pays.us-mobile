// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  resolveOrder, bindingString, toCents, centsToString, orderIdMatchesPubkey, usableListingPrice, purchaseVersionWins, latestPurchaseVersions,
  type ResolverInput,
} from './orderResolver';

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
    unit: { ownerHex: OWNER, staffHexes: [STAFF], currency: 'EUR', shippingFee: '2.50', freeShippingFrom: null, pickup: true },
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
    i.unit.freeShippingFrom = '10.00'; i.order.total = '10.00';
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
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' } }));
    expect(r.paymentState).toBe('paid');
    expect(r.pending).toBe(true);
    expect(r.expected).toBe('26.46');
    expect(r.priceChanged).toBe(true);
    expect(r.paidBy?.eventId).toBe('ev1');
  });
  it('a later shipping-fee change does not revoke it either', () => {
    const i = base({ purchases: [purchase()], settledPurchase: { txId: 'tx1', amount: '12.50' } });
    i.unit.shippingFee = '4.90';
    expect(resolveOrder(i).paymentState).toBe('paid');
    i.settledPurchase = null;
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
  });
  it('a different 30933 is judged afresh', () => {
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'some-other-tx', amount: '26.46' } }));
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('the same tx with another amount is judged afresh', () => {
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.45' } }));
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('the brain re-signs the same purchase (a publish retry): the newer copy keeps the order settled', () => {
    // event ev1 settled it; the outbox retry signed ev2 — same tx, same amount, 60 s later
    const resigned = purchase({ eventId: 'ev2', createdAt: 1260, amount: '26.46' });
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, purchases: [resigned] }));
    expect(r.paymentState).toBe('paid');
    expect(r.pending).toBe(true);
    expect(r.paidBy?.eventId).toBe('ev2');
    // …and both copies held side by side change nothing
    const both = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, purchases: [purchase({ amount: '26.46' }), resigned] }));
    expect(both.paymentState).toBe('paid');
    // …but a newer cancelled copy still un-pays it
    const cancelled = purchase({ eventId: 'ev3', createdAt: 1300, amount: '26.46', status: 'cancelled', receiptDescription: '' });
    expect(resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, purchases: [resigned, cancelled] })).paymentState).toBe('unpaid');
  });
  it('a cancelled 30933 still un-pays the order', () => {
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, purchases: [purchase({ amount: '26.46', status: 'cancelled' })] }));
    expect(r.paymentState).toBe('unpaid');
    expect(r.paidBy).toBeNull();
  });
  it('never makes an order paid that has no qualifying 30933', () => {
    expect(resolveOrder(base({ settledPurchase: { txId: 'tx1', amount: '12.50' } })).paymentState).toBe('unpaid');
    expect(resolveOrder(base({ settledPurchase: { txId: 'tx1', amount: '12.50' }, purchases: [purchase({ pubkey: 'x'.repeat(64) })] })).paymentState).toBe('unpaid');
  });
  it('a 30933 in another currency than the order is not kept', () => {
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, purchases: [purchase({ amount: '26.46', currency: 'GBP' })] }));
    expect(r.paymentState).toBe('amount_mismatch');
  });
  it('fulfillment still ends pending on a settled order', () => {
    const r = resolveOrder(repricedCart({ settledPurchase: { txId: 'tx1', amount: '26.46' }, fulfillment: { pubkey: OWNER, createdAt: 99999, status: 'shipped' } }));
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
    const gone = { ownerHex: '', staffHexes: [], currency: '', shippingFee: '0.00', freeShippingFrom: null, pickup: false };
    const r = resolveOrder(paidApples({ settledPurchase: { txId: 'tx1', amount: '12.50' }, unit: gone }));
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
    // the same with the 30933 and the order both claiming no currency
    const i = paidApples({ settledPurchase: { txId: 'tx1', amount: '12.50' }, unit: gone, purchases: [purchase({ currency: '' })] });
    i.order.currency = '';
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
    // …and without a pin: step 5 does not pay an unknown shop either (2 × 5.00, no fee known)
    expect(resolveOrder({ ...i, settledPurchase: null, purchases: [purchase({ currency: '', amount: '10.00' })] }).paymentState).toBe('amount_mismatch');
  });

  it('a pin needs an order that still names its items and a currency', () => {
    const noItems = paidApples({ settledPurchase: { txId: 'tx1', amount: '12.50' } });
    noItems.order.items = [];
    expect(resolveOrder(noItems).paymentState).toBe('amount_mismatch');
    const noCurrency = paidApples({ settledPurchase: { txId: 'tx1', amount: '12.50' }, purchases: [purchase({ currency: '' })] });
    noCurrency.order.currency = '';
    expect(resolveOrder(noCurrency).paymentState).toBe('amount_mismatch');
  });

  it('a pin survives a listing that is gone later — the verdict was reached with every listing known', () => {
    const i = paidApples({ settledPurchase: { txId: 'tx1', amount: '12.50' } });
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
    expect(resolveOrder(paidApples({ purchases: [processing, cancelled], settledPurchase: { txId: 'tx1', amount: '12.50' } })).paymentState).toBe('unpaid');
    // …and after pay_by it is expired, not paid
    expect(resolveOrder(paidApples({ purchases: [processing, cancelled], now: 5000 })).paymentState).toBe('expired');
  });

  it('versions are per tx id: another tx id, or a stranger\'s copy, cancels nothing', () => {
    const paying = purchase({ eventId: 'v1', createdAt: 1200 });
    const otherTx = purchase({ eventId: 'o1', txId: 'tx2', createdAt: 1300, status: 'cancelled' });
    const stranger = purchase({ eventId: 's1', pubkey: 'x'.repeat(64), createdAt: 1400, status: 'cancelled' });
    const r = resolveOrder(paidApples({ purchases: [paying, otherTx, stranger] }));
    expect(r.paymentState).toBe('paid');
    expect(r.paidBy?.eventId).toBe('v1');
  });

  it('brain key rotation: the NEW trusted key\'s cancel of the same tx id un-pays what the OLD key paid (third review)', () => {
    const NEW_BRAIN = '7'.repeat(64);
    const both = new Set([BRAIN, NEW_BRAIN]);
    const oldPaid = purchase({ eventId: 'old1', createdAt: 1200 });
    const newCancel = purchase({ eventId: 'new1', pubkey: NEW_BRAIN, createdAt: 1300, status: 'cancelled', receiptDescription: '' });
    for (const purchases of [[oldPaid, newCancel], [newCancel, oldPaid]]) {
      const r = resolveOrder(paidApples({ purchases, trustedSigners: both }));
      expect(r.paymentState).toBe('unpaid');
      expect(r.pending).toBe(false);
      // …also against the pin of the old key's payment
      expect(resolveOrder(paidApples({ purchases, trustedSigners: both, settledPurchase: { txId: 'tx1', amount: '12.50' } })).paymentState).toBe('unpaid');
    }
    // same second: the not-paid version, whichever key signed it
    const sameSecond = purchase({ eventId: '0-new', pubkey: NEW_BRAIN, createdAt: 1200, status: 'cancelled', receiptDescription: '' });
    expect(resolveOrder(paidApples({ purchases: [oldPaid, sameSecond], trustedSigners: both })).paymentState).toBe('unpaid');
    // the new key re-signing the payment keeps it paid
    const newPaid = purchase({ eventId: 'new2', pubkey: NEW_BRAIN, createdAt: 1300 });
    const r2 = resolveOrder(paidApples({ purchases: [oldPaid, newPaid], trustedSigners: both, settledPurchase: { txId: 'tx1', amount: '12.50' } }));
    expect(r2.paymentState).toBe('paid');
    expect(r2.paidBy?.eventId).toBe('new2');
    // the old key still trusted, the new key NOT (yet): its cancel is a stranger's
    expect(resolveOrder(paidApples({ purchases: [oldPaid, newCancel] })).paymentState).toBe('paid');
    // a newer untrusted 'processing' never shadows a trusted cancel either
    const strangerPaid = purchase({ eventId: 's2', pubkey: 'x'.repeat(64), createdAt: 1400 });
    expect(resolveOrder(paidApples({ purchases: [oldPaid, newCancel, strangerPaid], trustedSigners: both })).paymentState).toBe('unpaid');
    expect(latestPurchaseVersions([oldPaid, newCancel]).map(p => p.eventId)).toEqual(['new1']);
  });

  it('two versions in the same second: the not-paid one is kept, whichever id is lower (fail-closed)', () => {
    for (const [cancelId, paidId] of [['a-cancel', 'b-paid'], ['z-cancel', 'b-paid']]) {
      const c = purchase({ eventId: cancelId, createdAt: 1300, status: 'cancelled', receiptDescription: '' });
      const p = purchase({ eventId: paidId, createdAt: 1300 });
      expect(resolveOrder(paidApples({ purchases: [p, c] })).paymentState, cancelId).toBe('unpaid');
      expect(resolveOrder(paidApples({ purchases: [c, p] })).paymentState, cancelId).toBe('unpaid');
    }
    // two paid copies of one second: the lowest id (NIP-01), and the order is paid either way
    const lo = purchase({ eventId: 'a-paid', createdAt: 1300 });
    const hi = purchase({ eventId: 'b-paid', createdAt: 1300 });
    expect(latestPurchaseVersions([hi, lo]).map(p => p.eventId)).toEqual(['a-paid']);
    expect(resolveOrder(paidApples({ purchases: [hi, lo] })).paidBy?.eventId).toBe('a-paid');
  });

  it('purchaseVersionWins: newer wins; same second → not-paid, then lowest id; never itself', () => {
    const v = (createdAt: number, status: string, eventId: string) => ({ createdAt, status, eventId });
    expect(purchaseVersionWins(v(2, 'processing', 'b'), v(1, 'cancelled', 'a'))).toBe(true);
    expect(purchaseVersionWins(v(1, 'cancelled', 'a'), v(2, 'processing', 'b'))).toBe(false);
    expect(purchaseVersionWins(v(5, 'cancelled', 'z'), v(5, 'processing', 'a'))).toBe(true);
    expect(purchaseVersionWins(v(5, 'processing', 'a'), v(5, 'cancelled', 'z'))).toBe(false);
    expect(purchaseVersionWins(v(5, '', 'z'), v(5, 'settled', 'a'))).toBe(true);
    expect(purchaseVersionWins(v(5, 'processing', 'a'), v(5, 'processing', 'b'))).toBe(true);
    expect(purchaseVersionWins(v(5, 'processing', 'b'), v(5, 'processing', 'a'))).toBe(false);
    expect(purchaseVersionWins(v(5, 'processing', 'a'), v(5, 'processing', 'a'))).toBe(false);
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
    i.order.fulfillment = 'pickup'; i.order.total = '4.08'; i.order.shipping = '0.00';
    // its sale unit 'g' is not the listing's unit today ('kos'): the money rule never reads the sale unit
    i.order.items = [{ a: APPLES, qty: 1, unitPrice: '4.08', currency: 'EUR', listingPrice: '4.08', listingCreatedAt: 99999 }];
    i.unit.pickup = true; i.unit.shippingFee = '5.00';
    for (const settledPurchase of [null, { txId: 'tx1', amount: '4.08' }]) {
      const r = resolveOrder({ ...i, settledPurchase, fulfillment: { pubkey: OWNER, createdAt: 2000, status: 'rejected' } });
      expect(r).toMatchObject({ paymentState: 'paid', expected: '4.08', priceChanged: true, effectiveStatus: 'rejected', pending: false });
    }
  });
});

/**
 * Second review of 2 Oct 2026. Step 5 compared the 30933 only with the
 * recomputed total, so a buyer could re-sign a paid order with the same
 * lines but their own numbers (unit_price 500.00, total 1002.50) and the
 * merchant's screen — and its refund button — showed those as the money.
 */
describe('resolveOrder — a paid order carries the merchant\'s numbers (SPEC v1.1.2)', () => {
  const APPLES = `36502:${OWNER}:apples`;
  const UNIT_REF = `30901:${OWNER}:${UNIT}`;
  /** E1: 2 × apples at 5.00 + 2.50 shipping = 12.50, paid. */
  function paid(over: Partial<ResolverInput> = {}): ResolverInput {
    const i = base({ listingPrice: null, listingCreatedAt: null, purchases: [purchase()], ...over });
    i.order.items = [{ a: APPLES, qty: 2, unitPrice: '5.00', currency: 'EUR', listingPrice: '5.00', listingCreatedAt: 900 }];
    i.order.shipping = '2.50';
    return i;
  }

  it('the honest order is paid', () => {
    expect(resolveOrder(paid())).toMatchObject({ paymentState: 'paid', expected: '12.50', pending: true });
  });

  it('the same lines with the buyer\'s own unit_price and total are not paid (probe case D)', () => {
    const i = paid();
    i.order.items[0].unitPrice = '500.00'; i.order.total = '1002.50';
    const r = resolveOrder(i);
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.pending).toBe(false);
    expect(r.expected).toBe('12.50');
  });

  it('every buyer number on its own: total, one line price, shipping, a line currency', () => {
    const total = paid(); total.order.total = '12.51';
    expect(resolveOrder(total).paymentState).toBe('amount_mismatch');
    const line = paid(); line.order.items[0].unitPrice = '5.01';
    expect(resolveOrder(line).paymentState).toBe('amount_mismatch');
    const ship = paid(); ship.order.shipping = '0.00';
    expect(resolveOrder(ship).paymentState).toBe('amount_mismatch');
    const cur = paid(); cur.order.items[0].currency = 'HUF';
    expect(resolveOrder(cur).paymentState).toBe('amount_mismatch');
    // a caller that passes no shipping is judged on total and lines only
    const noShip = paid(); delete noShip.order.shipping;
    expect(resolveOrder(noShip).paymentState).toBe('paid');
  });

  it('a cart: every line must carry its own listing price', () => {
    const i = paid({ purchases: [purchase({ amount: '15.50' })] });
    i.order.items.push({ a: `36502:${OWNER}:pears`, qty: 1, unitPrice: '3.00', currency: 'EUR', listingPrice: '3.00', listingCreatedAt: 900 });
    i.order.total = '15.50';
    expect(resolveOrder(i).paymentState).toBe('paid');
    // the buyer moves 1.00 from one line to the other: same total, wrong lines
    i.order.items[0].unitPrice = '4.50'; i.order.items[1].unitPrice = '4.00';
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
  });

  it('the step-5a pin is unaffected: the settled event keeps its verdict after a reprice', () => {
    const i = paid({ settledPurchase: { txId: 'tx1', amount: '12.50' } });
    i.order.items[0].listingPrice = '6.00';
    expect(resolveOrder(i).paymentState).toBe('paid');
    expect(resolveOrder({ ...i, settledPurchase: null }).paymentState).toBe('amount_mismatch');
  });

  it('a listing priced 0.00 (or below a cent) makes the order uncomputable', () => {
    const i = paid({ purchases: [purchase({ amount: '2.50' })] });
    i.order.items[0] = { ...i.order.items[0], unitPrice: '0.00', listingPrice: '0.00' };
    i.order.total = '2.50';
    const r = resolveOrder(i);
    expect(r.paymentState).toBe('amount_mismatch');
    expect(r.expected).toBe('');
  });

  it('pickup is computable only at a shop that offers it (probe case E)', () => {
    // apples at 2.50: E1 = 4 × 2.50 + 2.50 shipping; E2 = 5 × 2.50 pickup — same 12.50
    const i = paid();
    i.order.fulfillment = 'pickup'; i.order.shipping = '0.00';
    i.order.items[0] = { ...i.order.items[0], qty: 5, unitPrice: '2.50', listingPrice: '2.50' };
    for (const pickup of [false, undefined]) {
      const r = resolveOrder({ ...i, unit: { ...i.unit, pickup } });
      expect(r.paymentState, String(pickup)).toBe('amount_mismatch');
      expect(r.expected, String(pickup)).toBe('');
    }
    expect(resolveOrder({ ...i, unit: { ...i.unit, pickup: true } }).paymentState).toBe('paid');
    // a settled pickup order keeps its verdict when the shop stops offering pickup later
    expect(resolveOrder({ ...i, unit: { ...i.unit, pickup: false }, settledPurchase: { txId: 'tx1', amount: '12.50' } }).paymentState).toBe('paid');
  });

  it('a fulfillment other than shipping / pickup is not computable', () => {
    const i = paid(); i.order.fulfillment = 'teleport';
    expect(resolveOrder(i).paymentState).toBe('amount_mismatch');
  });

  it('usableListingPrice: positive price, the shop\'s currency, the order\'s own shop', () => {
    const l = { price: '5.00', currency: 'EUR', unitRef: UNIT_REF };
    expect(usableListingPrice(l, 'EUR', UNIT_REF)).toBe('5.00');
    expect(usableListingPrice({ ...l, currency: 'eur' }, 'EUR', UNIT_REF)).toBe('5.00');
    expect(usableListingPrice(null, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, price: '0.00' }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, price: '' }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, price: '5.001' }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, price: null }, 'EUR', UNIT_REF)).toBeNull();
    // probe A: a EUR-priced listing in a HUF shop
    expect(usableListingPrice(l, 'HUF', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, currency: '' }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice(l, '', UNIT_REF)).toBeNull();
    // probe B: the same owner's listing of ANOTHER shop
    expect(usableListingPrice({ ...l, unitRef: `30901:${OWNER}:${'2'.repeat(32)}` }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, unitRef: `30901:${'x'.repeat(64)}:${UNIT}` }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, unitRef: '' }, 'EUR', UNIT_REF)).toBeNull();
    expect(usableListingPrice({ ...l, unitRef: undefined }, 'EUR', '')).toBeNull();
  });
});
