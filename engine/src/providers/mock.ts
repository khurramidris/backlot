// Local stand-ins for Claude, MiniMax and image APIs (MOCK_PROVIDERS=1). They produce
// placeholder images, tones and labelled test clips so the whole pipeline can run —
// including assembly — with no keys and no spend. Never used in production.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { placeholderImage, placeholderVideo, ffmpeg } from '../media/ffmpeg.js';
import { ProviderError } from './minimax.js';

const up = (s: any) => String(s || '').toUpperCase().trim();
const snake = (s: any) => up(s).replace(/['’]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

// ───────────────────────── Claude ─────────────────────────

const PROP_WORDS = ['ledger', 'phone', 'note', 'letter', 'ring', 'key', 'photo', 'photograph', 'bag', 'knife', 'gun', 'envelope', 'prescription', 'notebook', 'laptop', 'watch', 'necklace', 'file', 'pen', 'pencil', 'box', 'bottle', 'pill', 'card', 'diary'];

export function mockClaudeJSON(task: string, input: any): any {
  if (task === 'develop') return mockDevelop(input);
  if (task === 'write' || task === 'screenplay') return mockWrite(input);
  if (task === 'doctor') return { ...input.draft, notes: input.checks?.length ? ['tightened the flagged lines'] : [] };
  if (task === 'direct') return mockDirect(input);
  if (task === 'breakdown') return mockBreakdown(input);
  if (task === 'shots') return mockShots(input);
  if (task === 'retake') {
    const plan = JSON.parse(JSON.stringify(input.plan));
    if (plan.beats?.[0]) plan.beats[0].action = `${plan.beats[0].action} (${input.note})`;
    return plan;
  }
  return {};
}

/** Three takes and a treatment that match the mock screenplay below (same ids and sets). */
function mockDevelop(input: any) {
  const idea = String(input.prompt || 'A story').replace(/\s+/g, ' ').trim();
  const concept = (n: number) => ({ title: `${idea.slice(0, 30)} (${n})`, logline: idea.slice(0, 120), engine: 'a secret', ending: 'the truth comes out', fresh_because: `take ${n}` });
  const eps = input.episodes || 1;
  return {
    concepts: [concept(1), concept(2), concept(3)], chosen: 0,
    treatment: {
      title: idea.slice(0, 40), logline: idea.slice(0, 120), genre: 'drama', tone: 'intimate, tense', theme: 'the cost of keeping a secret',
      dramatic_question: 'Will she tell him the truth?',
      world: { place: 'a quiet city neighbourhood', era: 'present day', social_world: 'working families', sensory_palette: ['steam from a pot', 'a buzzing streetlight', 'worn linoleum'] },
      characters: [
        { id: 'MAYA', name: 'Maya Rahman', age: '31', role: 'lead', want: 'to keep her past buried', obstacle: 'Leo', secret: 'why she left', arc: 'from hiding to honesty', voice: { manner: 'guarded', vocabulary: 'plain', rhythm: 'short sentences', never_says: 'sorry' }, look: 'slim, black hair, grey cardigan' },
        { id: 'LEO', name: 'Leo Carter', age: '34', role: 'lead', want: 'the truth', obstacle: 'her silence', secret: 'he read the letter', arc: 'from anger to understanding', voice: { manner: 'earnest', vocabulary: 'simple', rhythm: 'halting', never_says: 'goodbye' }, look: 'tall, stubble, navy coat' },
      ],
      sets: [{ name: 'KITCHEN', description: 'a small warm kitchen', story_function: 'her refuge' }, { name: 'STREET', description: 'a quiet street at night', story_function: 'his approach' }],
      episodes: Array.from({ length: eps }, (_, i) => ({ number: i + 1, title: `Part ${i + 1}`, beats: [{ beat: 'She ignores a call', set: 'KITCHEN', characters: ['MAYA'], turn: 'tension' }, { beat: 'He arrives with the letter', set: 'KITCHEN', characters: ['MAYA', 'LEO'], turn: 'confrontation' }], ending: 'Then you know why I left.' })),
      motifs: ['the envelope'], avoid: ['a tearful reconciliation'],
    },
  };
}

/** A direction plan with one entry per scene. */
function mockDirect(input: any) {
  return {
    visual_approach: 'close, observational camera that tightens as the secret surfaces',
    motifs: ['the envelope'],
    scenes: (input.scenes || []).map((s: any, i: number) => ({
      scene: s.idx, purpose: 'move the story', temperature: Math.min(10, 3 + i * 2), pace: i ? 'measured' : 'slow',
      key_image: `the key image of scene ${s.idx}`, camera: 'handheld, close', light: 'warm practicals', blocking: 'she holds frame left',
      opening_image: `scene ${s.idx} opens`, closing_image: `scene ${s.idx} closes`, shots: 2,
    })),
  };
}

/** A small, valid two-set, two-character production built around the customer's idea. */
function mockWrite(input: any) {
  const idea = String(input.prompt || 'A story').replace(/\s+/g, ' ').trim();
  const episode = (n: number) => `INT. KITCHEN - NIGHT

MAYA stirs a pot. Her phone buzzes on the counter. She ignores it.

MAYA
Not tonight. Please, not tonight.

EXT. STREET - NIGHT

LEO waits under a streetlight, turning a small envelope in his hands.

LEO
She has to hear it from me. Episode ${n}.

INT. KITCHEN - NIGHT

The door opens. LEO steps in. MAYA freezes, the spoon still in her hand.

LEO
I found the letter.

MAYA
Then you know why I left.`;
  return {
    title: idea.slice(0, 40),
    logline: idea.slice(0, 120),
    world: 'A quiet city neighbourhood, present day.',
    style: { look: 'intimate drama', camera: 'handheld, 35mm', lighting: 'warm practicals', grade: 'soft teal and amber', negative: '' },
    characters: [
      { id: 'MAYA', name: 'Maya Rahman', age: '31', role: 'lead', description: 'Slim woman, shoulder-length black hair, tired eyes, grey cardigan.', voice: 'Low, warm, guarded.' },
      { id: 'LEO', name: 'Leo Carter', age: '34', role: 'lead', description: 'Tall man, short brown hair, stubble, navy coat.', voice: 'Soft, earnest, slightly hoarse.' },
    ],
    episodes: Array.from({ length: input.episodes || 1 }, (_, i) => ({ title: `Part ${i + 1}`, script: episode(i + 1) })),
  };
}

function mockBreakdown(input: any) {
  const scenes: any[] = input.scenes;
  const sets = new Map<string, any>();
  for (const s of scenes) {
    const key = snake(s.location.split(' - ').slice(-1)[0] || s.location) || 'SET';
    const base = snake(s.location) || key;
    let set = sets.get(base);
    if (!set) { set = { key: base, name: s.location.replace(/\b\w/g, (c: string) => c).toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()), building: snake(s.location.split(' - ')[0]), int_ext: s.int_ext, description: `${s.int_ext === 'EXT' ? 'Exterior' : 'Interior'} of ${s.location.toLowerCase()}, lived-in, specific to the story world.`, layout: 'Main action area in the centre; entrance behind camera.', variants: [], scenes: [], times: new Set<string>() }; sets.set(base, set); }
    set.scenes.push(s.ref); set.times.add(s.time || 'DAY');
  }
  for (const set of sets.values()) {
    if (set.times.size > 1) {
      for (const t of set.times) set.variants.push({ key: snake(t), name: t.toLowerCase(), change: `${t.toLowerCase()} lighting`, scenes: scenes.filter((s) => set.scenes.includes(s.ref) && (s.time || 'DAY') === t).map((s) => s.ref) });
    }
    delete set.times;
  }
  const chars = new Map<string, any>();
  for (const c of input.characters) chars.set(up(c.key), { key: up(c.key), name: c.name || c.key, is_minor: +c.age > 0 && +c.age < 18, description: c.prior_design || `${c.age ? c.age + '-year-old ' : ''}${c.name}, distinctive face, as written in the script.`, looks: [{ key: 'DEFAULT', name: 'Default', wardrobe: 'everyday clothes true to the story world', scenes: [] }], voice: { brief: c.voice_notes || 'natural adult voice', sample_line: `You always notice the small things, don't you? That's what worries me.` }, scenes: [] });
  for (const s of scenes) for (const k of s.present) {
    if (!chars.has(k)) chars.set(k, { key: k, name: k.charAt(0) + k.slice(1).toLowerCase(), description: `${k.toLowerCase()}, as described in the script`, looks: [{ key: 'DEFAULT', name: 'Default', wardrobe: 'plain clothes', scenes: [] }], voice: { brief: 'natural voice', sample_line: 'I only came to say one thing, and then I will go.' }, scenes: [] });
    const c = chars.get(k); c.scenes.push(s.ref); c.looks[0].scenes.push(s.ref);
  }
  const props: any[] = [];
  for (const w of PROP_WORDS) {
    const hits = scenes.filter((s) => new RegExp(`\\b${w}s?\\b`, 'i').test(s.excerpt)).map((s) => s.ref);
    if (hits.length >= 2 || (hits.length === 1 && props.length < 2)) props.push({ key: snake(w), name: w, description: `A specific, worn ${w} that matters to the story.`, owner: '', scenes: hits });
  }
  return {
    style: { look: input.style?.look || 'grounded, naturalistic drama', camera: input.style?.camera || '35mm, handheld close coverage', lighting: input.style?.lighting || 'motivated practical light', grade: input.style?.grade || 'soft contrast, natural skin', negative: input.style?.negative || 'glossy advertising look' },
    characters: [...chars.values()].filter((c) => c.scenes.length),
    sets: [...sets.values()],
    props: props.slice(0, 6),
  };
}

function mockShots(input: any) {
  const d: any[] = input.dialogue || [];
  const shots: any[] = [];
  const chars = (input.characters || []).map((c: any) => c.key);
  shots.push({ duration: 5, purpose: 'establish', characters: chars, props: (input.props || []).slice(0, 1).map((p: any) => p.key), sound: 'room tone',
    covers: (input.actions || []).map((_: any, i: number) => i + 1),
    beats: [{ t0: 0, t1: 3, shot: 'wide', lens: 'wide 24mm', camera: 'slow push-in', action: `Establish ${input.scene?.body?.split('\n')[0] || 'the scene'}`, blocking: 'lead frame left' }, { t0: 3, t1: 5, shot: 'medium', lens: 'normal 35mm', camera: 'static', action: 'Hold on the lead.', performance: 'a held breath' }] });
  for (let i = 0; i < d.length; i += 2) {
    const pair = d.slice(i, i + 2);
    shots.push({ duration: 8, purpose: 'exchange', characters: [...new Set(pair.map((x) => x.who))], props: [], sound: 'room tone',
      beats: pair.map((x, k) => ({ t0: k * 4, t1: k * 4 + 4, shot: k ? 'close-up' : 'medium close-up', camera: 'static', action: `${x.who} speaks`, dialogue: [{ who: x.who, line: x.line, delivery: (x.paren || '').replace(/[()]/g, '') }] })) });
  }
  return { screen_positions: chars.length > 1 ? `${chars[0]} frame left, ${chars[1]} frame right` : '', shots };
}

// ───────────────────────── images & voice ─────────────────────────

const COLORS: Record<string, string> = { character: '#6b3a3a', look: '#6b4a2a', location: '#2b4a55', set_variant: '#2b3a65', prop: '#3a5a3a' };
function dims(aspect: string) {
  const [a, b] = aspect.split(':').map(Number);
  if (!a || !b) return [768, 768];
  return a >= b ? [1024, Math.round((1024 * b) / a / 8) * 8] : [Math.round((1024 * a) / b / 8) * 8, 1024];
}
export async function mockImage(req: { prompt: string; aspect: string; label?: string[] }) {
  if (req.prompt.includes('__fail__')) throw new ProviderError('mock image provider refused the prompt', 'sensitive_content', false); // lets tests prove failed work is refunded
  const dir = await mkdtemp(join(tmpdir(), 'mimg-'));
  try {
    const [w, h] = dims(req.aspect);
    const f = join(dir, 'x.png');
    await placeholderImage(f, [...(req.label || ['MOCK']), `${w}x${h}`], w, h, COLORS[req.label?.[1] || ''] || '#333333');
    return await readFile(f);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function mockVoice(line: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mvoice-'));
  try {
    const f = join(dir, 'v.mp3');
    const secs = Math.min(12, Math.max(3, line.split(' ').length / 2.4));
    await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${180 + Math.floor(Math.random() * 200)}:duration=${secs.toFixed(1)}`, '-ac', '1', '-b:a', '96k', f]);
    return { voiceId: 'mock-voice-' + randomUUID().slice(0, 8), audio: await readFile(f) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ───────────────────────── MiniMax H3 ─────────────────────────

const tasks = new Map<string, { status: string; url?: string; error?: string; usage?: any }>();
export const mockMinimax = {
  async createVideoTask(body: any) {
    const { validateH3 } = await import('../pipeline/compiler.js');
    validateH3(body);
    const id = String(Date.now()) + Math.floor(Math.random() * 1000);
    tasks.set(id, { status: 'queued' });
    const text: string = body.content.find((c: any) => c.type === 'text').text;
    const [w, h] = body.ratio === '9:16' ? [720, 1280] : body.ratio === '1:1' ? [960, 960] : body.ratio === '3:4' ? [720, 960] : [1280, 720];
    (async () => {
      tasks.set(id, { status: 'running' });
      const { storage } = await import('../storage.js');
      const dir = await mkdtemp(join(tmpdir(), 'mvid-'));
      try {
        const f = join(dir, 'v.mp4');
        const beats = text.split('\n').filter((l) => /^\d+–\d+s:/.test(l)).map((l) => l.slice(0, 46));
        await placeholderVideo(f, [`H3 mock ${body.duration}s ${body.resolution}`, ...beats.slice(0, 3)], body.duration, w, h, true);
        await storage.put(`mock/${id}.mp4`, await readFile(f), 'video/mp4');
        const refs = body.content.filter((c: any) => c.role === 'reference_video').length;
        tasks.set(id, { status: 'succeeded', url: `storage:mock/${id}.mp4`, usage: { output_seconds: body.duration, input_seconds: refs ? 5 : 0, total_seconds: body.duration } });
      } catch (e: any) { tasks.set(id, { status: 'failed', error: e.message }); }
      finally { await rm(dir, { recursive: true, force: true }); }
    })();
    return id;
  },
  async queryVideoTask(id: string) {
    const t = tasks.get(id) || { status: 'failed', error: 'unknown mock task (server restarted?)' };
    return { status: t.status, url: t.url, usage: t.usage, error: t.error, raw: t };
  },
};
