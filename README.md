# Generic store

A generic product catalog with a cart, shipping form and **Bitcoin checkout using a watch-only Electrum wallet**. Each order reserves a receiving address; refreshing keeps the same address and BTC amount.

## Make it your own

This template uses Your Store branding, Sample Product 01–03, numbered categories and neutral image placeholders. Update `config/shop.json` and the matching product names, details, categories and artwork in `public/index.html`. Preserve product IDs, price attributes and buy markers. Edit default branding in `appearance.mjs`, or use the admin appearance editor for a running store. Prices and shipping are examples.

## Try it

Requires **Node.js 24 or newer**. From the `generic-store-page` folder, start the entire website with one command:

```sh
npm start
```

Open <http://127.0.0.1:8080>. This one server runs the catalog, cart, shipping form and payment pages. Keep the terminal open; press **Ctrl+C** to stop. No second web server or dependency installation is needed.

If port 8080 is occupied, stop the previous server before running `npm start` again. **Bitcoin checkout is enabled by default.** Review the configured products, prices and shipping before publishing.

Adding a product updates the cart count without leaving the catalog. With JavaScript disabled, the form returns to the same product with a confirmation; you can open the cart when ready.

## Automatic Electrum setup

Install the Electrum desktop application on the **same computer** as the website. Put your private `electrum.local.json` beside `package.json`:

```json
{ "masterPublicKey": "YOUR_ELECTRUM_MASTER_PUBLIC_KEY" }
```

Create this file with your own wallet configuration. It is ignored by Git and never served by the website.

Run **`npm start`**. The launcher finds installed Electrum, starts a private helper, loads your watch-only wallet and connects checkout. Existing `PAYMENT_MODE=demo` settings are migrated to Bitcoin checkout; `liveReady` no longer blocks payments. No manual daemon commands or RPC passwords are needed.

Checkout shows **Pay with Bitcoin**, then a unique address, exact BTC amount and wallet link. Existing demo orders also have a Pay with Bitcoin button. If Electrum or the exchange-rate service is unavailable, the order shows an explicit error and retry button. Ambiguous request timeouts recover the existing request without allocating another address. Detailed connection errors appear in the terminal.

Custom Electrum installations can set `electrumExecutable` in the local JSON file to their executable path.

Your original wallet is untouched. The helper uses only the public key and stores its files under ignored `data/electrum/`. Keep that directory backed up with the order database. Automatic setup currently targets Bitcoin mainnet on desktop; use the manual RPC setup for a remote wallet service or test networks.

See [START-HERE.txt](START-HERE.txt) for details, Tor hosting, confirmation policy and recovery.

The shop displays the BTC amount, receiving address and wallet link directly. There is no BTCPay dependency. Fiat prices are converted using Coinbase's public spot-price API; this price lookup does not handle funds or receive customer/order details.

Payment requests remain reserved in Electrum to prevent address reuse. The shop enforces its own quote expiry, saves amounts as integer satoshis, and verifies the request and configured confirmations (default **3**) before fulfillment. Late/partial payments and verification failures require review.

```sh
npm test
npm run orders -- list
```

Tests use simulated Electrum RPC responses. Live wallet payments and browser behavior still need testing on your host. Existing order records are preserved on upgrade; old BTCPay payments require manual handling in the previous system.

Keep `.env`, `data/`, database backups and all wallet files out of GitHub.

### Diagnose the Electrum connection

Run `npm run doctor` from the shop folder. It reports the expected personal key-file location, key checksum validity, executable discovery, helper selection and missing manual settings. It never prints the key or RPC credentials and does not start a service. The personal `electrum.local.json` is excluded from Git, so `git pull` does not install it. A missing `.env` is normal when using automatic setup. After fixing the reported configuration, restart `npm start`. Successful configuration diagnostics do not prove a live wallet connection or payment.

For a live connection check, run `npm run payment:check`. It starts or reuses the
private helper, checks wallet identity and synchronization, and requests a current
Coinbase quote without creating an order or reserving an address. It stops only a
helper it started itself. Network failures identify the service and error code;
no RPC credentials or public keys are printed. The desktop wallet's synchronization
status is separate from the shop helper's status.

### Customer accounts

The catalog's **Log in** link opens `/login`; `/register` creates a customer account
with a username and password (no email required). `/account` lists that customer's
orders with links to payment status. Guests can browse and edit the cart; checkout requires an account. Signing in
or registering claims only the guest orders belonging to the current browser
session, and preserves its cart. Orders created while logged in belong to the
account and remain accessible after signing in again, including on another device.
Logging out clears that browser session and its cart. There is no password-reset
or email-recovery feature yet; the sign-up page tells customers to save their password.

Accounts are stored in the existing private SQLite database, with salted scrypt
password hashes. Login rotates session and CSRF tokens; logout invalidates the old
session. Account routes use the same origin/CSRF checks as checkout, with persistent
per-username/session and site-wide authentication limits. Existing databases migrate
automatically; back up the database as usual. Customer accounts have no merchant
permissions. For public access use your configured onion address or HTTPS, keeping
plain loopback HTTP for local access.

### Grant or revoke administrator access

After a user registers, run these commands in the shop directory on the server,
using the same `.env` / `DATA_DIR` as the website:

```bash
npm run admin -- username
npm run admin -- username --status
npm run admin -- username --revoke
```

The first command grants admin access; the others report or revoke it. The command
requires an existing database and account, never creates a password, and does not
start Electrum. Existing accounts migrate to non-admin by default. Grants and
revocations apply on the next request, including for users already logged in.
Admins get a **Shop administration** link in their account and may open `/admin`
to read all orders and shipping details. The dashboard is read-only; payment
verification and fulfillment remain in the existing local order commands. Role
assignment is available only through this local command, not through the website.

Checkout requires login on both the shipping page and order-creation endpoint.
Customers return to checkout after signing in or registering, with their cart
preserved. Payment creation for legacy guest orders also requires login; existing
guest order records remain accessible to their original browser session.

Usernames accept punctuation, symbols, spaces and Unicode (3–32 UTF-16 code units,
matching browser input length limits). Outer spaces are removed, names are
case-insensitive, and canonically equivalent Unicode spellings use the same account.
Control characters, unpaired surrogates and bidirectional override/isolate controls
are rejected. Quote usernames with shell-special characters when running the admin
command, for example: `npm run admin -- '@store & team!'`.

### Customize appearance

Sign in as an admin, open `/admin`, and choose **Customize appearance**. The editor
at `/admin/appearance` controls page, text, border, card and button colors; heading
and body fonts; the shop name and tagline; and the catalog, sidebar, about and information
text. Fonts use local system families without remote font services. Product prices,
product definitions and payment configuration remain in their existing settings.

**Preview in new tab** renders the catalog with unsaved settings. **Save appearance**
applies changes immediately; settings persist in `shop.sqlite` across restarts.
Expand **Restore the original appearance** to reset only appearance settings.
Concurrent saves from an outdated editor are rejected to avoid overwriting another
admin's changes. Text is escaped as plain text, colors and fonts are validated, and
all preview/save/reset actions require an admin session and CSRF token. Order pages
remain read-only; appearance is editable.
