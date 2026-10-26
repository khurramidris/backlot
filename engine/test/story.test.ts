// The writers' room and director tools: freshness, budgets and rhythm, bible, card and scene checks, renames,
// Fountain rendering, screenplay checks, worked examples, judging, coverage, richer compiled prompts, image-prompt
// fitting, the structured-output schemas, and a Claude client that copes with less capable endpoints.
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  sparksFor, shuffled, storyLint, budget, sceneRange, rhythm, cleanBible, cleanOutline, plantNotes, cleanScene, sceneProblem, elementSeconds,
  overusedNames, applyRenames, namedInIdea, isEnglish, inParallel,
} from '../src/pipeline/story.js';
import { sceneFountain, parseScenes, dialogueOf } from '../src/pipeline/fountain.js';
import { exemplarsFor, sceneTags, EXEMPLARS } from '../src/pipeline/exemplars.js';
import { CRAFT, craftFor, craftTags } from '../src/pipeline/craft.js';
import { repairShots, actionLines, coverage, cardFor } from '../src/pipeline/shots.js';
import { compileShot } from '../src/pipeline/compiler.js';
import { fitPrompt, assetPrompt } from '../src/pipeline/assets.js';
import { pickConcept, judged } from '../src/pipeline/writer.js';
import { bibleText, cardText, scenePrompt } from '../src/pipeline/prompts.js';
import { claudeJSON, llmCost, modelFor, rejectedFeature, schemaHint } from '../src/providers/claude.js';
import { config } from '../src/config.js';
import * as S from '../src/pipeline/schemas.js';

test('sparks: stable for a project, different across projects', () => {
  assert.deepEqual(sparksFor('project-1'), sparksFor('project-1'), 'a retried step sees the same sparks');
  const all = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => sparksFor(x).join('|')));
  assert.ok(all.size >= 6, 'different projects get different sparks');
  assert.equal(sparksFor('x').length, 3);
  assert.deepEqual(shuffled('s', [1, 2, 3, 4]).sort(), [1, 2, 3, 4], 'shuffle keeps every item');
});

test('runtime becomes concrete numbers: scenes, seconds, words, a timed beat grid', async () => {
  const b = budget(15);
  assert.equal(b.dialogue, 22); assert.equal(b.action, 19); assert.equal(b.actionLines, 2);
  assert.equal(b.dialogue / 2.4 + b.action * 0.32 > 14 && b.dialogue / 2.4 + b.action * 0.32 < 16, true, 'the budget plays its seconds');
  assert.deepEqual(sceneRange('microdrama', 75), [3, 7], 'microdramas cut fast');
  assert.deepEqual(sceneRange('short_film', 120), [3, 8]);
  const grid = rhythm('microdrama', 80);
  assert.match(grid[0], /^0s: HOOK/);
  assert.ok(grid.some((g) => /^about 20s: FIRST TURN/.test(g)) && /CLIFFHANGER/.test(grid[grid.length - 1]));
  assert.match(rhythm('youtube', 100)[0], /first 5 seconds/);
  assert.deepEqual(await inParallel([3, 1, 2], 2, async (x) => x * 2), [6, 2, 4], 'parallel work keeps its order');
});

test('bible: ids become cue-safe and unique, relationships follow, unusable bibles are refused', () => {
  const raw = { characters: [{ id: 'Zoë', name: 'Zoë Kaur' }, { id: 'zoe', name: 'Zoe Mistry' }, { id: 'آسما', name: 'Asma Qureshi' }],
    sets: [{ name: 'int. rizvi medical store' }], episodes: [{}], relationships: [{ between: 'Zoë & zoe', dynamic: 'x' }], plants: [{ id: 'p1', setup: 'a', payoff: 'b' }] };
  const { bible, problem } = cleanBible(raw, 1);
  assert.equal(problem, '');
  assert.deepEqual(bible.characters.map((c: any) => c.id), ['ZOE', 'ZOE_2', 'ASMA']);
  assert.equal(bible.relationships[0].between, 'ZOE & ZOE_2');
  assert.equal(bible.sets[0].name, 'RIZVI MEDICAL STORE');
  assert.equal(bible.plants[0].id, 'P1');
  assert.match(cleanBible({ ...raw, characters: [] }, 1).problem, /no characters/);
  assert.match(cleanBible({ ...raw, sets: [] }, 1).problem, /no sets/);
  assert.match(cleanBible(raw, 2).problem, /plans 1 episode\(s\), 2 were asked for/);
});

test('overused names are recast everywhere, unless the customer chose them', () => {
  const bible = { characters: [{ id: 'MAYA', name: 'Maya Rahman' }, { id: 'RAVI', name: 'Ravi Shah' }], relationships: [{ between: 'MAYA & RAVI', dynamic: "Maya owes Ravi; Mayank's shop" }],
    sets: [{ name: "MAYA'S FLAT" }] };
  assert.deepEqual(overusedNames(bible.characters, 'a story about two cousins'), [{ id: 'MAYA', name: 'Maya Rahman' }]);
  assert.deepEqual(overusedNames(bible.characters, 'Maya runs a stall'), [], 'a name the customer asked for stays');
  const out = applyRenames(bible, [{ id: 'MAYA', name: 'Rukhsana Begum' }]);
  assert.deepEqual(out.characters[0], { id: 'RUKHSANA', name: 'Rukhsana Begum' });
  assert.equal(out.relationships[0].between, 'RUKHSANA & RAVI');
  assert.equal(out.relationships[0].dynamic, "Rukhsana owes Ravi; Mayank's shop", 'whole words only');
  assert.equal(out.sets[0].name, "RUKHSANA'S FLAT");
});

const BIBLE = cleanBible({
  characters: [{ id: 'ASMA', name: 'Asma Qureshi' }, { id: 'IQBAL', name: 'Iqbal Rizvi' }], sets: [{ name: 'RIZVI MEDICAL STORE' }, { name: 'ASMA FLAT' }],
  episodes: [{ number: 1, title: 'x', summary: 's', opening: 'o', ending: 'e' }], plants: [{ id: 'P1', setup: 'the ledger', payoff: 'the torn page' }, { id: 'P2', setup: 'the key', payoff: 'the door' }],
}, 1).bible;

test('scene cards: sets and characters from the bible, seconds that add up, plants that pay off', () => {
  const { cards, problem } = cleanOutline({ scenes: [
    { set: 'Rizvi Medical Store', int_ext: 'INT', time: 'evening', characters: ['asma', 'Iqbal Rizvi', 'Nobody'], seconds: 30, objectives: [{ who: 'IQBAL', wants: 'x', tactic: 'bait' }], plants: ['p1', 'P9'], payoffs: [] },
    { set: 'the flat', int_ext: 'EXT', time: 'NIGHT', characters: ['ASMA'], seconds: 0, objectives: [], plants: [], payoffs: ['P1'] },
    { set: 'ROOF - TOP', int_ext: 'ext', time: 'DAWN', characters: [], seconds: 10, objectives: [{ who: 'ASMA', wants: 'y', tactic: 'hide' }], plants: [], payoffs: [] },
  ] }, BIBLE, 75, [3, 7]);
  assert.equal(problem, '');
  assert.deepEqual(cards.map((c) => c.heading), ['INT. RIZVI MEDICAL STORE - DUSK', 'EXT. ASMA FLAT - NIGHT', 'EXT. ROOF TOP - DAWN']);
  assert.deepEqual(cards[0].characters, ['ASMA', 'IQBAL'], 'unknown characters dropped');
  assert.deepEqual(cards[2].characters, ['ASMA'], 'whoever has an objective is on screen');
  assert.deepEqual(cards[0].plants, ['P1'], 'unknown plants dropped');
  assert.equal(cards.reduce((t, c) => t + c.seconds, 0), 75, 'seconds add up to the runtime');
  assert.ok(cards[0].seconds > cards[2].seconds, 'proportions kept');
  assert.match(cleanOutline({ scenes: [cards[0]] }, BIBLE, 75, [4, 7]).problem, /1 scenes, but this runtime needs 4 to 7/);
  assert.match(cleanOutline({ scenes: [] }, BIBLE, 75, [3, 7]).problem, /no scenes/);
  const notes = plantNotes(BIBLE, [cards]);
  assert.ok(notes.some((n) => /P2 .* never reaches the screen/.test(n)));
  const early = plantNotes(BIBLE, [[{ ...cards[0], plants: [], payoffs: ['P1'] }, { ...cards[1], plants: ['P1'], payoffs: [] }]]);
  assert.ok(early.some((n) => /P1 pays off before it is set up/.test(n)));
});

test('written scenes: known speakers, merged speeches, a length that fits the card', () => {
  const s = cleanScene({ elements: [
    { kind: 'action', text: '  Asma counts\nthe till. ' }, { kind: 'line', who: 'asma', paren: '(flat)', text: 'Name?' },
    { kind: 'line', who: 'IQBAL', paren: '', text: "It's written." }, { kind: 'line', who: 'Iqbal Rizvi', paren: '', text: 'On the slip.' },
    { kind: 'line', who: 'Waiter', paren: '', text: 'Chai?' }, { kind: 'line', who: '', paren: '', text: 'A radio plays.' }, { kind: 'action', text: '' },
  ] }, BIBLE);
  assert.deepEqual(s.elements.map((e) => [e.kind, e.who || '', e.paren || '', e.text]), [
    ['action', '', '', 'Asma counts the till.'], ['line', 'ASMA', 'flat', 'Name?'], ['line', 'IQBAL', '', "It's written. On the slip."],
    ['line', 'WAITER', '', 'Chai?'], ['action', '', '', 'A radio plays.'],
  ]);
  assert.deepEqual(s.unknown, ['WAITER']);
  assert.match(sceneProblem(s, 10, ['ASMA', 'IQBAL']), /WAITER is not in this story's cast/);
  const ok = { elements: s.elements.filter((e) => e.who !== 'WAITER'), unknown: [] };
  assert.equal(sceneProblem(ok, elementSeconds(ok.elements), ['ASMA', 'IQBAL']), '');
  assert.match(sceneProblem(ok, 40, ['ASMA', 'IQBAL']), /plays only about \d+s but the scene has about 40s/);
  assert.match(sceneProblem({ elements: [], unknown: [] }, 10, []), /empty/);
});

test('scenes render to Fountain that parses back exactly', () => {
  const script = [
    sceneFountain('INT. RIZVI MEDICAL STORE - NIGHT', [
      { kind: 'action', text: 'INT. not a heading, just a sentence.' }, { kind: 'line', who: 'ASMA', paren: 'quietly', text: 'Name?' },
      { kind: 'action', text: 'CUT TO: nothing.' }, { kind: 'action', text: 'SILENCE' }, { kind: 'line', who: 'IQBAL', text: "It's written." },
      { kind: 'line', who: 'NURSE 2.', text: 'Next.' },
    ]),
    sceneFountain('EXT. ASMA FLAT - DAWN', [{ kind: 'action', text: 'Wind.' }]),
  ].join('\n\n');
  const scenes = parseScenes(script, BIBLE.characters);
  assert.deepEqual(scenes.map((s) => s.heading), ['INT. RIZVI MEDICAL STORE - NIGHT', 'EXT. ASMA FLAT - DAWN']);
  assert.deepEqual(scenes[0].speakers, ['ASMA', 'IQBAL', 'NURSE 2.']);
  assert.deepEqual(dialogueOf(scenes[0].body, BIBLE.characters).map((d) => d.line), ['Name?', "It's written.", 'Next.']);
  assert.deepEqual(actionLines(scenes[0].body), ['INT. not a heading, just a sentence.', 'CUT TO: nothing.', 'SILENCE']);
});

const LINT_SCRIPT = `INT. TEA STALL - DAWN

ARJUN wipes the counter. The sign reads: OPEN.

ARJUN
We need to talk about the money you took from the drawer last night when nobody was watching the stall at all.

EXT. BUS DEPOT - DAY

RUKHSANA waits.

RUKHSANA
(looking at the long line of buses as if she is counting them one by one)
Trust me.`;

test('screenplay checks flag what hurts quality or rendering', () => {
  const d = { characters: [{ id: 'ARJUN', name: 'Arjun Mehta' }, { id: 'RUKHSANA', name: 'Maya Rukhsana' }], episodes: [{ title: 'x', script: LINT_SCRIPT }] };
  const r = storyLint(d, { seconds: 75 });
  const has = (rx: RegExp) => r.issues.some((i) => rx.test(i));
  assert.ok(has(/Maya Rukhsana.*overused/), 'overused name');
  assert.ok(has(/stock line "We need to talk"/), 'stock line');
  assert.ok(has(/stock line "Trust me"/), 'stock line on its own');
  assert.ok(has(/legible on-screen text/), 'readable sign');
  assert.ok(has(/too long to land/), 'overlong line');
  assert.ok(has(/parenthetical/), 'long parenthetical');
  assert.ok(has(/runs about \d+s; the target is 75s/), 'runtime off target');
  assert.equal(r.episodes[0].speakers, 2);
  assert.ok(r.located.some((l) => l.episode === 1 && l.scene === 1 && /stock line/.test(l.issue)), 'issues are located by scene');
  assert.ok(!storyLint(d, { seconds: 75 }, 'a story about maya').issues.some((i) => /overused/.test(i) && /Maya/.test(i)), 'a name the customer asked for is fine');
});

test('screenplay checks catch what weaker models write, and only check English lines in English', () => {
  const script = `INT. KITCHEN - NIGHT

Ravi realizes she has been lying. We see the envelope on the table, the cooker, the plates, the stack of unpaid bills, the calendar, the photographs of the family, the clock, the broken fan above the door.

RAVI
Look, Asma, I'm so hurt.

ASMA
As you know, Ravi, the shop is ours. What do you mean?

RAVI
What do you mean, Asma? Listen, Asma, I will say this once, and then I will go, and you will never see me again.`;
  const d = { characters: [{ id: 'RAVI', name: 'Ravi Sharma' }, { id: 'ASMA', name: 'Asma Begum' }], episodes: [{ script }] };
  const r = storyLint(d, { seconds: 30, language: 'English' }, 'In Lahore, two cousins fight over a shop.');
  const has = (rx: RegExp) => r.issues.some((i) => rx.test(i));
  assert.ok(has(/describes what a camera can't see/), 'unfilmable action');
  assert.ok(has(/camera directions in the action/), 'camera directions');
  assert.ok(has(/opens on a long description/), 'slow opening');
  assert.ok(has(/ends on a long line/), 'ending on talk');
  assert.ok(has(/RAVI names a feeling/), 'named feeling');
  assert.ok(has(/explains something both characters already know/), 'exposition');
  assert.ok(has(/"What do you mean" 2 times/), 'question tic');
  assert.ok(has(/call each other by name in 3 of 3 lines/), 'vocatives');
  assert.ok(has(/idea names "Lahore", which the story has lost/), 'the customer\'s place');
  const urdu = storyLint(d, { seconds: 30, language: 'Urdu' }, '');
  assert.ok(!urdu.issues.some((i) => /names a feeling|already know|"What do you mean" \d times/.test(i)), 'English checks skip other languages');
  assert.ok(urdu.issues.some((i) => /camera directions/.test(i)), 'action lines are English in every project');
  assert.ok(isEnglish('') && isEnglish('English (UK)') && !isEnglish('Urdu'));
  assert.deepEqual(namedInIdea("Maya and Ravi run a dhaba near Amritsar. A storm hits. The CEO lies."), ['Maya', 'Ravi', 'Amritsar']);
  assert.deepEqual(namedInIdea('A night-shift nurse finds a letter in a patient\'s coat.'), []);
});

test('worked examples: openings and endings get theirs, specific needs are met, examples rotate', () => {
  const opening = craftFor(craftTags({ first: true, last: false, speakers: 1, text: 'she hides', format: 'microdrama' }), 'a');
  assert.ok(opening[0].tags.includes('opening'));
  const ending = craftFor(craftTags({ first: false, last: true, speakers: 2, text: '', format: 'short_film' }), 'a');
  assert.ok(ending.some((e) => e.tags.includes('ending')));
  const message = craftFor(craftTags({ first: false, last: false, speakers: 2, text: 'she reads the message on her phone', format: 'microdrama' }), 'a');
  assert.ok(message.some((e) => e.tags.includes('text')), 'a scene with a message learns how to play one');
  const seen = new Set(Array.from({ length: 12 }, (_, i) => craftFor(craftTags({ first: false, last: false, speakers: 2, text: '', format: 'microdrama' }), `s${i}`).map((e) => e.id).join()));
  assert.ok(seen.size >= 4, 'different scenes see different examples');
  // The strong versions must pass the very checks the writers are held to.
  for (const e of CRAFT) {
    assert.ok(e.weak && e.strong && e.why && e.tags.length, e.id);
    const script = `INT. ROOM - DAY\n\n${e.strong.split('\n').map((l) => { const m = /^([A-Z][A-Z .]+): (?:\(([^)]+)\) )?(.*)$/.exec(l); return m ? `${m[1]}\n${m[2] ? `(${m[2]})\n` : ''}${m[3]}` : l; }).join('\n\n')}`;
    const r = storyLint({ characters: [], episodes: [{ script }] }, { seconds: 1000, language: 'English' });
    const bad = r.located.filter((x) => /stock line|names a feeling|already know|camera can't see|camera directions|too long|legible/.test(x.issue));
    assert.deepEqual(bad.map((x) => x.issue), [], `strong example ${e.id} breaks a rule`);
  }
});

test('choosing a take: fidelity first, then the rubric total, then the judge\'s own pick', () => {
  const s = (concept: number, fidelity: number, rest: number) => ({ concept, fidelity, hook: rest, stakes: rest, specificity: rest, surprise: rest, renderable: rest });
  assert.equal(pickConcept({ scores: [s(0, 5, 3), s(1, 2, 5), s(2, 4, 4)], chosen: 1 }, 3), 2, 'an unfaithful take cannot win');
  assert.equal(pickConcept({ scores: [s(0, 4, 4), s(1, 4, 4)], chosen: 1 }, 2), 1, 'ties go to the judge');
  assert.equal(pickConcept({ scores: [], chosen: 2 }, 3), 2);
  assert.equal(pickConcept({ chosen: 9 }, 3), 0);
});

test('judging: verdicts map back through the seeded order; slight margins are marked', () => {
  const v = judged({ verdicts: [{ pair: 1, better: 'B', margin: 'clear' }, { pair: 2, better: 'B', margin: 'slight' }, { pair: 3, better: 'A', margin: 'clear' }] }, [false, true, true]);
  assert.deepEqual(v, [{ winner: 1, clear: true }, { winner: 0, clear: false }, { winner: 1, clear: true }]);
  assert.deepEqual(judged({}, [false]), [{ winner: 0, clear: false }], 'no verdict keeps the first version');
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

test('coverage: every moment once, in order, in shots H3 can hold', () => {
  const body = `INT. KITCHEN - NIGHT

ASMA stirs a pot. Her phone buzzes.

ASMA
Not tonight.
Please, not tonight.

IQBAL
(quietly)
She has to hear it from me. I came all this way and I am not leaving until she does, whatever it costs.

The streetlight flickers.

ASMA
Go.`;
  const c = coverage(body, BIBLE.characters);
  assert.deepEqual(c, ['Shot 1 (about 5s): action 1 + line 1 ASMA', 'Shot 2 (about 10s): line 2 IQBAL', 'Shot 3 (about 4s): action 2 + line 3 ASMA']);
  const p = { story_bible: { outline: [{ episode: 1, scenes: [{ heading: 'INT. KITCHEN - NIGHT', purpose: 'x' }] }] } };
  assert.equal(cardFor(p, 1, { idx: 1, heading: 'INT. KITCHEN - NIGHT' })?.purpose, 'x');
  assert.equal(cardFor(p, 1, { idx: 1, heading: 'EXT. ROOF - DAY' }), null, 'an edited script loses its card');
});

test('the scene writer sees its card, the whole board, a budget, and the setups spelled out', () => {
  const card = { heading: 'INT. RIZVI MEDICAL STORE - NIGHT', seconds: 15, characters: ['ASMA', 'IQBAL'], purpose: 'She stalls him', objectives: [{ who: 'ASMA', wants: 'time', tactic: 'stall' }],
    subtext: 'she knows', turn: 'he sees the ledger', value: 'safe → exposed', key_image: 'the ledger', exit: 'he leaves', plants: ['P1'], payoffs: [] };
  const prompt = scenePrompt({ episode: BIBLE.episodes[0], episodes: 1, cards: [card, { ...card, characters: ['ASMA'] }], k: 0, plants: BIBLE.plants, budget: budget(15), examples: CRAFT.slice(0, 2) });
  for (const bit of ['>> 1. INT. RIZVI MEDICAL STORE - NIGHT (15s) [ASMA, IQBAL]: She stalls him. Turn: he sees the ledger.', 'ASMA wants time (tactic: stall)',
    'Sets up: P1 (the ledger → the torn page)', 'about 22 words of dialogue', "This is the episode's opening", 'Weak:', 'Write scene 1.']) assert.ok(prompt.includes(bit), bit);
  const alone = scenePrompt({ episode: BIBLE.episodes[0], episodes: 1, cards: [card, { ...card, characters: ['ASMA'] }], k: 1, budget: budget(15), examples: [] });
  assert.match(alone, /one person on screen, so it plays mostly in behaviour/);
  assert.match(cardText(card, 0, 2), /Underneath: she knows/);
  const ctx = bibleText(BIBLE, { language: 'Urdu' });
  assert.ok(ctx.includes('Action lines are always written in English') && ctx.includes('- ASMA: Asma Qureshi'));
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

test('without structured outputs, the answer shape is described in the prompt, comments and enums included', () => {
  const hint = schemaHint(zodOutputFormat(S.OutlineSchema as any).schema);
  assert.match(hint, /"scenes": \[ {2}\/\/ the scenes of this episode, in order/);
  assert.match(hint, /"int_ext": "INT" \| "EXT",/);
  assert.match(hint, /"seconds": 0, {2}\/\/ screen time in seconds/);
  assert.match(hint, /"objectives": \[/);
  assert.match(hint, /"plants": \["…", …\], {2}\/\/ ids of the plants this scene sets up/);
  assert.ok(!/minimum|\$schema|\{enum/.test(hint), 'the SDK notes are cleaned out');
  assert.equal(rejectedFeature('thinking.type: adaptive is not supported on this model', { thinking: true, format: true }), 'thinking');
  assert.equal(rejectedFeature('output_config.format: unknown field', { thinking: false, format: true }), 'format');
  assert.equal(rejectedFeature('messages: text content blocks must be non-empty', { thinking: true, format: true }), null);
  assert.equal(rejectedFeature('thinking is not supported', { thinking: false, format: true }), null, 'only what was sent can be blamed');
});

test('each step can run on its own model', () => {
  const saved = { ...config.anthropic.models };
  config.anthropic.models.scene = 'claude-haiku-5-5';
  assert.equal(modelFor('scene'), 'claude-haiku-5-5');
  assert.equal(modelFor('bible'), config.anthropic.model);
  assert.equal(modelFor('retake', true), config.anthropic.fastModel);
  config.anthropic.models = saved;
});

test('a weaker endpoint still works: rejected features are dropped, an unusable answer gets one repair round', async (t) => {
  const bodies: any[] = [];
  const answers: (() => { status: number; body?: any; text?: string })[] = [
    () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking: adaptive thinking is not supported on this model' } } }),
    () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format: structured outputs are not supported' } } }),
    () => ({ status: 200, text: 'Here you go:\n```json\n{"names": [{"id": "MAYA"}]}\n```' }),
    () => ({ status: 200, text: '{"names": [{"id": "MAYA", "name": "Rukhsana Begum"}]}' }),
  ];
  const sse = (text: string) => [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const a = (answers[bodies.length - 1] || answers[answers.length - 1])();
      if (a.status !== 200) { res.writeHead(a.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(a.body)); }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(a.text!));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const saved = { mock: config.mock, apiKey: config.anthropic.apiKey, baseUrl: config.anthropic.baseUrl, model: config.anthropic.model, fallbacks: config.anthropic.fallbacks };
  Object.assign(config, { mock: false });
  Object.assign(config.anthropic, { apiKey: 'test-key', baseUrl: `http://localhost:${(server.address() as any).port}`, model: 'fake-model', fallbacks: false });
  t.after(() => { Object.assign(config, { mock: saved.mock }); Object.assign(config.anthropic, saved); server.close(); });

  const r = await claudeJSON({ task: 'rename', system: 'sys', prompt: 'Rename MAYA.', schema: S.RenameSchema });
  assert.deepEqual(r.data, { names: [{ id: 'MAYA', name: 'Rukhsana Begum' }] });
  assert.equal(bodies.length, 4);
  assert.ok(bodies[0].thinking && bodies[0].output_config?.format, 'first try sends everything');
  assert.ok(!bodies[1].thinking && !bodies[1].output_config?.effort && bodies[1].output_config?.format, 'thinking dropped after the 400');
  assert.ok(!bodies[2].output_config, 'structured outputs dropped after the second 400');
  assert.match(bodies[2].messages[0].content.at(-1).text, /ANSWER FORMAT[\s\S]*"names": \[/, 'the shape is described in the prompt instead');
  assert.equal(bodies[3].messages.length, 3, 'the repair round shows the answer and what was wrong');
  assert.match(bodies[3].messages[2].content, /did not match the required shape: names\.0\.name/);
  assert.equal(r.usage.output, 14, 'usage adds up across calls');

  const again = await claudeJSON({ task: 'rename', system: 'sys', prompt: 'Rename MAYA.', schema: S.RenameSchema });
  assert.equal(again.data.names[0].name, 'Rukhsana Begum');
  assert.ok(!bodies[4].thinking && !bodies[4].output_config, 'the model remembers what it rejected');
});

test('LLM cost counts cache reads and writes', () => {
  const plain = llmCost('claude-opus-5-5', { input: 1_000_000, output: 0 });
  assert.equal(plain, 4);
  assert.equal(llmCost('claude-opus-5-5', { input: 0, output: 0, cacheRead: 1_000_000 }), 0.2);
  assert.equal(llmCost('claude-opus-5-5', { input: 0, output: 0, cacheWrite: 1_000_000 }), 5);
  assert.equal(llmCost('claude-haiku-5-5', { input: 1_000_000, output: 1_000_000 }), 0.6);
  assert.equal(llmCost('claude-opus-5-5', { input: 0, output: 1_000_000 }), 20);
  assert.equal(llmCost('claude-sonnet-5-5', { input: 0, output: 1_000_000 }), 10);
});
