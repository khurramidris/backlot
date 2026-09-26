-- Basic subscription (Lemon Squeezy) and storage quota.

-- Two credit buckets: plan_usd is this month's plan credit (reset at every renewal), balance_usd holds
-- top-ups and refunds, which never expire. Spending takes plan credit first.
alter table credit_accounts add column if not exists plan_usd numeric not null default 0;

-- One row per Lemon Squeezy subscription, kept current by its webhooks.
create table if not exists subscriptions (
  id           text primary key,                  -- Lemon Squeezy subscription id
  owner_id     uuid not null,
  customer_id  text,
  variant_id   text,
  status       text not null,                     -- on_trial | active | paused | past_due | unpaid | cancelled | expired
  renews_at    timestamptz,
  ends_at      timestamptz,                       -- set once cancelled: access continues until then
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists subscriptions_owner_idx on subscriptions(owner_id, updated_at desc);

-- Every stored object that belongs to a project, so usage can be summed per customer and a
-- deleted project really frees its space.
create table if not exists files (
  key         text primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  owner_id    uuid not null,
  bytes       bigint not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists files_owner_idx on files(owner_id);
create index if not exists files_project_idx on files(project_id);

alter table subscriptions enable row level security;
alter table files enable row level security;
