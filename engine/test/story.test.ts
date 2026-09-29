// The writers' room and director tools: freshness, screenplay checks, exemplar choice, action coverage,
// richer compiled prompts, image-prompt fitting, and the structured-output schemas.
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { sparksFor, shuffled, storyLint } from '../src/pipeline/story.js';
import { exemplarsFor, sceneTags, EXEMPLARS } from '../src/pipeline/exemplars.js';
import { repairShots, actionLines } from '../src/pipeline/shots.js';
import { compileShot } from '../src/pipeline/compiler.js';
import { fitPrompt, assetPrompt } from '../src/pipeline/assets.js';
import { checkTreatment } from '../src/pipeline/writer.js';
import { llmCost } from '../src/providers/claude.js';
import * as S from '../src/pipeline/schemas.js';

test('sparks: stable for a project, different across projects', () => {
  assert.deepEqual(sparksFor('project-1'), sparksFor('project-1'), 'a retried step sees the same sparks');
  const all = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => sparksFor(x).join('|')));
  assert.ok(all.size >= 6, 'different projects get different sparks');
  assert.equal(sparksFor('x').length, 3);
  assert.deepEqual(shuffled('s', [1, 2, 3, 4]).sort(), [1, 2, 3, 4], 'shuffle keeps every item');
});

const SCRIPT = `INT. TEA STALL - DAWN

ARJUN wipes the counter. The sign reads: OPEN.

ARJUN
We need to talk about the money you took from the drawer last night when nobody was watching the stall at all.

EXT. BUS DEPOT - DAY

RUKHSANA waits.

RUKHSANA
(looking at the long line of buses as if she is counting them one by one)
Trust me.`;

test('screenplay checks flag what hurts quality or rendering', () => {
  const d = { characters: [{ id: 'ARJUN', name: 'Arjun Mehta' }, { id: 'RUKHSANA', name: 'Maya Rukhsana' }], episodes: [{ title: 'x', script: SCRIPT }] };
  const r = storyLint(d, { seconds: 75 });
  const has = (rx: RegExp) => r.issues.some((i) => rx.test(i));
  assert.ok(has(/Maya Rukhsana.*overused/), 'overused name');
  assert.ok(has(/stock line "We need to talk"/), 'stock line');
  assert.ok(has(/stock line "Trust me"/), 'stock line on its own');
  assert.ok(has(/legible on-screen text/), 'readable sign');
  assert.ok(has(/words \(keep lines under/), 'overlong line');
  assert.ok(has(/parenthetical/), 'long parenthetical');
  assert.ok(has(/runs about \d+s; the target is 75s/), 'runtime off target');
  assert.equal(r.episodes[0].speakers, 2);
  assert.ok(!storyLint(d, { seconds: 75 }, 'a story about maya').issues.some((i) => /overused/.test(i) && /Maya/.test(i)), 'a name the customer asked for is fine');
});

test('treatments without characters or beats are rejected', () => {
  assert.match(checkTreatment({}, { episodes: 1 }), /no treatment/);
  assert.match(checkTreatment({ treatment: { characters: [{}], episodes: [] } }, { episodes: 1 }), /plans 0 episode/);
  assert.equal(checkTreatment({ treatment: { characters: [{}], episodes: [{ beats: [{}] }] } }, { episodes: 1 }), '');
});

test('exemplars: matched to the scene, rotated per seed, cliffhanger for the last scene', () => {
  const tags = sceneTags('INT. ROOM - NIGHT\n\nShe opens the drawer and finds a ring hidden in cloth.', { lines: 0, first: false, last: true });
  assert.ok(tags.includes('reveal') && tags.includes('ending'));
  const ex = exemplarsFor(tags, 'seed-a');
  assert.equal(ex.length, 2);
  assert.ok(ex.some((e) => e.tags.includes('ending')), 'last scene learns the cliffhanger');
  const firsts = new Set(Array.from({ length: 12 }, (_, i) => exemplarsFor(['dialogue'], `s${i}`)[0].id));
  assert.ok(firsts.size >= 2, 'different scenes see different examples');
  assert.ok(EXEMPLARS.every((e) => e.plan && e.principle && e.tags.length));
});

test('shot repair: every action line gets shown, monotony is flagged', () => {
  const body = 'INT. ROOM - DAY\n\nShe enters.\n\nHe hides the letter.\n\nShe notices.';
  const actions = actionLines(body);
  assert.equal(actions.length, 3);
  const raw = { shots: [{ duration: 6, covers: [1], characters: [], props: [], beats: [{ t0: 0, t1: 6, shot: 'wide', camera: 'static', action: 'She enters.' }] }] };
  const r = repairShots(raw, [], { chars: new Set(), props: new Set() }, 8, actions);
  const text = r.shots.flatMap((s) => s.beats.map((b) => b.action)).join(' | ');
  assert.ok(text.includes('He hides the letter.') && text.includes('She notices.'), 'skipped actions added');
  assert.ok(r.warnings.some((w) => /added an action/.test(w)));
  const mono = { shots: Array.from({ length: 3 }, () => ({ duration: 8, characters: [], props: [], beats: [0, 1].map((k) => ({ t0: k * 4, t1: k * 4 + 4, shot: 'medium', camera: 'slow push-in', action: 'x' })) })) };
  assert.ok(repairShots(mono, [], { chars: new Set(), props: new Set() }).warnings.some((w) => /little variety/.test(w)));
});

test('compiled prompt carries lens, blocking, performance and light, and sheds detail to fit', () => {
  const base = {
    project: { aspect: '9:16', language: 'Urdu', style: { palette: 'brass, teal', texture: 'fine grain' }, format: 'micro' },
    scene: { heading: 'INT. SHOP - NIGHT', time_of_day: 'NIGHT', int_ext: 'INT' }, characters: [], props: [],
  };
  const plan = { duration: 6, characters: [], props: [], scene_light: 'a single tube light', beats: [
    { t0: 0, t1: 6, shot: 'close-up', lens: 'portrait 85mm', camera: 'slow push-in', action: 'He counts the notes', blocking: 'he stands frame left', performance: 'his thumb hesitates', light: 'the tube light flickers' },
  ] };
  const c = compileShot({ ...base, plan } as any);
  for (const bit of ['portrait 85mm lens', 'he stands frame left', 'his thumb hesitates', 'Light: the tube light flickers', 'Light: a single tube light', 'palette: brass, teal']) assert.ok(c.prompt.includes(bit), bit);
  const long = { ...plan, beats: [0, 1, 2, 3].map((k) => ({ ...plan.beats[0], t0: k, t1: k + 1, blocking: 'b'.repeat(900), performance: 'p'.repeat(900) })) };
  const c2 = compileShot({ ...base, plan: long } as any);
  assert.ok(c2.prompt.length <= 7000 && !c2.prompt.includes('bbbb'), 'blocking and performance dropped before anything else');
  assert.ok(c2.warnings.some((w) => /shortened/.test(w)));
});

test('image prompts fit the 1500-character limit, keeping required parts', () => {
  const p = fitPrompt(['REQUIRED LEAD', { text: 'x'.repeat(1400), optional: true }, 'REQUIRED TAIL'], 200);
  assert.ok(p.includes('REQUIRED LEAD') && p.includes('REQUIRED TAIL') && !p.includes('xxx'));
  const project = { style: { camera: 'handheld', palette: 'ochre, teal', texture: '35mm grain' }, story_bible: { world: 'w'.repeat(900) } };
  const face = assetPrompt({ kind: 'character', name: 'Rukhsana Begum', description: 'A 52-year-old woman with a strong jaw, deep laugh lines and grey-streaked hair in a low bun.', meta: {} }, null, project, 'make her look more tired');
  assert.ok(face.length <= 1500);
  assert.ok(face.startsWith('Photorealistic casting headshot of Rukhsana Begum'));
  assert.ok(face.includes('Revision requested: make her look more tired'), 'revision note survives fitting');
  assert.ok(/no beauty retouching/.test(face), 'anti-AI-face realism');
  const set = assetPrompt({ kind: 'location', name: 'Tea stall', description: 'A tin-roofed tea stall.', meta: { layout: 'counter left', int_ext: 'EXT' } }, null, project);
  assert.ok(set.includes('Layout: counter left') && set.includes('ground') && set.length <= 1500);
});

test('structured-output schemas use only what the API supports', () => {
  const unsupported = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];
  for (const [name, schema] of Object.entries(S)) {
    if (!name.endsWith('Schema')) continue;
    const json = zodOutputFormat(schema as any).schema;
    const text = JSON.stringify(json);
    for (const k of unsupported) assert.ok(!text.includes(`"${k}"`), `${name} uses ${k}`);
    const walk = (n: any): void => { if (n && typeof n === 'object') { if (n.type === 'object') assert.equal(n.additionalProperties, false, `${name}: every object closed`); Object.values(n).forEach(walk); } };
    walk(json);
  }
});

test('LLM cost counts cache reads and writes', () => {
  const plain = llmCost('claude-opus-5-5', { input: 1_000_000, output: 0 });
  assert.equal(plain, 4);
  assert.equal(llmCost('claude-opus-5-5', { input: 0, output: 0, cacheRead: 1_000_000 }), 0.4);
  assert.equal(llmCost('claude-opus-5-5', { input: 0, output: 1_000_000 }), 20);
  assert.equal(llmCost('claude-sonnet-5-5', { input: 0, output: 1_000_000 }), 10);
});
