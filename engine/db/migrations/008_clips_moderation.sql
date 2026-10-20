-- Quick clips (text, an image, references or a video to remix → one clip) reuse projects/episodes/shots/takes with
-- mode = 'clip' and format = 'clip'; what the customer typed and uploaded lives in projects.brief.

-- Verdicts of the content check that runs before customer-written prompts and uploads reach a video model. Keyed by a
-- hash of what was checked, so a retry or a retake with the same prompt isn't checked (or paid for) twice.
create table if not exists moderations (
  hash        text primary key,
  allowed     boolean not null,
  category    text,
  reason      text,
  created_at  timestamptz not null default now()
);
alter table moderations enable row level security;

-- The company dashboard reads these by date across all customers.
create index if not exists usage_events_created_idx on usage_events(created_at);
create index if not exists payments_created_idx on payments(created_at);
create index if not exists takes_created_idx on takes(created_at);
create index if not exists projects_created_idx on projects(created_at);
