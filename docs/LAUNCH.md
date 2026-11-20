# Launch: go or no-go

The result of the launch audit (20 October 2026) in plain language: what was checked, what was fixed, what only
you can do before launch, and what can wait. The rule throughout: launch good enough, then fix what real customers
actually run into.

**Verdict:** the code is ready for a paid beta. What's left is in "Before you launch": accounts, one real film
with your own keys, a price check, and the legal details. None of it is code.

## What was checked

| Area | Result |
|---|---|
| Sign-in and access | Every customer route checks that the video belongs to the signed-in customer. Admin pages check the admin list. Dev sign-in and mock providers refuse to start in production (the Docker image sets `NODE_ENV=production`). |
| Files | File links are signed and expire. Storage keys can't escape their folder. With S3 storage, files are served from the storage domain, never from the app's. |
| Uploads | Uploads are size-limited and only ever opened by FFmpeg as local files. Quick-clip inputs and voices are re-encoded into fresh files, and pictures and clip inputs are content-checked before a video model sees them. A crafted playlist disguised as a picture can't make FFmpeg fetch web addresses or read the server's secrets (tested). |
| Money | Payment webhooks are signature-checked, applied once, and credit only what our config says. Credit is taken in one atomic statement, so two clicks can't overspend. Each render holds its price and settles exactly once: kept for a usable clip, refunded otherwise. Failed, timed-out and deleted renders are refunded. The end-to-end tests cover failures, outages, timeouts and cancelling renders on delete. |
| Reliability | Jobs survive restarts. See the fixes below for deploys and outages. |
| Customer pages | Every page loads without errors at desktop and phone sizes, with no sideways scrolling. Missing pages show a 404. |
| Tests | Engine unit tests, the step-by-step, prompt-to-paid-film and RunPod end-to-end suites, the GPU worker tests, and the web checks and build all pass. |

## Fixed in this audit

- **Cost reports:** Claude's price table was out of date, so writing costs on Admin were wrong.
- **2K on your own GPUs:** it was sold but can't be made there (the recipe makes 768P). It's now offered only with
  MiniMax.
- **GPU cost per shot:** each shot sent the previous shot along as a reference video, which doubles the work on your
  own GPUs. It's now off by default (`CHAIN_CLIPS`).
- **Stuck GPU jobs:** a RunPod job that timed out kept running and billing. It's now cancelled.
- **No content filter on your own H3:** MiniMax filters its own requests; your GPU doesn't. Anything a customer
  writes or uploads that reaches the video model unchanged now goes through a content check first.
- **Deploys:** a deploy used to stall films that were mid-step for 20 minutes, and a slow writing step could run twice.
  Now running steps get 20 seconds to finish and anything cut off resumes within about 3 minutes. A step that keeps
  crashing the server stops after its attempts and refunds, instead of retrying forever.
- **Two servers starting at once** could collide on database updates and crash-loop. They now take turns.
- **Video service down:** a film where no shot could be filmed used to be delivered as a film of placeholder cards.
  It now fails with "None of the shots could be filmed just now. You weren't charged for video", and **Try again**
  films it once the service is back.
- **Small things:** the landing page and sign-up now mention quick clips; a link to a deleted video says "not found"
  at once instead of after 8 seconds; clip titles stop at a word.

## Before you launch (only you can do these)

Work through `docs/BETA.md`. In short:

- [ ] Accounts and keys: Anthropic, MiniMax, Supabase (with your own email sender), Lemon Squeezy (test mode first),
      Railway. Put your user id in `ADMIN_USER_IDS`.
- [ ] **Setup check** (`/setup`) all green.
- [ ] **One real film and one real clip with your own keys.** Judge the quality, then open **Admin → Where the money
      goes**.
- [ ] **Price check.** The $2 setup fee (`SETUP_FEE_USD`) pays for the writing. At `STORY_EFFORT=high`, Claude can
      cost $1 to $3 a film. If Admin shows writing costing more than the fee, raise the fee or lower the effort.
      Also compare the cost of a second of video with the $0.16 you charge.
- [ ] **Video for customers:** keep `VIDEO_PROVIDER=minimax` until your own H3 has made good films for you
      (`docs/SELF-HOSTED-H3.md`). It has never run on a real GPU yet.
- [ ] Lemon Squeezy: run the launch check in `docs/DEPLOY.md` section 5, then switch to live mode ("Going live" in
      `docs/BETA.md`). Only share Backlot's own **Billing** page for buying. A purchase through the product's public
      Lemon Squeezy link isn't tied to an account, so you'd have to grant it by hand on Admin.
- [ ] Legal: your company details in `web/src/lib/legal.ts`, and a lawyer's review of `/terms` and `/privacy`
      before real money.
- [ ] Recommended: `SENTRY_DSN` (error emails) and `FIXED_COSTS_MONTHLY` (your monthly bills, so Admin shows true profit).

## Known limits you can launch with

Fix these when customers actually hit them, not before.

- A refund issued in Lemon Squeezy doesn't take the credit back. `docs/DEPLOY.md` has the one-line fix by hand.
- Rate limits are per server. That's fine while you run one.
- GPU cost on Admin counts render time only. Cold starts and idle minutes show on the RunPod bill, so check it
  monthly.
- Some things are done by hand for now: there's no "your film is ready" email, account deletion is by support email,
  and the approval step can't edit the script or cast.
- On your own H3, image-to-video is beta. If those clips look wrong, set `CLIP_IMAGE_PROVIDER=minimax`. The dialogue
  tag format is unverified until the first real film.
- A double-click that lands at the same instant can start two versions of one shot. Both are delivered and both
  are charged.
- A writing or picture step cut off by a deploy is charged again when it reruns. That's cents, and rare.
- If two subscription updates from Lemon Squeezy arrive out of order seconds apart, a status can be stale until the
  next update. Admin's "payment problems" would show it.

## After launch: the weekly look

Every day, open the ops dashboard's **Overview** (docs/DEPLOY.md, "The ops dashboard"): its "Needs you" list says what
to look at first. Once a week, open **Admin** (or the dashboard's Business page) on the 7-day view:
- **Profit and margin:** is video cost per second well under the price? Is writing cost per film under the setup
  fee?
- **Problems:** many failed renders points to a provider problem. Many refusals means the content check may be too
  strict, so read a few.
- **Health:** renders waiting and failed jobs should be near zero outside busy moments.
- **Customers:** cancellations and payment problems: write to those people.
