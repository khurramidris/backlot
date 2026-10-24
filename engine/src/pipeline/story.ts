// Tools the writers' room uses to keep stories fresh and screenplays shootable. Everything here is code, so a
// weaker model never has to do the bookkeeping:
// - sparks: optional creative prompts picked per project (seeded by its id), so two similar ideas
//   don't converge on the same story;
// - recentWork: the customer's earlier stories, so names, premises and twists aren't repeated;
// - budgets and rhythm: the runtime turned into concrete numbers (scenes, seconds, words of dialogue per
//   scene) and a timed beat grid per format, so no model has to estimate runtime while it writes;
// - outline and scene checks: scene cards and written scenes cleaned against the bible (known sets and
//   characters, seconds that add up, plants that pay off), with a plain-language problem for a retry;
// - storyLint: deterministic checks of a screenplay (runtime, line length, cast and set counts, stock and
//   on-the-nose lines, unfilmable or camera-directing action, text the video model can't render, the opening and
//   the ending, the customer's names and places), located by scene so the polish pass rewrites only what needs it.
//   The final report is kept with the project.

import { createHash } from 'node:crypto';
import { sql } from '../db.js';
import { ACTION_SPW, SPEECH_WPS, characterMatcher, dialogueOf, parseFountain, parseScenes, words, type BibleCharacter, type SceneElement } from './fountain.js';
import { speechSeconds } from './compiler.js';

// ───────────────────────── sparks ─────────────────────────

const ENGINES = [
  'a lie told to protect someone, which keeps getting bigger',
  'a deadline that cannot move: tonight, before the wedding, before the last bus',
  'two people who need the same thing, and only one can have it',
  'an ordinary object that passes from hand to hand and changes meaning each time',
  'a favour that comes with a price, revealed later',
  'someone pretending to be what they are not, and the one person who notices',
  'a rule of the community that the protagonist has to break',
  'the protagonist is right but cannot prove it',
  'an overheard sentence, misunderstood',
  'a debt, of money or of honour, that falls due',
  'a role reversal: the one who always gives must finally ask',
  'enemies forced into an alliance for one night',
  'a small kindness with enormous consequences',
  'a test the protagonist does not know they are taking',
];
const STRUCTURES = [
  'tell it almost in real time',
  'open at the worst moment, and let the present action reveal how it came to this (no flashbacks)',
  'the audience learns the truth one scene before the protagonist does',
  'a quiet, ordinary opening that detonates at the midpoint',
  'every scene ends on a question the next scene answers with a surprise',
  'a two-hander: two people, one place, rising pressure',
  'the ending changes the meaning of the opening image',
  'the antagonist is sympathetic, and has a point',
];
const TEXTURES = [
  'a specific trade shown in loving detail: the hands at work',
  'food and its preparation as the emotional language',
  'a recurring sound that means something different each time it returns',
  'heat, cold or weather as pressure on everyone',
  'a family ritual, interrupted',
  'an object with a history, worn smooth by use',
  'a familiar place at the one hour of the day when it feels different',
  'humour that cuts the tension at the worst possible moment',
  'a character who notices small things, and what they notice',
  'money made visible: counted notes, a price tag, a bill left unpaid',
];

/** A small deterministic generator, so a retried step gets the same sparks. */
function seeded(seed: string) {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000; };
}
export const pick = <T>(rand: () => number, arr: T[]) => arr[Math.floor(rand() * arr.length)];

/** One story engine, one structure, one texture: optional, and only used if they serve the idea. */
export function sparksFor(seed: string): string[] {
  const r = seeded(seed);
  return [`Engine: ${pick(r, ENGINES)}`, `Structure: ${pick(r, STRUCTURES)}`, `Texture: ${pick(r, TEXTURES)}`];
}

/** Rotate a list deterministically (exemplars, examples) so repeated calls don't always see the same first items. */
export function shuffled<T>(seed: string, arr: T[]): T[] {
  const r = seeded(seed), a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Run tasks with at most `n` in flight, keeping results in order. */
export async function inParallel<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ───────────────────────── the customer's earlier stories ─────────────────────────

export async function recentWork(ownerId: string, excludeId: string, limit = 12): Promise<string[]> {
  const rows = await sql`select title, story_bible from projects where owner_id = ${ownerId} and id <> ${excludeId}
    and story_bible ? 'logline' order by created_at desc limit ${limit}`;
  return rows.map((r: any) => {
    const names = (r.story_bible?.characters || []).map((c: any) => c.name).filter(Boolean).slice(0, 5);
    return `"${r.title}": ${String(r.story_bible?.logline || '').slice(0, 160)}${names.length ? ` (characters: ${names.join(', ')})` : ''}`;
  });
}


// ───────────────────────── budgets and rhythm ─────────────────────────

const up = (s: any) => String(s || '').toUpperCase().trim();
const oneLine = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s: any) => up(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A cue-safe id: capital letters A to Z, digits and underscores ("Zoë Kaur" → "ZOE_KAUR"). */
export const asciiId = (s: any) => up(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const isEnglish = (language = '') => !language.trim() || /^en(glish)?\b/i.test(language.trim());

/** Scenes per episode for the format: microdramas cut fast (10 to 25 s scenes), the others breathe (15 to 45 s). */
export function sceneRange(format: string, seconds: number): [number, number] {
  const [lo, hi] = format === 'microdrama' ? [10, 25] : [15, 45];
  const min = Math.max(2, Math.ceil(seconds / hi));
  return [min, Math.max(min, Math.floor(seconds / lo))];
}

/** What a scene of `seconds` holds at our pacing estimate: about 60% dialogue and 40% action, or all action. */
export function budget(seconds: number) {
  const s = Math.max(4, Math.round(seconds));
  const action = Math.round((s * 0.4) / ACTION_SPW);
  return { seconds: s, dialogue: Math.round(s * 0.6 * SPEECH_WPS), action, actionLines: Math.max(1, Math.round(action / 12)), silentAction: Math.round(s / ACTION_SPW) };
}

/** The beat grid of an episode, per format, at fractions of its runtime. */
const RHYTHMS: Record<string, [number, string][]> = {
  microdrama: [
    [0, 'HOOK (first 3 seconds): open in the middle of the conflict at its most charged moment (an accusation, a humiliation, a discovery, a door slammed). Something is already happening; no establishing.'],
    [0.25, 'FIRST TURN: the situation flips: a reveal, a betrayal, a shift of power.'],
    [0.55, 'ESCALATION: the stakes jump; failing now costs someone personally, and soon.'],
    [0.8, 'PEAK: the confrontation or reveal the episode has been building to.'],
    [0.9, 'CLIFFHANGER (last seconds): a new reveal or threat; cut before the answer, on a face or an object.'],
  ],
  short_film: [
    [0, 'HOOK (first 5 seconds): a specific, visual event that raises a question.'],
    [0.15, 'INCITING TURN: the ordinary breaks; the protagonist wants something, now.'],
    [0.5, 'MIDPOINT REVERSAL: what they believed turns out wrong; the stakes change.'],
    [0.75, 'CRISIS: the hardest choice, the lowest point.'],
    [0.88, 'CLIMAX: the choice is made, in action.'],
    [0.95, 'LANDING: the final image, ideally one that echoes the opening or changes its meaning.'],
  ],
  web_series: [
    [0, "HOOK (first 5 seconds): something specific happens that raises this episode's question."],
    [0.33, 'TURN: a complication breaks the plan.'],
    [0.66, 'TURN: the stakes rise; someone is cornered.'],
    [0.9, 'HOOK OUT: end on a reveal or a decision that demands the next episode (in the final episode: the payoff, then one last image).'],
  ],
};
RHYTHMS.youtube = RHYTHMS.short_film;

/** The beat grid for one episode with the seconds worked out, e.g. "about 19s: FIRST TURN: ...". */
export const rhythm = (format: string, seconds: number) =>
  (RHYTHMS[format] || RHYTHMS.short_film).map(([at, what]) => `${at ? `about ${Math.round(at * seconds)}s` : '0s'}: ${what}`);

// ───────────────────────── the bible ─────────────────────────

const OVERUSED_NAMES = ['maya', 'elena', 'elara', 'aria', 'lila', 'luna', 'zara', 'nova', 'kai', 'leo', 'liam', 'ethan', 'noah', 'eli', 'jax',
  'sarah', 'emily', 'marcus', 'julian', 'silas', 'theo', 'ava', 'mia', 'chloe'];
const firstName = (n: any) => oneLine(n).split(' ')[0] || '';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Characters whose first name is one every AI story reaches for (unless the customer asked for it). */
export function overusedNames(characters: any[], customerPrompt = ''): { id: string; name: string }[] {
  return (Array.isArray(characters) ? characters : []).filter((c) => {
    const f = firstName(c?.name).toLowerCase();
    return f && OVERUSED_NAMES.includes(f) && !new RegExp(`\\b${esc(f)}\\b`, 'i').test(customerPrompt);
  }).map((c) => ({ id: up(c.id), name: oneLine(c.name) }));
}

/** Rename characters everywhere in the bible: full name, first name, and the id when it was the first name. */
export function applyRenames<T>(bible: T, renames: { id: string; name: string }[]): T {
  const chars: any[] = (bible as any)?.characters || [];
  const used = new Set(chars.map((c) => up(c.id)));
  let text = JSON.stringify(bible);
  for (const r of renames || []) {
    const c = chars.find((x) => up(x.id) === up(r.id)), name = oneLine(r.name);
    if (!c || !name || name === oneLine(c.name)) continue;
    const oldFirst = firstName(c.name), newFirst = firstName(name);
    text = text.replace(new RegExp(`\\b${esc(oneLine(c.name))}\\b`, 'g'), name);
    if (oldFirst && oldFirst !== newFirst) text = text.replace(new RegExp(`\\b${esc(oldFirst)}\\b`, 'g'), newFirst);
    if (up(c.id) === asciiId(oldFirst)) {
      let id = asciiId(newFirst) || up(c.id);
      while (used.has(id) && id !== up(c.id)) id += '_2';
      used.add(id);
      text = text.replace(new RegExp(`\\b${esc(up(c.id))}\\b`, 'g'), id);
    }
  }
  return JSON.parse(text);
}

/** A developed bible made safe to write from (cue-safe unique ids, capitalised set names), or the reason it can't be used. */
export function cleanBible(raw: any, episodes: number): { bible: any; problem: string } {
  if (!raw || typeof raw !== 'object') return { bible: raw, problem: 'there was no story bible' };
  if (!Array.isArray(raw.characters) || !raw.characters.length) return { bible: raw, problem: 'the bible has no characters' };
  if (!Array.isArray(raw.sets) || !raw.sets.length) return { bible: raw, problem: 'the bible has no sets' };
  if (!Array.isArray(raw.episodes) || raw.episodes.length < episodes) return { bible: raw, problem: `the bible plans ${Array.isArray(raw.episodes) ? raw.episodes.length : 0} episode(s), ${episodes} were asked for` };
  // Ids become screenplay cues, so they must be capital Latin letters and unique; relationships follow the new ids.
  const bible = JSON.parse(JSON.stringify(raw));
  const used = new Set<string>(), renamed = new Map<string, string>();
  bible.characters = bible.characters.filter((c: any) => c && typeof c === 'object').map((c: any, n: number) => {
    let id = asciiId(c.id) || asciiId(firstName(c.name)) || `CHARACTER_${n + 1}`;
    while (used.has(id)) id += '_2';
    used.add(id);
    if (oneLine(c.id) && oneLine(c.id) !== id) renamed.set(oneLine(c.id), id);
    return { ...c, id, name: oneLine(c.name) || id };
  });
  bible.relationships = (Array.isArray(bible.relationships) ? bible.relationships : []).map((r: any) => {
    let between = oneLine(r?.between);
    for (const [from, to] of renamed) between = between.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${esc(from)}(?![\\p{L}\\p{N}_])`, 'gu'), to);
    return { ...r, between };
  });
  bible.sets = bible.sets.map((s: any) => ({ ...s, name: up(oneLine(s?.name).replace(/^(INT|EXT)\.?\s+/i, '')) })).filter((s: any) => s.name);
  bible.plants = (Array.isArray(bible.plants) ? bible.plants : []).filter((p: any) => p?.id).map((p: any) => ({ ...p, id: up(p.id) }));
  return { bible, problem: '' };
}

// ───────────────────────── scene cards ─────────────────────────

export interface CardOut {
  set: string; int_ext: 'INT' | 'EXT'; time: 'DAY' | 'NIGHT' | 'DAWN' | 'DUSK'; characters: string[]; seconds: number;
  purpose: string; objectives: { who: string; wants: string; tactic: string }[]; subtext: string; turn: string; value: string;
  key_image: string; exit: string; plants: string[]; payoffs: string[]; heading: string;
}

const TIMES: Record<string, string> = { DAY: 'DAY', NIGHT: 'NIGHT', DAWN: 'DAWN', DUSK: 'DUSK', MORNING: 'DAY', AFTERNOON: 'DAY', NOON: 'DAY', EVENING: 'DUSK', SUNSET: 'DUSK', SUNRISE: 'DAWN', MIDNIGHT: 'NIGHT', 'LATE NIGHT': 'NIGHT' };
const castOf = (bible: any): BibleCharacter[] => (bible?.characters || []).map((c: any) => ({ ...c, id: up(c.id) }));

/** Scene cards checked against the bible: known sets and characters, seconds scaled to the episode's runtime. */
export function cleanOutline(raw: any, bible: any, seconds: number, range: [number, number]): { cards: CardOut[]; problem: string } {
  const cast = castOf(bible), match = characterMatcher(cast), ids = new Set(cast.map((c) => c.id));
  const who = (x: any) => { const k = match.fromCue(oneLine(x)); return ids.has(k) ? k : ''; };
  const sets: string[] = (bible?.sets || []).map((s: any) => up(s.name)).filter(Boolean);
  // A set named a little differently ("the flat" for ASMA FLAT) is the same set: by name, then by shared words.
  const tokens = (x: string) => key(x).split(' ').filter((t) => t.length > 2 && !['THE', 'AND', 'OUTSIDE', 'INSIDE'].includes(t));
  const setOf = (x: any) => {
    const k = key(x), mine = tokens(k);
    if (!k) return sets[0] || 'UNKNOWN';
    const exact = sets.find((s) => key(s) === k) || sets.find((s) => key(s).includes(k) || k.includes(key(s)));
    if (exact) return exact;
    const best = sets.map((s) => ({ s, shared: tokens(s).filter((t) => mine.includes(t)).length })).sort((a, b) => b.shared - a.shared)[0];
    return best && best.shared && best.shared >= mine.length / 2 ? best.s : up(oneLine(x));
  };
  const plantIds = new Set((bible?.plants || []).map((p: any) => up(p.id)));
  const refs = (a: any) => [...new Set((Array.isArray(a) ? a : []).map(up).filter((x: string) => plantIds.has(x)))];
  const cards: CardOut[] = (Array.isArray(raw?.scenes) ? raw.scenes : []).filter((c: any) => c && typeof c === 'object').map((c: any) => {
    const characters = [...new Set((Array.isArray(c.characters) ? c.characters : []).map(who).filter(Boolean))] as string[];
    const objectives = (Array.isArray(c.objectives) ? c.objectives : []).map((o: any) => ({ who: who(o?.who), wants: oneLine(o?.wants), tactic: oneLine(o?.tactic) })).filter((o: any) => o.who);
    for (const o of objectives) if (!characters.includes(o.who)) characters.push(o.who);
    const int_ext = up(c.int_ext) === 'EXT' ? 'EXT' : 'INT';
    const time = (TIMES[up(c.time)] || 'DAY') as CardOut['time'];
    const set = setOf(c.set).replace(/\s+-\s+/g, ' ');
    return {
      set, int_ext, time, characters, seconds: Math.round(+c.seconds) || 0,
      purpose: oneLine(c.purpose), objectives, subtext: oneLine(c.subtext), turn: oneLine(c.turn), value: oneLine(c.value),
      key_image: oneLine(c.key_image), exit: oneLine(c.exit), plants: refs(c.plants), payoffs: refs(c.payoffs),
      heading: `${int_ext}. ${set} - ${time}`,
    };
  });
  if (!cards.length) return { cards, problem: 'the outline has no scenes' };
  if (cards.length < range[0] - 1 || cards.length > range[1] + 2) return { cards, problem: `it has ${cards.length} scenes, but this runtime needs ${range[0]} to ${range[1]}` };
  if (cards.filter((c) => !c.characters.length).length > cards.length / 2) return { cards, problem: `most scenes name no characters from the bible; use these ids: ${[...ids].join(', ')}` };
  // Seconds: what the outline proposed, kept in proportion and scaled to the runtime.
  const raw0 = cards.map((c) => Math.min(60, Math.max(6, c.seconds || seconds / cards.length)));
  const sum = raw0.reduce((a, b) => a + b, 0);
  const secs = raw0.map((x) => Math.max(4, Math.round((x * seconds) / sum)));
  const big = secs.indexOf(Math.max(...secs));
  secs[big] = Math.max(4, secs[big] + seconds - secs.reduce((a, b) => a + b, 0));
  cards.forEach((c, i) => { c.seconds = secs[i]; });
  return { cards, problem: '' };
}

/** Setups the bible relies on that the outline drops, or pays off before planting: notes for the critic. */
export function plantNotes(bible: any, outline: CardOut[][]): string[] {
  const first = (kind: 'plants' | 'payoffs', id: string) => {
    let n = 0;
    for (const ep of outline) for (const c of ep) { n++; if (c[kind].includes(id)) return n; }
    return 0;
  };
  const notes: string[] = [];
  for (const p of bible?.plants || []) {
    const set = first('plants', p.id), paid = first('payoffs', p.id);
    if (!set && !paid) notes.push(`setup ${p.id} (${oneLine(p.setup)}) never reaches the screen`);
    else if (!set) notes.push(`${p.id} pays off (${oneLine(p.payoff)}) without being set up: plant it earlier`);
    else if (paid && paid < set) notes.push(`${p.id} pays off before it is set up`);
    else if (!paid) notes.push(`${p.id} (${oneLine(p.setup)}) is set up but never pays off`);
  }
  return notes;
}

// ───────────────────────── written scenes ─────────────────────────

/** A written scene made safe: known speakers, one line per element, consecutive lines of one speaker merged. */
export function cleanScene(raw: any, bible: any): { elements: SceneElement[]; unknown: string[] } {
  const cast = castOf(bible), match = characterMatcher(cast), ids = new Set(cast.map((c) => c.id));
  const elements: SceneElement[] = [], unknown = new Set<string>();
  for (const e of Array.isArray(raw?.elements) ? raw.elements : []) {
    const text = oneLine(e?.text);
    if (!text) continue;
    const speaker = oneLine(e?.who);
    if (e?.kind === 'action' || !speaker) { elements.push({ kind: 'action', text }); continue; }
    const k = match.fromCue(speaker);
    const id = ids.has(k) ? k : asciiId(speaker) || k;
    if (!ids.has(id)) unknown.add(id);
    const paren = oneLine(e?.paren).replace(/^\(+|\)+$/g, '').trim();
    const last = elements[elements.length - 1];
    if (last?.kind === 'line' && last.who === id && !paren) { last.text += ' ' + text; continue; }
    elements.push({ kind: 'line', who: id, paren, text });
  }
  return { elements, unknown: [...unknown] };
}

/** Seconds a scene plays for, by the same estimate the breakdown uses. */
export function elementSeconds(els: SceneElement[]) {
  let dw = 0, aw = 0;
  for (const e of els) if (e.kind === 'line') dw += words(e.text); else aw += words(e.text);
  return Math.max(4, Math.round(dw / SPEECH_WPS + aw * ACTION_SPW));
}

/** Why a written scene should be redone, or '' when it can be used. */
export function sceneProblem(s: { elements: SceneElement[]; unknown: string[] }, seconds: number, cast: string[]): string {
  if (!s.elements.length) return 'the scene was empty';
  if (s.unknown.length) return `${s.unknown.join(', ')} ${s.unknown.length > 1 ? 'are' : 'is'} not in this story's cast: give those lines to ${cast.join(', ')} or turn them into action`;
  const secs = elementSeconds(s.elements), b = budget(seconds);
  if (secs > seconds * 1.8 + 4) return `it plays about ${secs}s but the scene has about ${seconds}s: cut to about ${b.dialogue} words of dialogue and ${b.actionLines} short action line(s)`;
  if (secs < seconds * 0.45 - 2) return `it plays only about ${secs}s but the scene has about ${seconds}s: let it breathe, about ${b.dialogue} words of dialogue and ${b.actionLines} action line(s)`;
  return '';
}

// ───────────────────────── screenplay checks ─────────────────────────

const STOCK_LINES: [RegExp, string][] = [
  [/\bwe need to talk\b/i, 'We need to talk'], [/\bit'?s not what it looks like\b/i, "It's not what it looks like"],
  [/\bi can explain\b/i, 'I can explain'], [/\byou don'?t understand\b/i, "You don't understand"],
  [/\bwhat have you done\b/i, 'What have you done'], [/\bthis changes everything\b/i, 'This changes everything'],
  [/\bi'?ve been waiting for you\b/i, "I've been waiting for you"], [/\bafter all these years\b/i, 'After all these years'],
  [/\bit'?s complicated\b/i, "It's complicated"], [/^\s*trust me[.!]?\s*$/i, 'Trust me'],
];
// "The note reads: ..." / "the screen says ..." — legible text the video model can't render.
const READABLE_TEXT = /\b(sign|screen|message|text|note|letter|headline|caption|label|banner|board|display)\s+(reads|says|shows|displays)\b|\b(reads|says):\s*["“]/i;
// English dialogue: feelings named instead of played, and exposition both people already know.
const NAMED_FEELING = /\bI(?:'m|’m| am| feel| felt)\s+(?:so |really |very |just |too |completely )?(angry|sad|hurt|scared|afraid|frightened|terrified|happy|jealous|betrayed|furious|upset|devastated|heartbroken|lonely|confused|disappointed|guilty|ashamed|anxious|nervous|overwhelmed)\b/i;
const EXPOSITION = /\b(as you know|as you'?re aware|as you are aware|remember when we|let me remind you|like I told you before)\b/i;
const FILLER = /^(look|listen|wait|okay|ok|well|so|hey|um|uh)\b\s*[,.!…—-]/i;
// Action lines: what a camera can't see, and camera directions that belong to the director.
const UNFILMABLE = /\b(realizes?|realises?|realizing|realising|wonders?|wondering|thinks? (?:about|of|that)|feels? (?:that|like|as if|a (?:wave|surge|pang|rush|sense))|knows? that|decides? to|memories|deep down|can'?t help but)\b/i;
const CAMERA = /\b(we see|we hear|we watch|close on|angle on|camera (?:pans|moves|pushes|tracks|follows|zooms|cuts|holds)|pans? (?:to|across)|zooms? (?:in|out|on)|cut to)\b/i;

// Capitalised words that start sentences or name formats, never a character or place the customer named.
const NOT_NAMES = new Set(('a an the in on at of and but or so to for from with without into when while after before during until since if as once ' +
  'one two three four five six seven eight nine ten some every each all no our my his her their its your this that these those there here ' +
  'he she they we i it you who what why how where young old new last first lonely rival local small big ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
  'youtube tiktok instagram netflix episode part story film series ceo mr mrs ms dr sir god').split(' '));

/** Names and places the customer's idea spells out (capitalised words that aren't sentence starters or common words). */
export function namedInIdea(prompt: string): string[] {
  const out = new Set<string>();
  for (const sentence of String(prompt || '').split(/(?<=[.!?…])\s+|\n+/)) {
    const ws = sentence.match(/[\p{L}][\p{L}'’-]*/gu) || [];
    ws.forEach((w, i) => {
      const bare = w.replace(/['’]s$/, '');
      if (!/^\p{Lu}\p{Ll}/u.test(bare) || NOT_NAMES.has(bare.toLowerCase())) return;
      if (i === 0 && bare.length < 4) return;
      out.add(bare);
    });
  }
  return [...out];
}

export interface StoryReport {
  issues: string[];
  located: { episode: number; scene: number; issue: string }[];   // the per-scene subset, for targeted rewrites
  episodes: { seconds: number; target: number; scenes: number; lines: number; speakers: number; sets: number }[];
}

/**
 * Deterministic checks of a written production ({ characters, episodes: [{ script }] }, plus anything else whose text
 * should count for the customer's names, like the bible). English-only checks run only for English dialogue.
 */
export function storyLint(d: any, target: { seconds: number; language?: string }, customerPrompt = ''): StoryReport {
  const issues: string[] = [], located: StoryReport['located'] = [];
  const episodes: StoryReport['episodes'] = [];
  const at = (episode: number, scene: number, issue: string) => { located.push({ episode, scene, issue }); issues.push(`Episode ${episode}, scene ${scene}: ${issue}`); };
  const english = isEnglish(target.language);
  const bible: BibleCharacter[] = (Array.isArray(d?.characters) ? d.characters : []).map((c: any) => ({ ...c, id: up(c?.id || c?.name) }));
  const firstNames = bible.map((c) => ({ id: c.id, first: firstName(c.name) })).filter((x) => /^\p{Lu}\p{Ll}+$/u.test(x.first));

  for (const c of overusedNames(bible, customerPrompt)) issues.push(`"${c.name}" is one of the most overused AI character names; choose a name specific to this world`);
  const allSpeakers = new Set<string>(), allSets = new Set<string>();
  const seenLines = new Map<string, number>();
  (Array.isArray(d?.episodes) ? d.episodes : []).forEach((e: any, ei: number) => {
    const ep = ei + 1;
    const scenes = parseScenes(String(e?.script || ''), bible);
    const secs = scenes.reduce((t, s) => t + s.estSeconds, 0);
    const lo = Math.round(target.seconds * 0.8), hi = Math.round(target.seconds * 1.2);
    if (secs < lo || secs > hi) issues.push(`Episode ${ep} runs about ${secs}s; the target is ${target.seconds}s (${lo}–${hi}s). ${secs > hi ? 'Cut or tighten scenes.' : 'Add a beat or let moments breathe.'}`);
    let lines = 0, filler = 0, vocative = 0, whatMean = 0;
    const speakers = new Set<string>(), sets = new Set<string>();
    scenes.forEach((s, si) => {
      sets.add(s.location); allSets.add(s.location);
      if (s.estSeconds < 5) at(ep, s.idx, `only about ${s.estSeconds}s long: merge it or give it a turn`);
      if (READABLE_TEXT.test(s.body)) at(ep, s.idx, `relies on legible on-screen text, which the video model can't render: have a character read it aloud or react to it`);
      const els = parseFountain(s.body).filter((x) => x.t !== 'scene');
      const action = els.filter((x) => x.t === 'action').map((x) => x.text.replace(/\s+/g, ' '));
      const unfilmable = action.find((a) => UNFILMABLE.test(a)), camera = action.find((a) => CAMERA.test(a));
      if (unfilmable) at(ep, s.idx, `the action "${unfilmable.slice(0, 70)}" describes what a camera can't see; show the behaviour instead`);
      if (camera) at(ep, s.idx, `camera directions in the action ("${camera.slice(0, 50)}"): describe what happens; the director chooses the shots`);
      if (ep === 1 && si === 0 && els[0]?.t === 'action' && words(els[0].text) > 35) at(ep, s.idx, 'the film opens on a long description: open on something happening');
      const last = els[els.length - 1];
      if (si === scenes.length - 1 && last?.t === 'dia' && words(last.text) > 12) at(ep, s.idx, 'the episode ends on a long line: end on an image or a short, sharp line');
      for (const l of dialogueOf(s.body, bible)) {
        lines++; speakers.add(l.who); allSpeakers.add(l.who);
        if (speechSeconds(l.line) > 8.8) at(ep, s.idx, `${l.who}'s line is too long to land (keep lines under ~18 words): "${l.line.slice(0, 70)}…"`);
        if (english) {
          for (const [rx, name] of STOCK_LINES) if (rx.test(l.line)) at(ep, s.idx, `stock line "${name}" (${l.who}); write what this character would really say`);
          if (NAMED_FEELING.test(l.line)) at(ep, s.idx, `${l.who} names a feeling ("${l.line.slice(0, 50)}"): play it through what they do or say sideways`);
          if (EXPOSITION.test(l.line)) at(ep, s.idx, `${l.who} explains something both characters already know ("${l.line.slice(0, 50)}")`);
          if (FILLER.test(l.line)) filler++;
          if (/\bwhat do you mean\b/i.test(l.line)) whatMean++;
        }
        if (firstNames.some((x) => x.id !== l.who && new RegExp(`(^|[,.!?…]\\s*)${esc(x.first)}\\s*[,.!?…]|,\\s*${esc(x.first)}\\b`).test(l.line))) vocative++;
        if (l.paren && l.paren.split(/\s+/).length > 6) at(ep, s.idx, `the parenthetical ${l.paren} is too long; show it in action instead`);
        const k = l.line.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
        if (k.split(' ').length >= 4) seenLines.set(k, (seenLines.get(k) || 0) + 1);
      }
    });
    if (!scenes.length) issues.push(`Episode ${ep} has no scene headings`);
    if (filler > 3) issues.push(`Episode ${ep}: ${filler} lines open with filler ("Look,", "Listen,", "Wait,"): cut the throat-clearing`);
    if (vocative >= 3 && vocative > lines * 0.25) issues.push(`Episode ${ep}: characters call each other by name in ${vocative} of ${lines} lines; real people rarely do`);
    if (whatMean > 1) issues.push(`Episode ${ep}: "What do you mean" ${whatMean} times; let the listener act on the line instead`);
    episodes.push({ seconds: secs, target: target.seconds, scenes: scenes.length, lines, speakers: speakers.size, sets: sets.size });
  });
  if (allSpeakers.size > 4) issues.push(`${allSpeakers.size} speaking characters (${[...allSpeakers].join(', ')}); keep it to 4 or fewer so every face stays consistent`);
  if (allSets.size > 4) issues.push(`${allSets.size} different sets (${[...allSets].join(', ')}); keep it to 4 or fewer and reuse them`);
  for (const [line, n] of seenLines) if (n > 1) issues.push(`the line "${line.slice(0, 60)}" is repeated ${n} times`);
  const text = JSON.stringify(d || {}).toLowerCase();
  for (const name of namedInIdea(customerPrompt)) if (!text.includes(name.toLowerCase())) issues.push(`the customer's idea names "${name}", which the story has lost`);
  return { issues: [...new Set(issues)].slice(0, 60), located, episodes };
}
