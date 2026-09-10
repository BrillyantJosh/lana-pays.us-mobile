/**
 * Shared request-logging middleware (vendored).
 *
 * A breadcrumb trail of every request — method/path/status/duration/ip ONLY,
 * never bodies (they may hold WIF/secrets) — into a `request_logs` table with
 * 24h auto-purge, viewable by the root admin at GET /api/request-logs.
 *
 * This file is vendored IDENTICALLY into each LANA server app under
 * `server/shared/` on purpose: independently-deployed money services keep their
 * own copy so none shares a runtime dependency (blast-radius isolation). Behaviour
 * is byte-for-byte the inline block it replaced. Edit the canonical copy, then
 * re-vendor (the copies are kept in sync by hand / a sync script, not a registry).
 *
 * ONE DELIBERATE DIVERGENCE (2026-09-10): the read endpoint now goes through this
 * app's KIND 87058 gate (`../lib/exclusionGate.js`) before its hardcoded-hex
 * comparison. The comparison alone was a second admin gate that no exclusion ever
 * reached, so an excluded root key kept reading the whole till's request history
 * while every other admin route refused it. When re-vendoring, carry the gate
 * across too — a copy without it re-opens the hole in whichever app receives it.
 */
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { gate } from '../lib/exclusionGate.js';

const ROOT_ADMIN_HEX = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
const ASSET_RE = /\.(js|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)$/i;

/**
 * Install the request-logging table, middleware, 24h purge timer, and the
 * root-admin-gated read endpoint onto an Express app. Call ONCE, at the same
 * point in the middleware chain where you want logging to begin (early).
 */
export function installRequestLogging(app: Express, db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      method TEXT, path TEXT, status INTEGER, duration_ms INTEGER, ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts);
  `);
  const insert = db.prepare('INSERT INTO request_logs (method, path, status, duration_ms, ip) VALUES (?, ?, ?, ?, ?)');
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const p = (req.originalUrl || req.url || '').split('?')[0];
      if (ASSET_RE.test(p)) return;
      try {
        insert.run(req.method, p.slice(0, 300), res.statusCode, Date.now() - t0,
          ((req.headers['x-forwarded-for'] as string) || req.ip || '').toString().split(',')[0].trim().slice(0, 64));
      } catch { /* logging must never break a request */ }
    });
    next();
  });
  const purge = () => { try { db.prepare(`DELETE FROM request_logs WHERE ts < datetime('now','-24 hours')`).run(); } catch { /* noop */ } };
  purge();
  // unref so the hourly purge timer alone never keeps the process alive (no-op in a
  // running server — the HTTP listener holds the loop open — but lets tests/scripts exit).
  const purgeTimer = setInterval(purge, 60 * 60 * 1000);
  (purgeTimer as any).unref?.();
  // NOBODY IS EXEMPT — the hardcoded hex below is an allow-list, and an
  // allow-list is exactly what a commission decision has to be able to cross.
  // This endpoint hands out the 24h breadcrumb trail of every person who used
  // the till (method, path, status, duration, client IP), and it used to do so
  // to an EXCLUDED key while /api/admin/settings and /api/admin/check were both
  // refusing that same key: the comparison below was a second, ungated admin
  // gate that nothing else in the app knew about.
  //
  // All three carriers are asked, not just the one the comparison happens to
  // read first — filling a field the handler ignores is how gates get walked
  // past. `gate()` refuses ANY of them that carries a standing decision, and it
  // honours the one kill switch (EXCLUSION_GATE=off) like every other route.
  const excludedGate = gate(db, (req: any) => [
    req.headers['x-admin-hex'],
    req.headers['x-admin-hex-id'],
    req.query?.admin_hex,
  ]);
  app.get('/api/request-logs', excludedGate, (req, res) => {
    const caller = String(req.headers['x-admin-hex'] || req.headers['x-admin-hex-id'] || req.query.admin_hex || '').toLowerCase().trim();
    if (caller !== ROOT_ADMIN_HEX) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.min(parseInt(String(req.query.limit || '200')) || 200, 2000);
    const q = String(req.query.q || '').trim();
    const rows = q
      ? db.prepare('SELECT * FROM request_logs WHERE path LIKE ? ORDER BY id DESC LIMIT ?').all('%' + q + '%', limit)
      : db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ count: rows.length, logs: rows });
  });
}
