/**
 * Dev-only escape hatches (SPEC §12) — hardened so they cannot be armed in
 * production even by accident.
 *
 * The first version gated only on `NODE_ENV !== 'production'`, but our
 * docker-compose does not set NODE_ENV at all, so in production that gate is
 * OPEN. Two further conditions close it for real:
 *
 *   1. an override relay must be LOOPBACK. A leaked or injected env var can
 *      then only point this process at a relay that does not exist on the VPS,
 *      which fails loudly, instead of silently mirroring a stranger's relay.
 *   2. the KIND 38888 signer override is honoured ONLY together with (1), so
 *      the production trust anchor can never be repointed while the process is
 *      still reading production relays.
 *
 * Why the hatch exists at all: without it a local run reads and mirrors
 * PRODUCTION relay state even when pointed at the devstack — which is what
 * broke the first E2E run (mobile mirrored 145 production units and dropped
 * the local test order as "unknown unit").
 */
const LOOPBACK = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i;

const raw = String(process.env.LANA_RELAYS_OVERRIDE || '').trim();

/** Loopback relays to use instead of the production set; empty = use production. */
export const devRelays: string[] =
  process.env.NODE_ENV === 'production'
    ? []
    : raw.split(',').map((s) => s.trim()).filter((s) => LOOPBACK.test(s));

/** KIND 38888 signer to pin instead of the hardcoded one; '' = use the hardcoded one. */
export const devKind38888Signer: string =
  devRelays.length && /^[0-9a-f]{64}$/i.test(process.env.KIND_38888_PUBKEY || '')
    ? String(process.env.KIND_38888_PUBKEY).toLowerCase()
    : '';

if (raw && !devRelays.length) {
  console.warn(
    `[dev-override] LANA_RELAYS_OVERRIDE=${JSON.stringify(raw)} IGNORED ` +
    '(production build, or not a loopback ws:// URL) — using the production relays.',
  );
}
