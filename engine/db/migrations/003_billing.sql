-- Customer money. usage_events records what providers cost us; these tables record what customers pay.

-- Credit reserved when a take is queued, released or kept exactly once when it finishes.
alter table takes add column if not exists hold_usd numeric not null default 0;
alter table takes add column if not exists settled boolean not null default false;

-- Every change to a customer's balance, for support and for "where did my credits go".
create table if not exists credit_events (
  id          bigserial primary key,
  owner_id    uuid not null,
  delta_usd   numeric not null,
  reason      text not null,                 -- signup | purchase | setup_fee | render_hold | render_refund | refund
  ref         text,                          -- take id, project id, checkout session id…
  created_at  timestamptz not null default now()
);
create index if not exists credit_events_owner_idx on credit_events(owner_id, created_at desc);

-- One row per paid Stripe Checkout Session: the primary key makes webhook retries harmless.
create table if not exists payments (
  id          text primary key,              -- Stripe checkout session id
  owner_id    uuid not null,
  amount_usd  numeric not null,
  event_id    text,
  created_at  timestamptz not null default now()
);

alter table credit_events enable row level security;
alter table payments enable row level security;
