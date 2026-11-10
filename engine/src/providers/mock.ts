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
  if (task === 'pitch') return mockPitch(input);
  if (task === 'choose') return { scores: (input.concepts || []).map((_: any, i: number) => ({ concept: i, fidelity: 5, hook: i === 1 ? 5 : 3, stakes: 4, specificity: 4, surprise: i === 1 ? 4 : 3, renderable: 5 })), chosen: 1, notes: ['make the envelope the first thing we see'] };
  if (task === 'bible') return mockBible(input);
  if (task === 'season') return { episodes: Array.from({ length: input.to - input.from + 1 }, (_, i) => ({ number: input.from + i, title: `Part ${input.from + i}`, summary: 'The secret spreads.', opening: 'a door slams', ending: 'a new threat' })) };
  if (task === 'rename') return { names: (input.rename || []).map((r: any, i: number) => ({ id: r.id, name: ['Rukhsana Rahman', 'Tomasz Carter', 'Ifeoma Bello', 'Matteo Rossi'][i % 4] })) };
  if (task === 'outline') return mockOutline(input);
  if (task === 'scene') return mockScene(input);
  if (task === 'critique') return mockCritique(input);
  if (task === 'judge') return { verdicts: (input.pairs || []).map((p: any, i: number) => ({ pair: i + 1, better: p.b.length > p.a.length ? 'B' : 'A', margin: 'clear' })) };
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

// The mock writers' room: a small, valid two-character, two-set story around the customer's idea, written through
// every step (pitch, choose, bible with names to recast, cards, scenes to budget, notes, one rewrite, judged drafts).

function mockPitch(input: any) {
  const idea = String(input.prompt || 'A story').replace(/\s+/g, ' ').trim();
  const take = (n: number) => ({ title: `${idea.slice(0, 30)} (${n + 1})`, protagonist: 'a woman who left home', logline: idea.slice(0, 120), world: 'a quiet city neighbourhood, present day',
    engine: 'a secret', hook: 'a phone buzzing face down by the stove', turn: 'he has read the letter', ending: 'the truth comes out', fresh_because: `take ${n + 1}` });
  return { concepts: [take(0), take(1), take(2)] };
}

function mockBible(input: any) {
  const idea = String(input.prompt || 'A story').replace(/\s+/g, ' ').trim();
  const eps = input.planned || input.episodes || 1;
  return {
    title: idea.slice(0, 40), logline: idea.slice(0, 120), genre: 'drama', tone: 'intimate, tense', theme: 'the cost of keeping a secret',
    dramatic_question: 'Will she tell him the truth?', season_arc: ['the secret comes back', 'the truth comes out'],
    world: { place: 'a quiet city neighbourhood', era: 'present day', social_world: 'working families', sensory_palette: ['steam from a pot', 'a buzzing streetlight', 'worn linoleum'] },
    characters: [
      { id: 'MAYA', name: 'Maya Rahman', age: '31', role: 'lead', want: 'to keep her past buried', obstacle: 'Leo', secret: 'why she left', arc: 'from hiding to honesty',
        voice: { manner: 'guarded', vocabulary: 'plain', rhythm: 'short sentences', habit: 'answers a question with a question', never_says: 'sorry', sample_lines: ['Not tonight.', 'Who told you that?'] }, look: 'slim, black hair, grey cardigan' },
      { id: 'LEO', name: 'Leo Carter', age: '34', role: 'lead', want: 'the truth', obstacle: 'her silence', secret: 'he read the letter', arc: 'from anger to understanding',
        voice: { manner: 'earnest', vocabulary: 'simple', rhythm: 'halting', habit: 'repeats the last word he heard', never_says: 'goodbye', sample_lines: ['I waited.', 'Then say it.'] }, look: 'tall, stubble, navy coat' },
    ],
    relationships: [{ between: 'MAYA & LEO', dynamic: 'they loved each other; she left without a word' }],
    sets: [{ name: 'KITCHEN', description: 'a small warm kitchen', story_function: 'her refuge' }, { name: 'STREET', description: 'a quiet street at night', story_function: 'his approach' }],
    plants: [{ id: 'P1', setup: 'the envelope in his hands', payoff: 'the envelope opened between them' }],
    episodes: Array.from({ length: eps }, (_, i) => ({ number: i + 1, title: `Part ${i + 1}`, summary: 'He comes back with the letter.', opening: 'her phone buzzing by the stove', ending: 'Then you know why I left.' })),
    motifs: ['the envelope'], avoid: ['a tearful reconciliation'],
    style: { look: 'intimate drama', camera: 'handheld, 35mm', lighting: 'warm practicals', grade: 'soft teal and amber', palette: 'amber, teal, grey', texture: 'fine grain', negative: '' },
  };
}

const CARDS = [
  { set: 0, who: [0], purpose: 'She hides from the call', wants: ['to keep tonight ordinary'], tactic: ['stays busy'], turn: 'the phone will not stop', value: 'calm → cornered', key_image: 'the phone buzzing face down by the stove', exit: 'she switches the phone off' },
  { set: 1, who: [1], purpose: 'He waits with the envelope', wants: ['the courage to knock'], tactic: ['waits'], turn: 'he crosses the street', value: 'doubt → resolve', key_image: 'the envelope turning in his hands', exit: 'he crosses toward her door' },
  { set: 0, who: [0, 1], purpose: 'The truth comes out', wants: ['him gone', 'the truth'], tactic: ['deflects', 'waits her out'], turn: 'she admits why she left', value: 'hidden → exposed', key_image: 'the envelope between them', exit: 'Then you know why I left.' },
];

function mockOutline(input: any) {
  const ids = (input.bible?.characters || []).map((c: any) => c.id), sets = (input.bible?.sets || []).map((s: any) => s.name);
  const n = Math.max(3, input.range?.[0] || 3);
  return {
    scenes: Array.from({ length: n }, (_, i) => {
      const t = CARDS[i === n - 1 ? 2 : i % 2];
      return {
        set: sets[t.set] || 'KITCHEN', int_ext: t.set ? 'EXT' : 'INT', time: 'NIGHT', characters: t.who.map((w) => ids[w]), seconds: 20,
        purpose: t.purpose, objectives: t.who.map((w, j) => ({ who: ids[w], wants: t.wants[j], tactic: t.tactic[j] })),
        subtext: 'neither will say what they came to say', turn: t.turn, value: t.value, key_image: t.key_image, exit: t.exit,
        plants: i === 0 ? ['P1'] : [], payoffs: i === n - 1 ? ['P1'] : [],
      };
    }),
  };
}

const ACTIONS = ['%s stirs a pot. Her phone buzzes on the counter, face down.', 'Steam fogs the window above the sink.', 'The streetlight outside buzzes and flickers.',
  '%s turns a small envelope over in his hands.', 'A door opens. Cold air lifts the curtain.', 'The spoon stops against the rim of the pot.'];
const LINES = ['Not tonight.', 'Please, not tonight.', 'She has to hear it from me.', 'I found the letter.', 'Then you know why I left.', 'The kettle is still warm.', 'You kept the key.', 'Say it to my face.'];

/** A scene sized to its card's budget, so the mock exercises the same checks as a real one. */
function mockScene(input: any) {
  const card = input.card || {}, secs = Math.max(4, card.seconds || 12);
  const dialogue = Math.round(secs * 0.6 * 2.4), action = Math.round((secs * 0.4) / 0.32);
  const nActions = Math.max(1, Math.round(action / 12));
  const who: string[] = card.characters || [];
  const elements: any[] = [];
  let ai = (input.k || 0) * 2, li = (input.k || 0) * 3, said = 0;
  for (let a = 0; a < nActions; a++) {
    const text: string[] = [];
    while (text.join(' ').split(' ').length < action / nActions - 4) text.push(ACTIONS[ai++ % ACTIONS.length].replace('%s', who[ai % Math.max(1, who.length)] || 'Someone'));
    elements.push({ kind: 'action', who: '', paren: '', text: text.join(' ') || 'The room is still.' });
    while (who.length && said < (dialogue * (a + 1)) / nActions) {
      const line = LINES[li % LINES.length];
      elements.push({ kind: 'line', who: who[li % who.length], paren: '', text: line });
      said += line.split(' ').length; li++;
    }
  }
  if (input.notes?.length) elements.push({ kind: 'action', who: '', paren: '', text: 'The envelope lies open between them.' });
  if (input.variant) elements.push({ kind: 'action', who: '', paren: '', text: 'Nobody moves.' });
  return { elements };
}

function mockCritique(input: any) {
  const outline: any[][] = input.outline || [], first = input.first || 0;
  return {
    scores: { hook: 4, turns: 4, escalation: 3, dialogue: 3, specificity: 3, ending: 4, fidelity: 5 },
    scenes: outline.flatMap((cards, e) => cards.map((_, k) => ({
      episode: first + e + 1, scene: k + 1, verdict: first + e === 0 && k === cards.length - 1 ? 'revise' : 'keep',
      notes: first + e === 0 && k === cards.length - 1 ? [{ problem: 'the ending trails off on talk', fix: 'land it on the envelope' }] : [],
    }))),
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
    if (process.env.MOCK_VIDEO_DOWN === '1') { tasks.set(id, { status: 'failed', error: 'mock video service is down' }); return id; } // tests: an outage
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
