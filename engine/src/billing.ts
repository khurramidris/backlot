// Customer money: credit balance, atomic holds for renders, a ledger of every change, and
// Stripe Checkout for top-ups. Provider costs (what we pay) live in usage_events instead.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './db.js';
import { config } from './config.js';
import { PermanentError } from './queue.js';

type Tx = typeof sql | any; // postgres.js transaction handle

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Customer price for rendered video. */
export const sellPrice = (resolution: string, seconds: number) =>
  round((config.credits.sellPerSecond[resolution] ?? config.credits.sellPerSecond['768P']) * seconds);

/** Create the account the first time we see a user, granting the signup credit exactly once. */
export async function ensureAccount(ownerId: string) {
  const [created] = await sql`insert into credit_accounts (owner_id, balance_usd) values (${ownerId}, ${config.credits.signupUsd})
    on conflict (owner_id) do nothing returning owner_id`;
  if (created && config.credits.signupUsd > 0) await sql`insert into credit_events (owner_id, delta_usd, reason) values (${ownerId}, ${config.credits.signupUsd}, 'signup')`;
}

export async function balanceOf(ownerId: string): Promise<number> {
  const [a] = await sql`select balance_usd from credit_accounts where owner_id = ${ownerId}`;
  return a ? Number(a.balance_usd) : 0;
}

/** Take credit in one statement, so concurrent requests can't spend the same balance. Returns what was taken. */
export async function debit(tx: Tx, ownerId: string, usd: number, reason: string, ref?: string): Promise<number> {
  usd = round(usd);
  if (!config.credits.enforce || usd <= 0) return 0;
  const [ok] = await tx`update credit_accounts set balance_usd = balance_usd - ${usd}, updated_at = now()
    where owner_id = ${ownerId} and balance_usd >= ${usd} returning owner_id`;
  if (!ok) {
    const bal = await balanceOf(ownerId);
    throw new PermanentError(`Not enough credit: this needs $${usd.toFixed(2)} and your balance is $${bal.toFixed(2)}.`, 'insufficient_credit');
  }
  await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${ownerId}, ${-usd}, ${reason}, ${ref ?? null})`;
  return usd;
}

export async function credit(tx: Tx, ownerId: string, usd: number, reason: string, ref?: string) {
  usd = round(usd);
  if (usd <= 0) return;
  await tx`insert into credit_accounts (owner_id, balance_usd) values (${ownerId}, ${usd})
    on conflict (owner_id) do update set balance_usd = credit_accounts.balance_usd + ${usd}, updated_at = now()`;
  await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${ownerId}, ${usd}, ${reason}, ${ref ?? null})`;
}

/** Close a take's hold exactly once: a good take keeps it, anything else gets it back. */
export async function settleTake(takeId: string, succeeded: boolean) {
  await sql.begin(async (tx) => {
    const [t] = await tx`update takes set settled = true where id = ${takeId} and not settled returning hold_usd, project_id`;
    if (!t || succeeded || !(Number(t.hold_usd) > 0)) return;
    const [p] = await tx`select owner_id from projects where id = ${t.project_id}`;
    if (p) await credit(tx, p.owner_id, Number(t.hold_usd), 'render_refund', takeId);
  });
}

// ───────── Stripe (plain REST; no SDK) ─────────

export async function createCheckout(ownerId: string, packId: string) {
  const pack = config.credits.packs.find((p) => p.id === packId);
  if (!pack) throw new PermanentError(`Unknown credit pack. Choose one of: ${config.credits.packs.map((p) => p.id).join(', ')}.`, 'bad_input');
  if (!config.stripe.secretKey || !config.stripe.appUrl) throw new PermanentError('Payments are not set up yet.', 'config');
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: `${config.stripe.appUrl}/credits?paid=1`,
    cancel_url: `${config.stripe.appUrl}/credits`,
    client_reference_id: ownerId,
    'metadata[owner_id]': ownerId,
    'metadata[pack]': pack.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(pack.usd * 100)),
    'line_items[0][price_data][product_data][name]': `Backlot credits: $${pack.usd}`,
  });
  const r = await fetch(`${config.stripe.apiBase}/v1/checkout/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`Stripe checkout failed (${r.status}): ${j.error?.message || 'no url returned'}`);
  return { url: j.url as string, id: j.id as string };
}

/** Stripe-Signature: "t=<unix>,v1=<hex hmac of `${t}.${body}`>[,v1=…]". Five-minute tolerance against replays. */
export function verifyStripeSignature(raw: string, header: string, secret: string, nowSec = Date.now() / 1000) {
  const parts = header.split(',').map((kv) => kv.trim().split('='));
  const t = +(parts.find(([k]) => k === 't')?.[1] || 0);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v || '');
  if (!t || Math.abs(nowSec - t) > 300 || !sigs.length) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  return sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && timingSafeEqual(b, expected); });
}

/** Credit a paid Checkout Session. Keyed by session id, so retried or duplicate events credit once. */
export async function handleStripeEvent(evt: any) {
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt?.type)) return { ignored: evt?.type ?? 'unknown' };
  const s = evt.data?.object || {};
  if (s.payment_status !== 'paid') return { ignored: 'not paid yet' };
  const ownerId = s.metadata?.owner_id || s.client_reference_id;
  const usd = Number(s.amount_subtotal ?? s.amount_total ?? 0) / 100; // what the pack cost, before any tax
  if (!UUID.test(String(ownerId)) || !(usd > 0) || String(s.currency).toLowerCase() !== 'usd') return { ignored: 'unusable session' };
  return sql.begin(async (tx) => {
    const [paid] = await tx`insert into payments (id, owner_id, amount_usd, event_id) values (${s.id}, ${ownerId}, ${usd}, ${evt.id ?? null})
      on conflict (id) do nothing returning id`;
    if (!paid) return { duplicate: true };
    await credit(tx, ownerId, usd, 'purchase', s.id);
    return { credited: usd };
  });
}
