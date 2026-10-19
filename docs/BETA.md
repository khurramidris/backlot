# Launching the private beta

This is the plain-language checklist for getting Backlot live for your first testers. The code is done. What's
left is creating accounts, pasting keys into one place (Railway), and checking it works.

**Time:** about one afternoon, plus waiting for sign-ups to be approved.
**How you'll know it's ready:** the **Setup check** page on your site shows everything green (step 8).

## The plan for the beta
- **No real money yet.** Lemon Squeezy stays in **test mode**. Testers "pay" with Lemon Squeezy's test card
  (`4242 4242 4242 4242`, any future date, any 3 digits). They get the full product, and nobody is charged.
  Live payments come later, once you've watched real costs for a couple of weeks.
- **Video comes from MiniMax's hosted H3** (`VIDEO_PROVIDER=minimax`). Our own RunPod GPUs wait until the H3
  model is wired in.
- **Use Railway's free web address** (like `backlot-production.up.railway.app`) to begin with. A custom domain can
  come later (step 10).

## What's blocking launch
| # | What | Who | Time |
|---|---|---|---|
| 1 | Anthropic account and key (writes the scripts) | you | 10 min |
| 2 | MiniMax account and key (images, voices, video) | you | 15 min |
| 3 | Supabase project (sign-in, database, file storage) | you | 30 min |
| 4 | An email sender for sign-in emails (Resend) | you | 15 min |
| 5 | Lemon Squeezy store in test mode (subscriptions) | you | 30 min |
| 6 | Railway (runs the site) | you | 20 min |
| 7 | Make yourself admin | you | 5 min |
| 8 | Setup check page all green | you, then me for anything odd | 10 min |
| 9 | Your own test film, and look at the costs | you | 30 min |
| 10 | Legal details on the Terms and Privacy pages | you send me 4 details | 5 min |
| 11 | Invite testers | you | — |

Keep a private note open as you go (not in the repo, never in chat logs you share). Each step gives you a
value to paste into Railway in step 6. The name in `CAPITALS` is the setting's name.

---

## 1. Anthropic (the AI that writes scripts and plans shots)
1. Go to **console.anthropic.com** and sign up.
2. **Billing**: add a card and buy some credit. $50 is plenty for the beta.
3. **API keys → Create key**. Name it "backlot". Copy it.
   - Save as `ANTHROPIC_API_KEY`.
4. **Settings → Limits**: note your monthly spend cap ($500 on the Start tier). When it's reached, Claude stops answering
   until the 1st of the next month, so new films fail. Writing one film costs about $1–2; request a tier increase there
   well before you get close.

## 2. MiniMax (cast and set images, voices, and the video itself)
1. Go to **minimax.io**, open the **API platform**, and sign up.
2. Add balance (top up). Video is the main cost, so start with $50–100 and watch it.
3. Create an **API key** and copy it.
   - Save as `MINIMAX_API_KEY`.
   - If your account is on the China site (minimaxi.com), also save `MINIMAX_BASE_URL=https://api.minimaxi.com`.
4. Also save `VIDEO_PROVIDER=minimax`.

## 3. Supabase (sign-in, database, file storage)
1. Go to **supabase.com** → **New project**.
   - Pick the region closest to your customers.
   - Save the database password somewhere safe.
   - Choose the **Pro plan ($25/month)**. The free plan only stores 1 GB of files, which a few videos use up.
2. **Project Settings → API**: copy the **Project URL** and the **anon / publishable key**.
   - Save as `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. **Connect** (top bar) → **Session pooler**: copy the connection string, and put your database password into
   it where it says `[YOUR-PASSWORD]`.
   - Save as `DATABASE_URL`.
4. **Storage → New bucket**: name it `backlot` and leave it **private** (not public).
5. **Storage → S3 connection** (Project Settings → Storage): copy the **endpoint** and the **region**, then
   **New access key** and copy both keys.
   - Save as `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
   - Also save `S3_BUCKET=backlot` and `STORAGE_DRIVER=s3`.
6. **Authentication → Sign In / Providers**: Email is on. Make sure **Confirm email** is on too.
   - Google sign-in is optional. You can skip it for the beta: the "Continue with Google" button only appears on the
     sign-in page once Google is switched on here.
   - If you want it, you'll need a Google Cloud OAuth client; `docs/DEPLOY.md` step 1 covers it.
7. **Authentication → URL Configuration** (fill in after step 6, once you have the Railway address):
   - **Site URL:** `https://<your-railway-address>`
   - **Redirect URLs**, add all three:
     - `https://<your-railway-address>/dashboard`
     - `https://<your-railway-address>/reset-password`
     - `https://<your-railway-address>/account`

## 4. Email sender (so sign-up and password emails actually arrive)
Supabase's built-in email only sends a few messages an hour, so testers would get stuck.
1. Go to **resend.com** and sign up. The free plan is fine.
2. **Domains**: add a domain you own and follow the DNS instructions.
   - No domain yet? Resend's test sender only mails your own address, so buy a domain first (step 10) or ask me
     for another option.
3. **API Keys → Create**. Copy it.
4. In **Supabase → Authentication → Emails → SMTP Settings**, turn on custom SMTP and enter:
   - Host `smtp.resend.com`, port `465`, username `resend`, password: the Resend key.
   - Sender: something like `hello@yourdomain.com`, name "Backlot".

## 5. Lemon Squeezy (subscriptions, in test mode)
1. Go to **lemonsqueezy.com**, sign up, and create a store. Keep the **Test mode** switch (bottom left) **on**.
2. **Settings → Stores**: note the store's number (e.g. `12345`).
   - Save as `LEMONSQUEEZY_STORE_ID`.
3. **Products → + New product**: name "Backlot Basic", pricing **Subscription**, **$20** every **1 month**.
   Publish it.
4. Three more products, pricing **Single payment**: "Starter credits" $10, "Creator credits" $50, "Studio credits"
   $200. Publish them.
   - Each product has a "variant id" the site needs. Don't dig for them in the dashboard: the Setup check page
     (step 8) lists your products with their ids. You'll copy them from there into
     `LEMONSQUEEZY_BASIC_VARIANT_ID` and `CREDIT_PACKS=starter:10:<id>,creator:50:<id>,studio:200:<id>`.
5. **Settings → API → +**: create a key and copy it.
   - Save as `LEMONSQUEEZY_API_KEY`.
6. **Settings → Webhooks → +**:
   - **URL:** `https://<your-railway-address>/webhooks/lemonsqueezy` (fill in after step 6).
   - **Signing secret:** make up a long random string (at least 32 letters and numbers) and save it.
     - Save as `LEMONSQUEEZY_WEBHOOK_SECRET`.
   - **Events:** tick `order_created` and every `subscription_…` event (created, updated, cancelled, resumed,
     expired, paused, unpaused, payment_success).
7. **Settings → Customer portal**: turn it on, and allow cancelling and updating the payment method.

## 6. Railway (runs the website)
1. Go to **railway.com** and sign up with your GitHub account.
2. **New Project → Deploy from GitHub repo → khurramidris/backlot**. It starts building. The first build fails
   or crashes: that's expected, because the settings aren't there yet.
3. Open the service → **Settings → Networking → Generate Domain**. This is your address
   (e.g. `backlot-production.up.railway.app`).
   - Now go back and finish Supabase step 3.7 and the Lemon Squeezy webhook URL (5.6).
4. Open **Variables → Raw Editor** and paste everything you saved, plus these:
   ```
   NODE_ENV=production
   PUBLIC_BASE_URL=https://<your-railway-address>
   APP_URL=https://<your-railway-address>
   CORS_ORIGINS=https://<your-railway-address>
   FILE_SIGNING_SECRET=<another long random string, at least 32 characters>
   ```
   Don't add `MOCK_PROVIDERS` or `ALLOW_DEV_TOKENS`: they're for development only, and the site refuses to start
   with them.
5. Railway redeploys by itself. When it's done, open `https://<your-railway-address>/health`. It should say
   `{"ok":true,"mock":false}`.

## 7. Make yourself admin
1. Open your site, **Get started**, and sign up with your own email. Confirm it from the email.
2. Go to **Account**. At the bottom, click **Your user id** to copy it.
3. In Railway → Variables, add `ADMIN_USER_IDS=<your user id>`. It redeploys.

## 8. Setup check
1. Refresh the site. A **Setup check** item appears in the sidebar (admins only). Open it.
2. It tests every key and setting for real. Fix anything **red**; each line says how. Amber lines are notes.
   - Under Payments, **Your products** lists each Lemon Squeezy product with its variant id. Copy them into
     `LEMONSQUEEZY_BASIC_VARIANT_ID` and `CREDIT_PACKS` in Railway (see step 5.4), then wait for the redeploy.
3. Press **Check again** until nothing is red. If a red line doesn't make sense, paste it to me.

## 9. Your own test film
1. Go to **Billing → Subscribe** and pay with the test card `4242 4242 4242 4242`. Billing should show the plan
   as active with $20 of credit within a few seconds.
2. On **Home**, type a one-sentence story and press **Create**. After a few minutes it stops at "Ready for your
   approval" with the script, cast and price.
3. Press **Make my video** and wait for "Finished". Play it and download it.
4. Try **Fix this shot** on one shot, **Buy** a top-up pack (test card again), and **Forgot password**.
5. **Look at the costs:** check the Anthropic console, the MiniMax balance and Supabase storage before and after
   one film. Tell me the numbers and I'll check the pricing still makes money.

## 10. Legal details and a domain
1. Send me:
   - your company's legal name
   - the country or state it's registered in
   - its address
   - a support email
   I'll put them into the Terms and Privacy pages.
   A lawyer's review can wait for a small invite-only beta. Do it before you take real money.
2. **Domain (optional for beta):** buy one (e.g. at Cloudflare or Namecheap). In Railway → Settings →
   Networking → Custom Domain, add it and follow the DNS instructions. Then:
   - Change `PUBLIC_BASE_URL`, `APP_URL` and `CORS_ORIGINS` to the new address.
   - Update the Supabase Site URL and Redirect URLs (3.7) and the Lemon Squeezy webhook URL (5.6).
   - Run the Setup check again.

## 10b. Error alerts (optional, 10 minutes, recommended)
So you hear about problems before testers tell you:
1. Go to **sentry.io** and sign up. The free plan is enough.
2. Create a project and choose **Node.js**. Copy the **DSN** (a long address that starts with `https://`).
3. In Railway → Variables, add `SENTRY_DSN=<the DSN>`.
From then on, Sentry emails you when something breaks, such as a render that fails for good or a server error.

## 11. Invite testers
Send each tester:
- the link to your site
- "Sign up, then on Billing pay with the test card 4242 4242 4242 4242 (any future date, any CVC). Nothing is
  charged during the beta."
- where to send feedback (an email address or a WhatsApp group)

Start with 10–20 people. The **Admin** page (sidebar, admins only) shows the week at a glance:
- paying customers, films finished and failed, money in and AI costs out
- recent failures, and every customer

Click a customer to see their films, what each cost you against what they paid, and their credit history. You
can also **give or take back credit** there with a note, for example if a film came out badly.

Also keep an eye on the MiniMax balance, and send me anything that looks wrong.

## Going live with real payments (later)
1. **Lemon Squeezy:** activate the store (they verify your identity, which can take a few days), then switch Test
   mode **off**.
2. Live mode has its own API key, products and webhook. Repeat step 5 in live mode and replace the five
   `LEMONSQUEEZY_*` / `CREDIT_PACKS` values in Railway.
3. Get the lawyer's review of Terms and Privacy done first.
4. Run the Setup check: the webhook line turns from amber ("test mode") to green ("live mode").

## Monthly running costs during the beta (rough)
- **Railway:** $5–20
- **Supabase Pro:** $25
- **Resend:** free
- **Lemon Squeezy:** no monthly fee (a cut of each real sale later)
- **Anthropic and MiniMax:** pay per use. Video is the big one; you'll see the real per-film cost in step 9.
