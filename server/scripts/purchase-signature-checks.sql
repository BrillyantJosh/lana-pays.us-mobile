-- Read-only checks for deciding when PURCHASE_SIGNATURE_REQUIRED may be turned on.
-- What they mean and how to run them: README.md, "Signed purchase requests".
-- server/purchaseSignatureChecks.test.ts runs every block below on the real table shape.

.print
.print === 1. Every request that was not ok, last 7 days, all statuses
WITH recent AS (
  SELECT l.*,
    CASE
      WHEN l.claimed_prefix = '' THEN 'nobody named'
      WHEN EXISTS (
        SELECT 1 FROM business_units b
        WHERE substr(b.unit_id, 1, 12) = l.unit_prefix
          AND (lower(substr(b.owner_hex, 1, 12)) = l.claimed_prefix
               OR lower(b.authorized_hex) LIKE '%"' || l.claimed_prefix || '%')
      ) THEN 'NAMES SOMEONE ON THIS UNIT'
      ELSE 'names someone else'
    END AS who,
    EXISTS (
      SELECT 1 FROM purchase_auth_log r
      WHERE r.till_marker = 1 AND r.claimed_prefix = l.claimed_prefix AND r.id < l.id
    ) AS seller_had_reloaded,
    EXISTS (
      SELECT 1 FROM purchase_auth_log r
      WHERE r.verdict = 'ok' AND r.claimed_prefix = l.claimed_prefix AND r.id > l.id
    ) AS ok_followed
  FROM purchase_auth_log l
  WHERE l.verdict <> 'ok' AND l.ts >= datetime('now', '-7 days')
)
SELECT
  CASE
    WHEN verdict = 'bad_signature' AND reason = 'STALE' THEN 'acceptable'
    WHEN verdict = 'bad_signature' AND reason = 'REPLAYED' AND ok_followed THEN 'acceptable'
    WHEN verdict = 'bad_signature' AND reason = 'REPLAYED' THEN 'look by hand'
    WHEN verdict = 'bad_signature' AND (till_marker = 1 OR who = 'NAMES SOMEONE ON THIS UNIT') THEN 'NO-GO'
    WHEN verdict = 'bad_signature' THEN 'look by hand'
    WHEN verdict = 'check_failed' THEN 'NO-GO'
    WHEN verdict = 'unsigned' AND who = 'NAMES SOMEONE ON THIS UNIT' AND (till_marker = 1 OR seller_had_reloaded) THEN 'NO-GO'
    WHEN verdict = 'unsigned' AND who = 'NAMES SOMEONE ON THIS UNIT' THEN 'wait for a reload'
    WHEN verdict = 'unsigned' AND till_marker = 1 THEN 'look by hand'
    WHEN verdict = 'unsigned' THEN 'acceptable'
    ELSE 'look by hand'
  END AS reading,
  verdict, reason, status, till_marker AS marker, unit_prefix, claimed_prefix, signer_prefix, who,
  COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
FROM recent
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
ORDER BY CASE reading WHEN 'NO-GO' THEN 0 WHEN 'look by hand' THEN 1 WHEN 'wait for a reload' THEN 2 ELSE 3 END, last DESC;

.print
.print === 2. Lost rows: sales the route answered 200 against rows written, last 24 hours. Must match.
SELECT
  (SELECT COUNT(*) FROM request_logs
    WHERE method = 'POST' AND path = '/api/brain/purchase' AND status = 200 AND ts >= datetime('now', '-24 hours')) AS route_200,
  (SELECT COUNT(*) FROM purchase_auth_log
    WHERE status = 200 AND ts >= datetime('now', '-24 hours')) AS logged_200;

.print
.print === 3. Unreadable staff lists. Must be 0.
SELECT COUNT(*) AS bad_staff_lists FROM business_units
WHERE json_valid(authorized_hex) = 0 OR json_type(authorized_hex) <> 'array';

.print
.print === 4. Units with sales in the brain in the last 60 days and no ok row. Explain each by hand.
ATTACH 'file:/opt/apps/lana-brain/data/lana-brain.db?mode=ro' AS brain;
SELECT t.unit_id,
  COALESCE(u.name, '') AS name,
  CASE
    WHEN u.unit_id IS NULL THEN 'not a unit on this till'
    WHEN COALESCE(u.unit_type, '') = 'simple.lanapays.us' OR COALESCE(u.lana_only, 0) = 1 THEN 'simple site'
    ELSE 'status ' || COALESCE(u.status, '?')
  END AS on_this_till,
  SUM(t.payment_type = 'cash') AS cash,
  SUM(t.payment_type = 'lana') AS lana,
  MAX(t.created_at) AS last_sale
FROM brain.transactions t
LEFT JOIN business_units u ON u.unit_id = t.unit_id
WHERE t.created_at >= datetime('now', '-60 days')
  AND NOT EXISTS (
    SELECT 1 FROM purchase_auth_log l
    WHERE l.verdict = 'ok' AND l.unit_prefix = substr(t.unit_id, 1, 12)
  )
GROUP BY t.unit_id
ORDER BY last_sale DESC;
