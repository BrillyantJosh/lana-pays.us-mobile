# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)

## Signed purchase requests: when refusing may be turned on

The till signs every sale (`src/lib/purchaseRequest.ts`). The server checks the signature and whether the signer is the unit's owner or staff, and writes the verdict to the table `purchase_auth_log` and the container log (`server/purchaseSeller.ts`).

The setting `PURCHASE_SIGNATURE_REQUIRED` decides what happens after that:

- Anything but the exact word `on`, and `off` is the default: nothing is refused for a verdict, and the KIND 87058 gate works as it always did.
- `on`: a purchase that is not `ok` is refused before it reaches the brain, and the KIND 87058 check also asks about the person the signature proved.

It stays off until everything under "Go or no-go" holds, because a refusal at a live till costs a real sale.

### Reading a row

- `verdict`: `ok` is a good signature from the unit's owner or staff. `unsigned` has no signature. `bad_signature` has one that does not hold, and `reason` says why. `not_entitled` is a good signature from someone who is not on the unit, and `reason` says why. `check_failed` means the check itself could not run.
- `status`: what the till was answered. 200 means the brain recorded the sale. 0 means the till left before the answer.
- `till_marker` (`marker` in the log line): 1 means the request came from code that knows how to sign, signed or not. 0 means a tab on older code, or something that is not a till. It only helps read the row and decides nothing.
- `claimed_prefix`: who the request says it is. It proves nothing. `signer_prefix` is who the signature proved. Both hold the first 12 characters of a hex.
- An older tab open past its 8 hours names nobody and has marker 0, so its row looks the same as a request that did not come from a till.

### The checks

They only read. Run them from a checkout of this repo, against the host and path in `.github/workflows/deploy.yml`:

```sh
ssh root@HOST 'sqlite3 -readonly -header -column /opt/apps/lana-pays.us-mobile/data/lana-pays.db' < server/scripts/purchase-signature-checks.sql
```

The container log has the same verdicts until the next deploy replaces the container:

```sh
ssh root@HOST "docker logs --since 24h lana-pays-mobile-web 2>&1 | grep '\[purchase-auth\]'"
```

### Go or no-go

All of these, on the same day, with the signing code live for at least 7 days and sales seen on units that have staff:

1. **Check 1 has no row reading `NO-GO`.** The `reading` column applies these rules:
   - `STALE` is acceptable: the phone's clock is off, and the till signs again as of the server's time.
   - `REPLAYED` followed by an `ok` from the same person is acceptable. Without that `ok`, look by hand.
   - Any other `bad_signature` is no-go when the row has the marker or names someone on the unit. Without either it did not come from a till: look by hand.
   - `check_failed` is no-go.
   - `unsigned` naming someone on the unit is no-go when it has the marker, because that is this code failing to sign. It is also no-go when that person had already reloaded, because their till went back to not signing.
   - `unsigned` naming someone on the unit with neither of those means a tab on older code: `wait for a reload`.
   - `unsigned` with no marker naming nobody or someone else is acceptable. It should fade in the days after a deploy.
   - Everything else, `not_entitled` among it, is `look by hand`.
2. **Check 1 has no `wait for a reload` row from the last 3 days.** That seller's next sale would be refused once, and their till would ask them to reload.
3. **Every `look by hand` row in check 1 has an explanation.** A staff member removed from a unit moments before a sale is one.
4. **Check 2 shows the same number twice.** A difference means rows are being lost and the other checks cannot be trusted. A difference of one can be a sale crossing the edge of the 24 hours, so run it again.
5. **Check 3 is 0.** A staff list the server cannot read names no staff, and those people would be refused.
6. **Every unit in check 4 is explained by hand.** A unit that sold only through an online payment link, one that belongs to another app, and one whose last sale came before the signing code went live are all explanations. A unit that sold at this till since then and has no `ok` row is not.

### Turning it on and off

The signing code and the commit with the setting must both be live. Then, on the host:

```sh
cd /opt/apps/lana-pays.us-mobile
sed -i '/^PURCHASE_SIGNATURE_REQUIRED=/d' .env && printf '\nPURCHASE_SIGNATURE_REQUIRED=on\n' >> .env
docker compose -f docker-compose.prod.yml up -d
docker logs lana-pays-mobile-web 2>&1 | grep 'purchase-auth. mode=' | tail -1
```

The last line must say `mode=refusing`. To turn it off, do the same with `=off`, and it must say `mode=logging`. The value goes in `.env`, not `.env.local`, because compose reads it from there. Deploys leave that line alone. Nothing is rebuilt, and the container is recreated in seconds.

## LANA direct (LANA neposredno): shops without a company

A shop without a company and without a bank account (KIND 30901 `payout_account` = `none`) can take LANA straight from the customer's card into its owner's Main Wallet, with the shop's margin (0 to 20 %) on top. It does not go through the brain: no reward, no quota, no Direct Fund, no Lana.Discount. The customer's card key signs the payment and its public KIND 9350 record in the till's browser. This server checks everything again, keeps the exact bytes, sends them to two Electrum servers, and publishes the record once the payment is in a block (`server/directLana.ts`). A shop with a company can never use this path.

### On the spot, and online

The till's "LANA direct" tile is the payment on the spot: the customer's card is scanned at the till. A payment link that the customer pays at home is the online payment. It is made, listed and cancelled in "$Lana-online" (`LanaOnlineTab`), and the red number of paid links not yet seen is on that tile (Brilly, 26 Nov 2026).

### No switch

Since 26 Nov 2026 there is no switch (Brilly: no switch, it works everywhere). Every shop without a company takes LANA direct as soon as its KIND 30901 says so and nothing below is missing. The old setting `app_settings.direct_lana_units` is dropped at every start, and the admin route refuses it with `NO_SUCH_SETTING`. To stop LANA direct now takes a code change.

### The receipt photo

Since 26 Nov 2026 a direct sale starts like a sale through the brain: with the receipt photo (`src/components/ReceiptStep.tsx`, at the till's "LANA direct" and at Lana-online of a shop without a company). It is uploaded (`/api/receipt/upload`), read for the amount and the invoice number (`/api/receipt/analyze`), and asked about (`/api/brain/purchase/check-dedup`, which now also asks this app's own direct sales). "No receipt" goes on without one.

The till sends `receipt_url` and `receipt_hash` with a new sale's quote or with a payment link. The server keeps them on `direct_lana_sales` and `direct_lana_links`. They never go into the signed plan or the public KIND 9350 record. A sale started before keeps its own receipt, and a link's sale takes the link's. The same photo (its hash) is never paid twice in one shop: `RECEIPT_USED` at the quote and at the submit, `RECEIPT_HAS_LINK` for a second open link, and `RECEIPT_INVALID` for a receipt that does not read. The customer's page of a link shows the receipt, as the Lana-online page does.

### What a shop needs for it

- KIND 38888 names at least two Electrum servers (port 5097), the relays, and an `fx` price for the shop's currency (EUR, GBP or USD). With fewer than two Electrum servers every direct sale is refused.
- The registrar key of this app has room: each direct sale asks the registrar four times (the card and the shop's wallet, at the quote and at the submit), twice more for each re-send, and once more after the payment is in a block.
- The shop's KIND 30901 is exactly what shop.lanapays.us option (c) signs: one `payout_account` tag, `none`; no `receiver_name`, `receiver_type`, `receiver_register`, `receiver_tax_number`, `receiver_registration_number`, `bank_*` or `payment_scheme*` tag; one `lanapays_payout_method`, `lana`; no `online_shop` other than `false`. Any of these otherwise and the shop takes no direct LANA (`UNIT_NOT_DIRECT`), whatever else it signs. It also has a readable `margin_percent` and a `lanapays_payout_wallet` that is the owner's registered, unfrozen Main Wallet, and the owner signed the event.

### Reading the journal

Table `direct_lana_sales` holds one row per attempt. It never holds a key. Its `status`:

- `quoted`: planned, nothing signed. `expired`: nobody signed it in time.
- `validating`, `broadcasting`: signed bytes kept, on their way.
- `sent`: a server answered with exactly its txid. `paid`: in a block.
- `unknown`: handed over, and no server confirmed it. Only the chain resolves it, never time: in a block it is `paid`; a coin it spends, spent by another transaction 6 blocks deep, makes it `failed`.
- `refused`: with `sent` = 0 nothing went out; with `sent` = 1 every server refused it.
- `superseded`: replaced by a payment that spends one of the same coins, so at most one of them can ever be in a block. If that replacement is refused before it was sent, the superseded row goes back to what it was (`superseded_from` keeps it): a payment that never left replaces nothing.

A payment that is `unknown`, or `refused` with `sent` = 1, may be sent again with its identical bytes, only when the seller asks, only within 30 minutes of the card's signature (`RESEND_TOO_LATE` after that), and only when every check of a submit passes again: the shop, its wallet, the register, KIND 87058, the same LANA price, nothing of the card's waiting for a block. Otherwise the seller pays again with the same card, which spends one of the same coins.

The record is published only for `paid` rows. Read it the way the checks above are read, for example:

```sql
SELECT status, sent, COUNT(*) AS n FROM direct_lana_sales GROUP BY status, sent;
SELECT id, unit_id, status, reason, txid, record_published FROM direct_lana_sales WHERE status IN ('unknown', 'refused', 'superseded') ORDER BY created_at DESC LIMIT 20;
```

Lines to look for in the container log: `[direct-lana] ALERT shop wallet frozen` (that shop's button stays off until the registrar says otherwise), `[direct-lana] ALERT attempt … cannot be marked paid` (check that sale by hand), and `[direct-lana] ALERT attempt … stays superseded by …` (its replacement was never sent; it may still be mined).

### Cash sales of a shop without a company

Such a shop has no invoices: the till sends "what was sold (#n, DD.MM.YYYY)" as the invoice number, with the unit's next sale number (`POST /api/cash-sale-number`), and the brain refuses the same text twice on one unit. A sale whose text was sent but never confirmed is kept in the till's browser (localStorage, per unit) and comes back as the same sale after a reload or a trip home. Before the seller may change its words or drop it, the till asks `POST /api/cash-sale-recorded`, which answers only what the brain's duplicate check answered (503 when the brain cannot be asked, never "not recorded").
