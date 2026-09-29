// Tools the writers' room uses to keep stories fresh and screenplays shootable:
// - sparks: optional creative prompts picked per project (seeded by its id), so two similar ideas
//   don't converge on the same story;
// - recentWork: the customer's earlier stories, so names, premises and twists aren't repeated;
// - storyLint: deterministic checks of a screenplay (runtime, line length, cast and set counts, stock
//   lines, overused names, text the video model can't render). The script doctor fixes what it finds,
//   and the final report is kept with the project.

import { createHash } from 'node:crypto';
import { sql } from '../db.js';
import { dialogueOf, parseScenes, type BibleCharacter } from './fountain.js';

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

// ───────────────────────── the customer's earlier stories ─────────────────────────

export async function recentWork(ownerId: string, excludeId: string, limit = 12): Promise<string[]> {
  const rows = await sql`select title, story_bible from projects where owner_id = ${ownerId} and id <> ${excludeId}
    and story_bible ? 'logline' order by created_at desc limit ${limit}`;
  return rows.map((r: any) => {
    const names = (r.story_bible?.characters || []).map((c: any) => c.name).filter(Boolean).slice(0, 5);
    return `"${r.title}": ${String(r.story_bible?.logline || '').slice(0, 160)}${names.length ? ` (characters: ${names.join(', ')})` : ''}`;
  });
}

// ───────────────────────── screenplay checks ─────────────────────────

const OVERUSED_NAMES = ['maya', 'elena', 'elara', 'aria', 'lila', 'luna', 'zara', 'nova', 'kai', 'leo', 'liam', 'ethan', 'noah', 'eli', 'jax',
  'sarah', 'emily', 'marcus', 'julian', 'silas', 'theo', 'ava', 'mia', 'chloe'];
const STOCK_LINES: [RegExp, string][] = [
  [/\bwe need to talk\b/i, 'We need to talk'], [/\bit'?s not what it looks like\b/i, "It's not what it looks like"],
  [/\bi can explain\b/i, 'I can explain'], [/\byou don'?t understand\b/i, "You don't understand"],
  [/\bwhat have you done\b/i, 'What have you done'], [/\bthis changes everything\b/i, 'This changes everything'],
  [/\bi'?ve been waiting for you\b/i, "I've been waiting for you"], [/\bafter all these years\b/i, 'After all these years'],
  [/\bit'?s complicated\b/i, "It's complicated"], [/^\s*trust me[.!]?\s*$/i, 'Trust me'],
];
// "The note reads: ..." / "the screen says ..." — legible text the video model can't render.
const READABLE_TEXT = /\b(sign|screen|message|text|note|letter|headline|caption|label|banner|board|display)\s+(reads|says|shows|displays)\b|\b(reads|says):\s*["“]/i;

export interface StoryReport {
  issues: string[];
  episodes: { seconds: number; target: number; scenes: number; lines: number; speakers: number; sets: number }[];
}

export function storyLint(d: any, target: { seconds: number }, customerPrompt = ''): StoryReport {
  const issues: string[] = [];
  const episodes: StoryReport['episodes'] = [];
  const bible: BibleCharacter[] = (Array.isArray(d?.characters) ? d.characters : []).map((c: any) => ({ ...c, id: String(c?.id || c?.name || '').toUpperCase() }));
  const idea = customerPrompt.toLowerCase();

  for (const c of bible) {
    const first = String(c.name || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (first && OVERUSED_NAMES.includes(first) && !idea.includes(first)) issues.push(`"${c.name}" is one of the most overused AI character names; choose a name specific to this world`);
  }
  const allSpeakers = new Set<string>(), allSets = new Set<string>();
  const seenLines = new Map<string, number>();
  (Array.isArray(d?.episodes) ? d.episodes : []).forEach((e: any, ei: number) => {
    const ep = `Episode ${ei + 1}`;
    const scenes = parseScenes(String(e?.script || ''), bible);
    const secs = scenes.reduce((t, s) => t + s.estSeconds, 0);
    const lo = Math.round(target.seconds * 0.8), hi = Math.round(target.seconds * 1.2);
    if (secs < lo || secs > hi) issues.push(`${ep} runs about ${secs}s; the target is ${target.seconds}s (${lo}–${hi}s). ${secs > hi ? 'Cut or tighten scenes.' : 'Add a beat or let moments breathe.'}`);
    let lines = 0;
    const speakers = new Set<string>(), sets = new Set<string>();
    scenes.forEach((s) => {
      sets.add(s.location); allSets.add(s.location);
      if (s.estSeconds < 5) issues.push(`${ep}, scene ${s.idx} (${s.heading}) is only about ${s.estSeconds}s: merge it or give it a turn`);
      if (READABLE_TEXT.test(s.body)) issues.push(`${ep}, scene ${s.idx} relies on legible on-screen text, which the video model can't render: have a character read it aloud or react to it`);
      for (const l of dialogueOf(s.body, bible)) {
        lines++; speakers.add(l.who); allSpeakers.add(l.who);
        const words = l.line.split(/\s+/).filter(Boolean).length;
        if (words > 20) issues.push(`${ep}, scene ${s.idx}: ${l.who}'s line has ${words} words (keep lines under ~18): "${l.line.slice(0, 70)}…"`);
        for (const [rx, name] of STOCK_LINES) if (rx.test(l.line)) issues.push(`${ep}, scene ${s.idx}: stock line "${name}" (${l.who}); write what this character would really say`);
        if (l.paren && l.paren.split(/\s+/).length > 6) issues.push(`${ep}, scene ${s.idx}: the parenthetical ${l.paren} is too long; show it in action instead`);
        const key = l.line.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
        if (key.split(' ').length >= 4) seenLines.set(key, (seenLines.get(key) || 0) + 1);
      }
    });
    if (!scenes.length) issues.push(`${ep} has no scene headings`);
    episodes.push({ seconds: secs, target: target.seconds, scenes: scenes.length, lines, speakers: speakers.size, sets: sets.size });
  });
  if (allSpeakers.size > 4) issues.push(`${allSpeakers.size} speaking characters (${[...allSpeakers].join(', ')}); keep it to 4 or fewer so every face stays consistent`);
  if (allSets.size > 4) issues.push(`${allSets.size} different sets (${[...allSets].join(', ')}); keep it to 4 or fewer and reuse them`);
  for (const [line, n] of seenLines) if (n > 1) issues.push(`the line "${line.slice(0, 60)}" is repeated ${n} times`);
  return { issues: [...new Set(issues)].slice(0, 40), episodes };
}
