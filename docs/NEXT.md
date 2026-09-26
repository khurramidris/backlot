# NEXT: resume here

**Status (2026-09-26):** planned and approved by the founder, NOT started. Nothing below is built yet.
Founder decisions: Lemon Squeezy (not Stripe); Basic plan $20/month required to create; includes $20 credits/month
(expire at renewal) + 50 GB storage; top-up packs for subscribers never expire.
Work through it top to bottom; commit + push after each green step; delete this file when done.

---


## Context
Backlot's billing is built on one-off Stripe credit packs, but the founder has chosen a different model:
- **Lemon Squeezy** instead of Stripe. It's a Merchant of Record: it handles VAT and sales tax, which suits a
  solo founder.
- **Basic subscription, $20/month.** Required to create anything. Each month it includes **$20 of credits**
  (unused ones expire at renewal) and **50 GB of storage**.
- **Top-up credit packs** for subscribers. These never expire.

Also still missing before launch (step 4): forgot password, an account page, and Terms / Privacy pages.
Outcome: a subscriber can sign up, subscribe, make videos within their credits and storage, top up, manage or
cancel their plan, and reset their password.

## Money model (engine)
**Two credit buckets** on `credit_accounts`:
- New `plan_usd` column: monthly plan credits.
- Existing `balance_usd` column: top-ups.

**Spending, plan credits first:** `debit()` in `engine/src/billing.ts` becomes one atomic statement:
```sql
update credit_accounts set plan_usd = greatest(plan_usd - $x, 0),
       balance_usd = balance_usd - greatest($x - plan_usd, 0)
where owner_id = $o and plan_usd + balance_usd >= $x
```
Postgres evaluates the right-hand sides against the old row, so this is exact.

**Refunds** for failed renders go to `balance_usd`: they never expire, which is customer-friendly.

**Renewal:** on each paid subscription invoice, `plan_usd` is **reset** to `PLAN_CREDITS_USD` (20), not added
to. The ledger records `plan_expired` (−unused) and `plan_credit` (+20).

**Subscription required:** `/v1/create`, produce, retake and uploads return 402 `subscription_required`
without an active plan.
- "Active" means: `active`, `on_trial` or `past_due` (a grace period), or `cancelled` with `ends_at` still in
  the future.
- The gate only applies when `ENFORCE_CREDITS` is on (production), so local dev and mock tests stay free.

The setup fee ($0.50 per video) stays, and comes out of the same buckets.

**Stripe removal:** all Stripe code, config and tests go, replaced by Lemon Squeezy.

## Lemon Squeezy (engine, new `engine/src/lemonsqueezy.ts`)
**Config:**
- `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`
- `LEMONSQUEEZY_BASIC_VARIANT_ID`
- `CREDIT_PACKS=starter:10:<variantId>,creator:50:<variantId>,…`. The credited amount comes from our config,
  looked up by variant id, never from the amount paid (which includes tax).

**Checkout:** `POST https://api.lemonsqueezy.com/v1/checkouts` (JSON:API), with:
- store and variant relationships
- `checkout_data.custom.user_id`
- `checkout_data.email` (from the signed-in session when known)
- `product_options.redirect_url = APP_URL/billing?paid=1`

It returns `data.attributes.url`. Routes:
- `POST /v1/billing/subscribe`
- `POST /v1/billing/topup {pack}` (subscribers only)

**Webhook `POST /webhooks/lemonsqueezy`:**
- **Verification:** `X-Signature` = hex HMAC-SHA256 of the raw body with the signing secret, compared in
  constant time.
- **Owner:** `meta.custom_data.user_id`, falling back to a lookup by subscription id.
- **Events:**
  - `subscription_created` / `subscription_updated` / `cancelled` / `resumed` / `expired` / `paused` /
    `unpaused`: upsert into a new `subscriptions` table (owner, LS subscription id, customer id, status,
    variant, `renews_at`, `ends_at`). `expired` also zeroes `plan_usd`.
  - `subscription_payment_success` (a subscription invoice, `status = paid`): reset plan credits.
  - `order_created` with `status = paid` and a pack variant: add top-up credit. Orders for the plan variant
    are ignored; the invoice handles those.
- **Idempotency:** the existing `payments` table, keyed `ls:invoice:<id>` / `ls:order:<id>`, so retries never
  credit twice.

**Customer portal:** `GET /v1/billing/portal` fetches the subscription from the LS API and returns its fresh
signed `urls.customer_portal`. That's where customers update their card, see invoices and cancel.

## Storage quota (engine)
**New `files` table** (migration `005_plans_storage.sql`, together with `plan_usd` and `subscriptions`):
`key` (primary key), `project_id` (cascade delete), `owner_id`, `bytes`.

**Tracking at the chokepoints:**
- `storage.put` / `storage.putFile` in `engine/src/storage.ts` record any `projects/<id>/…` key.
- `pollTake` records RunPod direct uploads, using the ffprobe size.
- `storage.del` removes the row.

**Deleting a project now actually frees the space:** its storage objects are deleted (from `files`) before the
rows cascade. This also fixes the old orphaned-files problem.

**Quota:**
- `PLAN_STORAGE_GB` (default 50). Usage = `sum(bytes)` per owner.
- Checked at create, produce, retake and uploads. When over, return 402 `storage_full`: "You're using 50.3 of
  50 GB. Delete old videos to make room."
- It's a soft limit: a render already in progress is never broken.

**`GET /v1/me`** adds `plan` (status, `renews_at`, `ends_at`, active), `storage` (used and quota bytes), and
`credits` (plan, top-up, total).

## Web
- **`/billing`** (replaces `/credits`):
  - Not subscribed: a Basic plan card ($20/mo → $20 credits monthly + 50 GB) with "Subscribe".
  - Subscribed: plan status and renewal date, "Manage subscription" (portal), a storage bar, credits split
    into "monthly (expire {date})" and "top-up", and top-up packs.
  - After a payment redirect, it shows a toast and polls.
- **Dashboard:** without an active plan (when enforced), the create box shows a "Subscribe to start creating"
  panel instead.
  - Each video card gets a delete action with confirmation, so customers can free storage.
  - The nav shows the credit total and links to Billing and Account.
- **`/account`:** email, change email (`supabase.auth.updateUser({ email })`), change password
  (`updateUser({ password })`), a storage summary with a link to Billing, and sign out.
- **Forgot password:** a "Forgot password?" link on `/auth` calls
  `resetPasswordForEmail(email, { redirectTo: origin + '/reset-password' })`. The new public `/reset-password`
  route waits for Supabase's `PASSWORD_RECOVERY` session and sets the new password.
- **`/terms` and `/privacy`:** public pages with plain-language drafts covering:
  - Lemon Squeezy as Merchant of Record, and the subscription, cancellation and credit rules
  - failed renders are refunded automatically
  - AI content and acceptable use (no real people without consent, no sexual content involving minors, no
    impersonation)
  - customer ownership of outputs, storage and retention, and deletion
  - what we store and which processors: Supabase, Railway, RunPod, Anthropic, MiniMax, Lemon Squeezy

  They're linked from the landing footer and the sign-up form. **Flagged in the final report as needing a
  lawyer's review**, with placeholders for the legal entity and jurisdiction.
- **Landing:** a pricing section (Basic $20/mo: $20 of credits every month, 50 GB, top-ups anytime).

## Tests
- **`engine/test/vibe.e2e.ts`** is rewritten around Lemon Squeezy, using signed webhooks built in the test:
  - No plan → `/v1/create` 402 `subscription_required`.
  - Forged signature → 400.
  - `subscription_created` + `subscription_payment_success` → plan active with $20.
  - A replayed invoice doesn't double the credit.
  - A second invoice (renewal) → plan credit **reset** to $20, not $40.
  - `order_created` for a pack → +$10 top-up; spending uses plan credits first.
  - Storage usage grows after a render; a fake oversized file row → `storage_full`; deleting the project frees
    the rows and objects.
  - `expired` → access blocked.
  - The existing flow checks: prompt → ready → produce → exact charge → fix-a-shot.
- **Unit tests:** LS signature verification; the two-bucket debit arithmetic.
- **Regression:** `test/e2e.ts` and `test/runpod.e2e.ts` must pass unchanged (credits not enforced → no gate).
- **Web:** typecheck, lint, tests, build. Screenshots in headless Edge of billing (subscribed and not),
  account, forgot and reset password, terms, privacy, and the dashboard subscribe panel.
- **CI green on GitHub.** Push after each green step.

## Docs
`engine/env.sample`, `docs/DEPLOY.md` (a Lemon Squeezy section replaces Stripe: create the store, the Basic
subscription product, the credit-pack products, the webhook URL and events), `docs/ARCHITECTURE.md`,
`CLAUDE.md`.

## Needs the founder afterwards
- A Lemon Squeezy store (test mode first), with a $20/month "Basic" product and credit-pack products. Copy their
  variant ids into env.
- A lawyer's pass over Terms and Privacy.
