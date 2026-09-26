-- Vibe projects: a prompt drives the whole pipeline, with one checkpoint ("ready") before paid rendering.
alter table projects add column if not exists mode text not null default 'studio';    -- studio (step by step) | vibe (autopilot)
alter table projects add column if not exists stage text;                              -- writing | breakdown | casting | planning | ready | rendering | assembling | done | failed
alter table projects add column if not exists stage_error text;
alter table projects add column if not exists brief jsonb not null default '{}'::jsonb;     -- the customer's prompt and format choices
alter table projects add column if not exists autopilot jsonb not null default '{}'::jsonb; -- bookkeeping: retries, planned episodes, requested cuts, setup fee
