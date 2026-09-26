-- Reelwright Studio Engine — initial schema.
-- Runs on any Postgres 14+, including Supabase. Idempotent: safe to re-run.
-- In Supabase: paste into the SQL editor, or let the engine apply it on boot (AUTO_MIGRATE=1).

create extension if not exists pgcrypto;

-- ─────────────────────────── projects & script ───────────────────────────

create table if not exists projects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null,                         -- Supabase auth.users.id
  title        text not null default 'Untitled',
  format       text not null default 'micro',         -- micro | film | series
  aspect       text not null default '9:16',          -- H3 ratio: 9:16 | 16:9 | 21:9 | 4:3 | 1:1 | 3:4
  resolution   text not null default '768P',          -- H3 render resolution for takes: 768P | 2K
  language     text not null default 'English',       -- spoken dialogue language
  style        jsonb not null default '{}'::jsonb,    -- look, camera, lighting, grade, palette, negative
  story_bible  jsonb not null default '{}'::jsonb,    -- characters (voice/want/secret…), world, themes
  settings     jsonb not null default '{}'::jsonb,    -- chain_clips, burn_subtitles, image_provider, budget_usd…
  status       text not null default 'imported',      -- imported | breaking_down | assets | planning | rendering | review | assembling | done
  source       jsonb,                                  -- original import payload (for re-runs)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists projects_owner_idx on projects(owner_id, updated_at desc);

create table if not exists episodes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  idx         int  not null,
  label       text not null default '',
  title       text not null default '',
  script      text not null default '',                -- Fountain
  status      text not null default 'script',         -- script | planned | rendering | review | approved | assembled
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, idx)
);

create table if not exists scenes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  episode_id    uuid not null references episodes(id) on delete cascade,
  idx           int  not null,                         -- order within episode
  heading       text not null,
  int_ext       text not null default '',              -- INT | EXT | INT/EXT
  location_raw  text not null default '',              -- as written in the heading
  time_of_day   text not null default '',              -- DAY | NIGHT | DAWN | …
  body          text not null default '',              -- full Fountain text of the scene
  characters    text[] not null default '{}',          -- character keys present
  speakers      text[] not null default '{}',          -- character keys with dialogue
  location_asset_id uuid,                              -- resolved set variant used for this scene
  looks         jsonb not null default '{}'::jsonb,    -- {CHARACTER_KEY: look asset id} worn in this scene
  props         text[] not null default '{}',          -- prop keys that appear in this scene
  est_seconds   int  not null default 0,
  unique (episode_id, idx)
);
create index if not exists scenes_project_idx on scenes(project_id);

-- ─────────────────────────── production assets ───────────────────────────
-- One row per locked reference: a character master, a character look (wardrobe),
-- a set (location master), a set variant (night / reverse angle / sub-area), a prop,
-- or a character voice. Variants point at their parent and are generated FROM it,
-- so identity carries over.

create table if not exists assets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  kind          text not null check (kind in ('character','look','location','set_variant','prop','voice')),
  key           text not null,                         -- stable id, e.g. ASMA, RIZVI_STORE, RIZVI_STORE/NIGHT
  parent_id     uuid references assets(id) on delete cascade,
  name          text not null default '',
  description   text not null default '',              -- the visual lock text used in every prompt
  prompt        text not null default '',              -- generation prompt (editable)
  recurring     boolean not null default false,        -- appears in 2+ scenes or 2+ episodes
  appearances   int not null default 0,                -- scene count
  episodes      int[] not null default '{}',           -- episode idx list
  priority      int not null default 0,                -- higher = generate first / hero treatment
  status        text not null default 'planned',       -- planned | generating | review | approved | failed
  file_key      text,                                  -- current candidate in storage
  mime          text,
  history       jsonb not null default '[]'::jsonb,    -- previous candidates [{file_key, at, note}]
  meta          jsonb not null default '{}'::jsonb,    -- voice_id, provider, seed, width/height, consent…
  error         text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, kind, key)
);
create index if not exists assets_project_idx on assets(project_id, kind);

-- ─────────────────────────── shots, takes, cuts ───────────────────────────
-- A shot = one H3 generation (4–15 s) that may contain 2–4 hard cuts inside it.
-- A take = one attempt at rendering a shot. The customer approves exactly one take.

create table if not exists shots (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  episode_id    uuid not null references episodes(id) on delete cascade,
  scene_id      uuid references scenes(id) on delete set null,
  idx           int  not null,                         -- order within episode
  code          text not null default '',              -- human id, e.g. 2.3 = scene 2, shot 3
  duration      int  not null,                         -- seconds, 4–15
  plan          jsonb not null default '{}'::jsonb,    -- beats [{t0,t1,shot,camera,action,dialogue:[{who,line}]}], sound, mood
  prompt        text not null default '',              -- compiled H3 text prompt (editable)
  prompt_locked boolean not null default false,        -- true once a human edited the prompt by hand
  asset_ids     uuid[] not null default '{}',          -- references in order (location, characters/looks, props)
  voice_ids     uuid[] not null default '{}',          -- voice assets for reference_audio
  chain_prev    boolean not null default false,        -- pass the previous approved clip as reference_video
  status        text not null default 'planned',       -- planned | queued | rendering | review | approved | failed | blocked
  approved_take_id uuid,
  review_note   text,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (episode_id, idx)
);
create index if not exists shots_project_idx on shots(project_id, status);

create table if not exists takes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  shot_id       uuid not null references shots(id) on delete cascade,
  n             int  not null,                         -- take number for this shot
  provider      text not null default 'minimax',
  provider_task_id text,
  request       jsonb not null default '{}'::jsonb,    -- exact H3 body (media inlined as refs, not bytes)
  status        text not null default 'pending',       -- pending | submitted | running | succeeded | failed | rejected
  error         text,
  error_code    text,                                  -- sensitive_content | insufficient_balance | invalid_output | …
  file_key      text,
  thumb_key     text,
  media         jsonb,                                  -- ffprobe: duration, width, height, has_audio, fps
  resolution    text,
  seconds       numeric,
  cost_usd      numeric,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  finished_at   timestamptz,
  unique (shot_id, n)
);
create index if not exists takes_active_idx on takes(status) where status in ('submitted','running');

create table if not exists cuts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  episode_id   uuid not null references episodes(id) on delete cascade,
  kind         text not null default 'final',          -- preview (any latest takes) | final (approved only)
  status       text not null default 'queued',         -- queued | running | done | failed
  options      jsonb not null default '{}'::jsonb,     -- burn_subtitles, music_key, fade, loudness
  file_key     text,
  srt_key      text,
  thumb_key    text,
  duration     numeric,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- ─────────────────────────── job queue ───────────────────────────
-- Durable queue on Postgres (FOR UPDATE SKIP LOCKED). Survives restarts;
-- several workers can run side by side.

create table if not exists jobs (
  id          bigserial primary key,
  project_id  uuid references projects(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'queued',          -- queued | running | done | failed | cancelled
  attempts    int  not null default 0,
  max_attempts int not null default 3,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  locked_by   text,
  progress    text,
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jobs_ready_idx on jobs(run_after) where status = 'queued';
create index if not exists jobs_project_idx on jobs(project_id, created_at desc);

-- ─────────────────────────── spend tracking ───────────────────────────

create table if not exists usage_events (
  id          bigserial primary key,
  owner_id    uuid not null,
  project_id  uuid references projects(id) on delete set null,
  kind        text not null,                           -- llm | image | voice | video
  ref_id      text,
  units       numeric not null default 0,              -- tokens / images / characters / seconds
  cost_usd    numeric not null default 0,
  estimated   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists usage_owner_idx on usage_events(owner_id, created_at desc);

-- Optional prepaid credits. Enforced only when ENFORCE_CREDITS=1.
create table if not exists credit_accounts (
  owner_id     uuid primary key,
  balance_usd  numeric not null default 0,
  updated_at   timestamptz not null default now()
);

create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());
