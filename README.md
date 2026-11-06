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
