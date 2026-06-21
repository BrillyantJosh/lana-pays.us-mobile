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
 */
import type { Express } from 'express';
import type Database from 'better-sqlite3';

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
  app.get('/api/request-logs', (req, res) => {
    const caller = String(req.headers['x-admin-hex'] || req.headers['x-admin-hex-id'] || req.query.admin_hex || '').toLowerCase();
    if (caller !== ROOT_ADMIN_HEX) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.min(parseInt(String(req.query.limit || '200')) || 200, 2000);
    const q = String(req.query.q || '').trim();
    const rows = q
      ? db.prepare('SELECT * FROM request_logs WHERE path LIKE ? ORDER BY id DESC LIMIT ?').all('%' + q + '%', limit)
      : db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ count: rows.length, logs: rows });
  });
}
