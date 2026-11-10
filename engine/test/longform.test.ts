// Long films and step-by-step projects: no length cap, season-scale planning in batches, the bulk model for the many
// small calls, merged breakdowns, scene splitting for rewrites, and the setup fee that grows with the runtime.
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrief, isLongForm, setupFeeFor, splitScenes, joinScenes, mergeScores, unitOf, writeStep, type WriteState } from '../src/pipeline/writer.js';
import { mergeBreakdowns, repair } from '../src/pipeline/breakdown.js';
import { modelFor } from '../src/providers/claude.js';
import { seasonPrompt, biblePrompt, critiquePrompt } from '../src/pipeline/prompts.js';
import { decideWorkersMin } from '../src/capacity.js';
import { config } from '../src/config.js';

test('no length cap: a 90-minute microdrama, a feature film and a long series are all allowed', () => {
  const micro = resolveBrief({ prompt: 'A nurse finds a letter that proves her husband is alive.', format: 'microdrama', total_seconds: 90 * 60 });
  assert.equal(micro.seconds, 75);
  assert.equal(micro.episodes, 72, '90 minutes of 75-second episodes');
  const feature = resolveBrief({ prompt: 'A heist crew is set up by its own driver.', format: 'feature_film', total_seconds: 120 * 60 });
  assert.equal(feature.episodes * feature.seconds, 7200, 'a two-hour feature, in parts');
  assert.equal(unitOf('feature_film'), 'Part');
  const series = resolveBrief({ prompt: 'A family restaurant fights a hostile takeover.', format: 'web_series', episodes: 200, seconds: 300 });
  assert.equal(series.episodes, 200, 'no cap on episodes');
  const short = resolveBrief({ prompt: 'Two rival food trucks share one spot for a week.', format: 'short_film', total_seconds: 400 });
  assert.deepEqual([short.episodes, short.seconds], [1, 400], 'a short film is one piece of its full length');
  assert.equal(resolveBrief({ prompt: 'A short idea for a quick test.' }).episodes, 1, 'defaults unchanged');
});

test('MAX_RUNTIME_SECONDS still caps a project when an operator sets it', () => {
  const was = config.autopilot.maxRuntimeSeconds;
  config.autopilot.maxRuntimeSeconds = 600;
  try {
    const b = resolveBrief({ prompt: 'A nurse finds a letter that proves her husband is alive.', format: 'microdrama', total_seconds: 5400 });
    assert.ok(b.episodes * b.seconds <= 600);
  } finally { config.autopilot.maxRuntimeSeconds = was; }
});

test('long projects use the bulk model for the many small calls, and the main model for the story spine', () => {
  const long = resolveBrief({ prompt: 'A nurse finds a letter that proves her husband is alive.', format: 'microdrama', total_seconds: 5400 });
  assert.ok(isLongForm(long));
  assert.ok(!isLongForm(resolveBrief({ prompt: 'A nurse finds a letter that proves her husband is alive.' })));
  for (const t of ['scene', 'outline', 'judge', 'critique', 'shots', 'direct', 'breakdown']) assert.equal(modelFor(t, false, true), config.anthropic.bulkModel, t);
  for (const t of ['pitch', 'choose', 'bible', 'season']) assert.equal(modelFor(t, false, true), config.anthropic.model, t);
  assert.equal(modelFor('scene'), config.anthropic.model, 'short projects keep the main model');
});

test('the setup fee covers the first minutes and grows with the runtime', () => {
  const c = config.credits;
  assert.equal(setupFeeFor({ episodes: 1, seconds: 75 }), c.setupFeeUsd);
  const ninety = setupFeeFor({ episodes: 72, seconds: 75 });
  assert.equal(ninety, +(c.setupFeeUsd + (90 - c.setupFeeIncludedMinutes) * c.setupFeePerMinuteUsd).toFixed(2));
});

test('the bible of a long story asks for a bigger world, a season arc and the first batch of episodes', () => {
  const p = biblePrompt({ prompt: 'idea', concept: {}, notes: [], recent: [], format: 'Microdrama', formatNotes: '', aspect: '9:16', episodes: 72, secondsPerEpisode: 75, language: 'English', planned: 12, minutes: 90 });
  assert.match(p, /LONG STORY: 72 episodes, about 90 minutes/);
  assert.match(p, /season_arc/);
  assert.match(p, /episodes 1 to 12/);
  assert.match(seasonPrompt({ from: 61, to: 72, episodes: 72, open: [] }), /episode 72 is the last/);
  assert.match(critiquePrompt({ prompt: 'x', outline: [[]], scripts: ['INT. A - DAY'], first: 10, checks: [], plants: [] }), /=== EPISODE 11/);
});

test('a long story is written end to end in batches (mock writers room)', { skip: !process.env.DATABASE_URL ? 'needs DATABASE_URL' : false }, async () => {
  const { sql, migrate } = await import('../src/db.js');
  await migrate();
  const brief = resolveBrief({ prompt: 'A nurse finds a letter in a patient coat that proves her husband is alive.', format: 'microdrama', episodes: 30, seconds: 60 });
  const [p] = await sql`insert into projects (owner_id, title, format, aspect, language, mode, stage, brief)
    values ('eeeeeeee-0000-4000-8000-0000000001aa', 'long', ${brief.engineFormat}, ${brief.aspect}, 'English', 'vibe', 'writing', ${sql.json(brief as any)}) returning id`;
  const ctx = { job: { id: 0 } as any, progress: async () => {} };
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const [row] = await sql`select autopilot from projects where id = ${p.id}`;
    const st: WriteState = row.autopilot?.writing || {};
    if (st.phase) seen.add(st.phase);
    if ((await writeStep(p.id, ctx)).done) break;
  }
  const eps = await sql`select idx, label from episodes where project_id = ${p.id} order by idx`;
  assert.equal(eps.length, 30);
  assert.equal(eps[29].label, 'Episode 30');
  assert.ok(seen.has('season'), 'later episodes came from the season plan');
  const [done] = await sql`select story_bible from projects where id = ${p.id}`;
  assert.equal(done.story_bible.treatment.episodes.length, 30);
  await sql`delete from projects where id = ${p.id}`;
});

test('script editor scores across batches are weighted by episodes read', () => {
  assert.deepEqual(mergeScores(null, { hook: 4 }, 0, 5), { hook: 4 });
  assert.deepEqual(mergeScores({ hook: 4 }, { hook: 2 }, 6, 2), { hook: 3.5 });
});

test('a long breakdown in batches merges into one cast and one set list', () => {
  const a = { style: { look: 'warm' }, characters: [{ key: 'MAYA', name: 'Maya', scenes: ['E1S1'], looks: [{ key: 'DEFAULT', name: 'Default', scenes: ['E1S1'] }] }],
    sets: [{ key: 'KITCHEN', name: 'Kitchen', scenes: ['E1S1'], variants: [] }], props: [] };
  const b = { style: { look: 'cold', grade: 'teal' }, characters: [{ key: 'MAYA', name: 'Maya', scenes: ['E9S1'], looks: [{ key: 'DEFAULT', scenes: ['E9S1'] }, { key: 'WEDDING', name: 'Wedding', scenes: [] }] }],
    sets: [{ key: 'KITCHEN', name: 'Kitchen', scenes: ['E9S1'], variants: [] }], props: [{ key: 'RING', name: 'Ring', scenes: ['E9S1'] }] };
  const m = mergeBreakdowns([a, b]);
  assert.equal(m.characters.length, 1);
  assert.deepEqual(m.characters[0].scenes, ['E1S1', 'E9S1']);
  assert.deepEqual(m.characters[0].looks.find((l: any) => l.key === 'DEFAULT').scenes, ['E1S1', 'E9S1']);
  assert.equal(m.sets.length, 1);
  assert.deepEqual(m.style, { look: 'warm', grade: 'teal' }, 'the first batch sets the look');
  const scenes = ['E1S1', 'E9S1'].map((ref) => ({ ref, heading: 'INT. KITCHEN - DAY', location: 'KITCHEN', time: 'DAY', int_ext: 'INT', present: ['MAYA'], speakers: ['MAYA'] }));
  const r = repair(m, scenes, []);
  assert.deepEqual(r.sets[0].scenes, ['E1S1', 'E9S1']);
});

test('a screenplay splits at its scene headings and joins back', () => {
  const script = 'Title: X\n\nINT. KITCHEN - NIGHT\n\nShe stirs.\n\nEXT. STREET - NIGHT\n\nHe waits.\n';
  const parts = splitScenes(script);
  assert.equal(parts.scenes.length, 2);
  assert.equal(parts.scenes[1].split('\n')[0], 'EXT. STREET - NIGHT');
  assert.deepEqual(splitScenes(joinScenes(parts)), parts);
});

test('4 clips at once per customer, and a film may use all of them', () => {
  assert.equal(config.minimax.maxConcurrentPerUser, 4);
  assert.equal(config.minimax.maxConcurrentPerProject, 4);
  assert.equal(decideWorkersMin({ active: 4, recent: 4, warmWorkers: 1, maxWorkers: 5, jobsPerWorker: 2 }), 2);
});
