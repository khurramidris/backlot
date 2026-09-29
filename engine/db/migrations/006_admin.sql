-- Support tooling: find a customer by email, and see when they were last active.
alter table credit_accounts add column if not exists email text;
alter table credit_accounts add column if not exists created_at timestamptz not null default now();
alter table credit_accounts add column if not exists last_seen_at timestamptz not null default now();
create index if not exists credit_accounts_email_idx on credit_accounts (lower(email));
create index if not exists credit_accounts_seen_idx on credit_accounts (last_seen_at desc);
