// @vitest-environment node
/**
 * The wiring itself, read out of the source — a guard against the two ways this
 * gate silently stops existing:
 *
 *   1. Somebody moves /api/exclusion/:hexId below the SPA catch-all. It then
 *      answers index.html with HTTP 200 and every client reads "not excluded".
 *      Nothing at runtime looks wrong; the door is simply open again.
 *   2. Somebody removes a gate() from a route, or adds a new hex allow-list.
 *
 * Reading the code in a test is unusual, but this repo already does it
 * (see the fleet's copy.test.ts) and no unit test of a handler can catch a
 * registration ORDER bug.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');

const indexTs = read('index.ts');
const ordersTs = read('orders.ts');
const paymentsTs = read('paymentRequests.ts');
const requestLogTs = read('shared/requestLogging.ts');
const heartbeatTs = read('heartbeat.ts');

/** The 1-based line a registration actually sits on (comments mentioning it don't count). */
const registrationLine = (source: string, prefix: string): number =>
  source.split('\n').findIndex((l) => l.trimStart().startsWith(prefix)) + 1;

/** The source with comments stripped, for smell checks that must not read prose. */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the answer route lives above the SPA catch-all', () => {
  it('is registered before app.get(\'/{*path}\')', () => {
    const route = registrationLine(indexTs, "app.get('/api/exclusion/:hexId'");
    const catchAll = registrationLine(indexTs, "app.get('/{*path}'");
    expect(route).toBeGreaterThan(0);
    expect(catchAll).toBeGreaterThan(0);
    expect(route).toBeLessThan(catchAll);
  });

  it('is not gated by itself — an excluded person must still be able to be told so', () => {
    const line = indexTs.split('\n').find((l) => l.includes("app.get('/api/exclusion/:hexId'"))!;
    expect(line).not.toContain('gate(');
  });
});

describe('every route that acts in a person\'s name asks the gate', () => {
  const gated: Array<[string, string, string]> = [
    // [file label, source, exact registration prefix]
    ['index.ts', indexTs, "app.post('/api/users'"],
    ['index.ts', indexTs, "app.post('/api/profile-lookup'"],
    ['index.ts', indexTs, "app.post('/api/register/wallet'"],
    ['index.ts', indexTs, "app.get('/api/business-units/:hexId'"],
    ['index.ts', indexTs, "app.get('/api/regular-customers/:unitId'"],
    ['index.ts', indexTs, "app.post('/api/regular-customers'"],
    ['index.ts', indexTs, "app.delete('/api/regular-customers/:unitId/:customerHexId'"],
    ['index.ts', indexTs, "app.get('/api/regular-customers-all'"],
    ['index.ts', indexTs, "app.get('/api/customers-status'"],
    ['index.ts', indexTs, "app.get('/api/profile-full/:hexId'"],
    ['index.ts', indexTs, "app.post('/api/broadcast-event'"],
    ['index.ts', indexTs, "app.post('/api/dm/fetch'"],
    ['index.ts', indexTs, "app.post('/api/dm/publish'"],
    ['index.ts', indexTs, "app.post('/api/brain/purchase/preview'"],
    ['index.ts', indexTs, "app.post('/api/brain/purchase/check-dedup'"],
    ['index.ts', indexTs, "app.post('/api/brain/purchase'"],
    ['index.ts', indexTs, "app.get('/api/admin/check'"],
    ['orders.ts', ordersTs, "app.get('/api/orders/pending-count'"],
    ['orders.ts', ordersTs, "app.get('/api/orders'"],
    ['orders.ts', ordersTs, "app.get('/api/orders/:orderId'"],
    ['orders.ts', ordersTs, "app.post('/api/orders/:orderId/fulfillment'"],
    ['paymentRequests.ts', paymentsTs, "app.post('/api/payment-requests'"],
    ['paymentRequests.ts', paymentsTs, "app.get('/api/payment-requests'"],
    ['paymentRequests.ts', paymentsTs, "app.post('/api/payment-requests/:id/cancel'"],
    ['paymentRequests.ts', paymentsTs, "app.get('/api/payment-requests/unseen-count'"],
    ['paymentRequests.ts', paymentsTs, "app.post('/api/payment-requests/mark-seen'"],
    ['paymentRequests.ts', paymentsTs, "app.post('/api/pay/:token/preview'"],
    ['paymentRequests.ts', paymentsTs, "app.post('/api/pay/:token/submit'"],
  ];

  for (const [label, source, prefix] of gated) {
    it(`${label} — ${prefix.slice(prefix.indexOf('/'))} carries gate()`, () => {
      const line = source.split('\n').find((l) => l.trimStart().startsWith(prefix));
      expect(line, `route not found: ${prefix}`).toBeTruthy();
      expect(line!.includes('gate(db,') || line!.includes('gateNames(db,'), `${prefix} lost its gate`).toBe(true);
    });
  }
});

describe('the money route gates EVERY person the sale names', () => {
  const purchaseRoutes = [
    "app.post('/api/brain/purchase',",
    "app.post('/api/brain/purchase/preview',",
    "app.post('/api/brain/purchase/check-dedup',",
  ];

  for (const prefix of purchaseRoutes) {
    it(`${prefix.slice(prefix.indexOf('/'), -2)} asks purchaseNames, not one field`, () => {
      const line = indexTs.split('\n').find((l) => l.trimStart().startsWith(prefix));
      expect(line, `route not found: ${prefix}`).toBeTruthy();
      expect(line!).toContain('gateNames(db, purchaseNames)');
    });
  }

  it('purchaseNames carries the customer, their WALLET, the selling UNIT and the till operator', () => {
    // Gating customer_hex alone was the live hole twice over: an excluded
    // MERCHANT kept selling (no merchant identity was on the request at all),
    // and an excluded CUSTOMER was served by sending customer_hex: '' and
    // paying from their wallet. Every carrier has to be in this one place.
    const fn = indexTs.slice(indexTs.indexOf('const purchaseNames'), indexTs.indexOf('const purchaseNames') + 400);
    expect(fn).toContain('customer_hex');
    expect(fn).toContain("x-lana-hex");
    expect(fn).toContain('wallet: [req.body?.customer_wallet]');
    expect(fn).toContain('unit: [req.body?.unit_id]');
  });

  it('the public /api/pay pages gate the customer AND resolve their wallet', () => {
    for (const token of ['/api/pay/:token/preview', '/api/pay/:token/submit']) {
      const at = paymentsTs.indexOf(`app.post('${token}'`);
      expect(at, `route not found: ${token}`).toBeGreaterThan(0);
      const block = paymentsTs.slice(at, at + 400);
      expect(block, `${token} does not resolve the paying wallet`).toContain('wallet: [req.body?.customer_wallet]');
    }
  });

  it('the public /api/pay pages also gate the SELLER, who is on the row and not in the body', () => {
    expect(paymentsTs).toContain("excludedMerchant(db, [row.unit_id])");
    expect(paymentsTs).toContain("excludedMerchant(db, [preRow.unit_id])");
  });

  it('and refuse the BUYER neutrally — never with the seller\'s sanction attached', () => {
    // A buyer on a public payment link is the subject of nothing. Answering
    // them with exclusionRefusal() told them, in English, that THEIR access was
    // paused by a commission, and handed them the ground and the event id of
    // somebody else's decision.
    expect(paymentsTs, 'the buyer is being told they are the excluded one').not.toContain('exclusionRefusal');
    expect((codeOnly(paymentsTs).match(/json\(merchantRefusal\(\)\)/g) || []).length).toBe(2);
  });
});

describe('the routes that spend money name who is spending it', () => {
  for (const prefix of ["app.post('/api/upload'", "app.post('/api/receipt/upload'", "app.post('/api/receipt/analyze'"]) {
    it(`${prefix.slice(prefix.indexOf('/'), -1)} is gated and refuses an anonymous caller`, () => {
      // These three carried NO identity of any kind, so the gate could never
      // fire and an excluded merchant kept spending storage and the Claude
      // receipt-analysis budget. The gate must sit AFTER multer, or req.body
      // is still empty when it reads the hex out of the multipart form.
      const line = indexTs.split('\n').find((l) => l.trimStart().startsWith(prefix));
      expect(line, `route not found: ${prefix}`).toBeTruthy();
      expect(line!).toContain('gate(db, uploadCaller, discardUploads)');
      expect(line!).toContain('requireCaller');
      const multerAt = Math.max(line!.indexOf('.single('), line!.indexOf('.array('));
      expect(multerAt, 'no multer middleware on this route?').toBeGreaterThan(0);
      expect(multerAt, 'the gate must come after multer or req.body is empty').toBeLessThan(line!.indexOf('gate(db, uploadCaller'));
    });
  }
});

describe('the vendored request-log endpoint is not a second admin gate', () => {
  it('/api/request-logs asks the exclusion gate before its hardcoded hex', () => {
    const line = requestLogTs.split('\n').find((l) => l.trimStart().startsWith("app.get('/api/request-logs'"));
    expect(line, 'route not found').toBeTruthy();
    expect(line!, 'the hardcoded root hex authorised an excluded person').toContain('excludedGate');
    const gateAt = requestLogTs.indexOf('const excludedGate');
    const compareAt = requestLogTs.indexOf('caller !== ROOT_ADMIN_HEX');
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt, 'the gate must be built before the comparison it protects').toBeLessThan(compareAt);
  });

  it('every carrier the comparison reads is a carrier the gate reads', () => {
    const gateBlock = requestLogTs.slice(requestLogTs.indexOf('const excludedGate'), requestLogTs.indexOf("app.get('/api/request-logs'"));
    for (const carrier of ['x-admin-hex', 'x-admin-hex-id', 'admin_hex']) {
      expect(gateBlock, `${carrier} is read by the handler but not by the gate`).toContain(carrier);
    }
  });
});

describe('the refresh does not depend on this tick\'s KIND 38888', () => {
  it('runs BEFORE fetchKind38888(), which throws and used to skip it entirely', () => {
    // Live: every tick printed "No valid KIND 38888 events received" then
    // "Heartbeat failed", and the '[exclusion] (heartbeat)' line never appeared
    // once — so a NEW decision never landed on that container, ever.
    const refresh = heartbeatTs.indexOf("refreshPersonExclusions(db, 'heartbeat')");
    const fetch38888 = heartbeatTs.indexOf('await fetchKind38888()');
    expect(refresh).toBeGreaterThan(0);
    expect(fetch38888).toBeGreaterThan(0);
    expect(refresh, 'the refresh is downstream of the throw again').toBeLessThan(fetch38888);
  });
});

describe('no relay-silence adapter has grown back', () => {
  it('the relay query resolves what it got instead of rejecting on silence', () => {
    // A PARTIAL answer is indistinguishable from a complete one, so "did any
    // relay answer?" was never a sound question. The set is merged now, so an
    // absence lifts nobody and the guess is not needed.
    const nostrTs = codeOnly(read('lib/nostr.ts'));
    expect(nostrTs, 'the throw-on-silence adapter is back').not.toContain('no relay answered');
  });
});

describe('nobody is exempt', () => {
  it('the admin helper asks the gate before it hands back an admin hex', () => {
    const fn = indexTs.slice(indexTs.indexOf('function requireAdmin'), indexTs.indexOf('function requireAdmin') + 900);
    expect(fn).toContain('excludedNow(db, hexId)');
    expect(fn).toContain('exclusionRefusal');
  });

  it('there is no hex allow-list or admin escape anywhere in the gate', () => {
    // Comments are stripped first: this file says "NOBODY IS EXEMPT" in prose,
    // and the check is about code, not about what the code says about itself.
    const gateSrc = codeOnly(read('lib/exclusionGate.ts')) + codeOnly(read('lib/personExclusion.ts'));
    for (const smell of ['ADMIN_HEXES', 'ALLOW_LIST', 'ALLOWLIST', 'BYPASS', 'alwaysAllow', 'EXEMPT', 'isAdmin', 'isRoot']) {
      expect(gateSrc, `found "${smell}" in the gate`).not.toContain(smell);
    }
    // No 64-hex literal may be hardcoded in the gate: the trusted signer comes
    // from KIND 38888, and no person may ever be named in the code.
    expect(gateSrc.match(/['"][0-9a-f]{64}['"]/g)).toBeNull();
  });
});

describe('the standing set is kept fresh', () => {
  it('the tables exist before any route can ask', () => {
    expect(indexTs).toContain('ensureExclusionTables(db);');
    const created = indexTs.split('\n').findIndex((l) => l.trimStart().startsWith('ensureExclusionTables(db);')) + 1;
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(registrationLine(indexTs, "app.get('/api/exclusion/:hexId'"));
  });

  it('is read once at boot and then on the existing heartbeat', () => {
    expect(indexTs).toContain("refreshPersonExclusions(db, 'boot')");
    expect(read('heartbeat.ts')).toContain("refreshPersonExclusions(db, 'heartbeat')");
  });

  it('says at boot which state the switch is in', () => {
    expect(indexTs).toContain('logGateState()');
  });
});

describe('the gate shuts out a person, not everybody standing near them', () => {
  it('a unit resolves to its OWNER only — the staff roster is not an identity to refuse', () => {
    // It used to return the owner PLUS every hex in authorized_hex, and one
    // excluded staff member then closed a CLEAN owner's shop on that owner's
    // own sales. Proven live on the probe.
    const gateSrc = codeOnly(read('lib/exclusionGate.ts'));
    expect(gateSrc, 'the staff roster is being read as a set of people to refuse').not.toContain('authorized_hex');
    expect(gateSrc).toContain('SELECT owner_hex FROM business_units');
  });

  it('a refusal about the SHOP does not carry the shape a client reads as "you are excluded"', () => {
    const gateSrc = read('lib/exclusionGate.ts');
    const from = gateSrc.indexOf('export function merchantRefusal');
    const fn = gateSrc.slice(from, gateSrc.indexOf('\n}', from) + 2);
    expect(fn).toContain('MERCHANT_UNAVAILABLE_CODE');
    for (const leak of ['ground', 'eventId', 'since', 'excluded']) {
      expect(fn, `merchantRefusal leaks ${leak} to somebody the decision is not about`).not.toContain(leak);
    }
  });

  it('the till and the public pay page both say the neutral thing in the user\'s language', () => {
    for (const rel of ['../../src/components/tabs/LanaTab.tsx', '../../src/components/tabs/CashTab.tsx', '../../src/pages/PublicPay.tsx']) {
      const src = fs.readFileSync(path.resolve(here, rel), 'utf8');
      expect(src, `${rel} shows the raw English body for a merchant refusal`).toContain('isMerchantUnavailable');
      expect(src).toContain("purchase.merchantUnavailable");
    }
  });
});

describe('the trust root the gate reads is verified, not just compared', () => {
  it('the cached KIND 38888 is checked for author AND signature before it names a signer', () => {
    const gateSrc = read('lib/exclusionGate.ts');
    const fn = gateSrc.slice(gateSrc.indexOf('export function trustedSignersFrom'), gateSrc.indexOf('export interface ExclusionDeps'));
    expect(fn, 'the pinned author is not being checked at all').toContain('KIND_38888_PUBKEY');
    expect(fn, 'pubkey is just a JSON field — the signature has to be checked').toContain('verify(ev)');
  });

  it('the pin is imported, never a second copy of the key', () => {
    expect(read('lib/exclusionGate.ts')).toContain("KIND_38888_PUBKEY } from './nostr.js'");
  });
});

describe('the answer route says whether this box has ever heard anything', () => {
  it('/api/exclusion/:hexId carries `known` beside `excluded`', () => {
    // Without it, an empty table on a fresh container answers "not excluded"
    // with total confidence and every browser forgets the decision it is showing.
    const at = indexTs.indexOf("app.get('/api/exclusion/:hexId'");
    const block = indexTs.slice(at, at + 1400);
    expect(block).toContain('exclusionKnown(db)');
    expect((block.match(/known,/g) || []).length, 'both answers must carry it').toBe(2);
  });
});

describe('a refused upload does not still cost this server its disk', () => {
  it('the refusal deletes what multer already wrote', () => {
    // multer parses (and, for /api/upload, WRITES) before the gate can read the
    // hex out of the multipart form. Measured: a 403 left the file behind and
    // nothing in server/ ever deletes one.
    expect(indexTs).toContain('function discardUploads');
    expect(indexTs).toContain('fs.unlinkSync');
    const requireCallerAt = indexTs.indexOf('const requireCaller');
    const block = indexTs.slice(requireCallerAt, requireCallerAt + 400);
    expect(block, 'an anonymous upload is refused but kept').toContain('discardUploads(req)');
  });
});

describe('no machine in this repo authenticates as a person', () => {
  it('the heartbeat no longer carries a hardcoded 64-hex pubkey as an outbound credential', () => {
    // It used to send one real person's key as x-admin-hex-id to the brain, and
    // that person is one of the standing KIND 87058 subjects.
    //
    // The replacement is not "the same borrowed identity, from an env var". The
    // brain grew a door for MACHINES — GET /api/peer/merchant-usage, read-only,
    // authorised by a service key in an Authorization: Bearer header — and this
    // container holds a key of its own in BRAIN_PEER_KEY. So both halves are
    // asserted: no person's hex, and no admin-hex header to put one in.
    const code = codeOnly(heartbeatTs);
    expect(code.match(/['"][0-9a-f]{64}['"]/g), 'a person\'s key is hardcoded in the heartbeat again').toBeNull();
    expect(code).toContain('BRAIN_PEER_KEY');
    expect(code).toContain('/api/peer/merchant-usage');
    expect(code, 'the heartbeat is authenticating as a person again').not.toContain('x-admin-hex-id');
    expect(code, 'a machine must not hold a person hex at all').not.toContain('BRAIN_ADMIN_HEX');
  });
});

describe('no route lands ungated by accident', () => {
  /**
   * The gate list above is a list of routes somebody remembered to add. That is
   * exactly how /api/request-logs stayed open: it was vendored in under
   * server/shared/, it authorised a hardcoded hex on its own, and no test in
   * this file ever looked at that directory.
   *
   * So this reads EVERY route registration across the server instead, and makes
   * an ungated one a deliberate, written decision rather than an oversight.
   * A new route is either gated, or it is named here with the reason it is not.
   */
  const UNGATED: Record<string, string> = {
    // Reads that carry no action and must survive an exclusion.
    '/health': 'liveness probe, no identity, no action',
    '/api/exclusion/:hexId': 'the one thing an excluded person must still be able to ask',
    '/api/system-params': 'public KIND 38888 mirror, no identity',
    '/i18n/languages': 'static language list',
    '/{*path}': 'the SPA shell — refusing it would leave a white screen with no message',

    // Public reads. They reveal nothing an excluded person does not already
    // know about themselves, and gating them would only hide the closed door.
    '/api/balance/:address': 'public chain read, keyed by wallet not person',
    '/api/lana-utxos/:address': 'public chain read',
    '/api/lana-raw-tx/:hash': 'public chain read',
    '/api/users/:hexId': 'public profile read; the ACTIONS on that person are gated',
    '/api/users/by-wallet/:address': 'public wallet→person read, used by the gate itself',
    '/api/lana8wonder/:hexId': 'public enrollment read',
    '/api/profile-search': 'public directory search',
    '/api/wallets/:hexId': 'public wallet list read',
    '/api/caretaker/:unitId': 'public caretaker contact card',
    '/api/max-transaction': 'public per-unit limit read, no person on the request',
    '/api/pay/:token': 'public view of one payment request; the 192-bit token IS the capability',
    '/api/check-wallet': 'registrar passthrough keyed by wallet; the purchase that follows is gated',

    // Mounts, not routes — now that the regex can see app.use() with a path.
    '/api': 'the rate limiter, mounted in front of the API; it judges IPs, not people',
    '/uploads': 'express.static for already-accepted images; the routes that WRITE them are gated',

    // Gated inside the handler rather than on the registration line.
    '/api/admin/settings': 'requireAdmin() folds excludedNow() in — pinned separately below',
    '/api/request-logs': 'gated by excludedGate, built above it — pinned separately above',
    '/api/upload': 'gate + requireCaller after multer — pinned separately above',
    '/api/receipt/upload': 'gate + requireCaller after multer — pinned separately above',
    '/api/receipt/analyze': 'gate + requireCaller after multer — pinned separately above',
  };

  /**
   * Every shape a mount can take, not just the one somebody happened to use.
   *
   * The first version of this read /app\.(get|post|…)\(\s*'…'/ and nothing else,
   * so it was blind to app.use('/api/x', handler), to a double-quoted or
   * template-literal path, and to a router. app.use with a path is exactly the
   * shape server/shared/requestLogging.ts arrived in — the one file this suite
   * did not look at until it was already open.
   */
  const ROUTE_RE = /^\s*(?:app|router)\.(get|post|put|delete|patch|use|all)\(\s*(['"`])([^'"`]+)\2/;

  const everyRoute = () => {
    const out: Array<{ file: string; path: string; line: string }> = [];
    for (const [file, src] of [
      ['index.ts', indexTs], ['orders.ts', ordersTs], ['paymentRequests.ts', paymentsTs],
      ['shared/requestLogging.ts', requestLogTs],
    ] as const) {
      for (const line of src.split('\n')) {
        const m = ROUTE_RE.exec(line);
        if (m) out.push({ file, path: m[3], line });
      }
    }
    return out;
  };

  it('finds the routes at all — a regex that matches nothing proves nothing', () => {
    expect(everyRoute().length).toBeGreaterThan(30);
  });

  for (const r of everyRoute()) {
    it(`${r.file} — ${r.path} is gated or written down as deliberately open`, () => {
      const gated = r.line.includes('gate(db,') || r.line.includes('gateNames(db,') || r.line.includes('excludedGate');
      if (gated) return;
      expect(
        UNGATED[r.path],
        `${r.path} is ungated and not accounted for. Gate it, or add it to UNGATED with the reason.`,
      ).toBeTruthy();
    });
  }
});
