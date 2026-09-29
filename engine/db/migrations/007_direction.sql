-- The director's plan for each episode (visual approach, motifs, and per scene: purpose, temperature,
-- key image, camera, light, blocking, opening and closing images). Shot planning reads it.
alter table episodes add column if not exists direction jsonb not null default '{}'::jsonb;
