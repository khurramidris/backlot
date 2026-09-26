// Shot plan → MiniMax H3 request. Deterministic on purpose: the same plan always produces the
// same prompt, every H3 rule is checked in code, and the prompt ties each reference file to a
// named character, set or prop ("reference image 2 is Asma").

import { config } from '../config.js';

export const H3 = {
  minSec: 4, maxSec: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, maxVideoSecTotal: 15,
  maxPromptChars: 7000, ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
};

export interface Beat {
  t0: number; t1: number; shot: string; angle?: string; camera?: string; action: string;
  dialogue?: { who: string; line: string; delivery?: string }[];
}
export interface ShotPlan {
  duration: number; purpose?: string; characters: string[]; props: string[];
  beats: Beat[]; sound?: string; screen_positions?: string; warnings?: string[];
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
/** Seconds needed to speak a line naturally (plus a breath). */
export function speechSeconds(line: string) {
  const cjk = (line.match(CJK) || []).length;
  const w = (line.replace(CJK, ' ').match(/[\p{L}\p{N}'’]+/gu) || []).length;
  return cjk / 4.5 + w / 2.4 + 0.5;
}
export const beatNeeds = (b: Beat) => Math.max(2, (b.dialogue || []).reduce((s, d) => s + speechSeconds(d.line), 0));

/** Normalize beats: whole seconds, contiguous from 0, each long enough for its dialogue; returns the shot duration. */
export function fitBeats(beats: Beat[], wanted: number): { beats: Beat[]; duration: number; overflow: boolean } {
  const bs = beats.filter((b) => b && (b.action || b.dialogue?.length)).map((b) => ({ ...b, dialogue: (b.dialogue || []).filter((d) => d.line?.trim()) }));
  if (!bs.length) return { beats: [], duration: Math.max(H3.minSec, Math.min(H3.maxSec, Math.round(wanted) || 5)), overflow: false };
  // Proposed lengths from the plan, floored by what the dialogue needs.
  let lens = bs.map((b) => Math.max(beatNeeds(b), (+b.t1 - +b.t0) || 0, 2));
  let total = lens.reduce((a, b) => a + b, 0);
  const target = Math.max(H3.minSec, Math.min(H3.maxSec, Math.max(Math.round(wanted) || 0, Math.ceil(total))));
  const need = bs.map(beatNeeds);
  const needTotal = need.reduce((a, b) => a + b, 0);
  const overflow = needTotal > H3.maxSec + 0.01;
  if (total > target) {
    // Shrink beats that have slack, never below their dialogue floor.
    const slack = lens.map((l, i) => Math.max(0, l - need[i]));
    const s = slack.reduce((a, b) => a + b, 0);
    const cut = Math.min(total - target, s);
    lens = lens.map((l, i) => l - (s ? (slack[i] / s) * cut : 0));
  } else if (total < target) {
    lens = lens.map((l) => l + ((target - total) * l) / total);
  }
  // Integer boundaries that sum to the duration.
  const duration = overflow ? H3.maxSec : target;
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  const last = lens.length - 1;
  const out: Beat[] = []; let t = 0, acc = 0;
  lens.forEach((l, i) => {
    acc += (l * duration) / sum;
    let t1 = i === last ? duration : Math.round(acc);
    t1 = Math.min(Math.max(t1, t + 1), duration - (last - i));
    out.push({ ...bs[i], t0: t, t1 });
    t = t1;
  });
  return { beats: out, duration, overflow };
}

export interface CompileAsset { id: string; kind: string; key: string; name: string; description: string; meta: any; file_key: string | null; parent_key?: string }
export interface CompileInput {
  plan: ShotPlan;
  project: { aspect: string; language: string; style: any; format: string };
  scene: { heading: string; time_of_day: string; int_ext: string };
  set?: CompileAsset | null;           // set or set variant used by the scene
  setMaster?: CompileAsset | null;     // parent set when `set` is a variant
  characters: { key: string; name: string; identity?: CompileAsset | null; look?: CompileAsset | null; voice?: CompileAsset | null }[];
  props: CompileAsset[];
  chainNote?: string | null;           // set when a previous clip is passed as reference video
}
export interface Compiled { prompt: string; images: CompileAsset[]; voices: CompileAsset[]; warnings: string[] }

const clean = (s: any) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '');
const firstName = (n: string) => clean(n).split(/\s+/)[0] || n;
const hasFile = (a?: CompileAsset | null): a is CompileAsset => !!a && !!a.file_key;

export function compileShot(i: CompileInput): Compiled {
  const warnings: string[] = [];
  const { plan, project } = i;
  const st = project.style || {};
  const onScreen = new Set(plan.characters.map((k) => k.toUpperCase()));
  const speaking = new Set(plan.beats.flatMap((b) => (b.dialogue || []).map((d) => d.who.toUpperCase())));
  const chars = i.characters.filter((c) => onScreen.has(c.key) || speaking.has(c.key));

  // ── Reference images, in priority order, max 9 ──
  const images: CompileAsset[] = [];
  const label = new Map<string, string>();
  const add = (a: CompileAsset | null | undefined, what: string) => {
    if (!hasFile(a) || images.find((x) => x.id === a.id)) return false;
    if (images.length >= H3.maxImages) { warnings.push(`dropped reference (limit 9): ${what}`); return false; }
    images.push(a); label.set(a.id, what); return true;
  };
  add(i.set || i.setMaster, `the location, ${clean((i.set || i.setMaster)!?.name || '')}`);
  for (const c of chars) add(c.identity, `${firstName(c.name)}'s face and identity`);
  for (const c of chars) add(c.look, `${firstName(c.name)}'s full outfit`);
  for (const p of i.props.filter((p) => plan.props.map((x) => x.toUpperCase()).includes(p.key))) add(p, `the ${clean(p.name).toLowerCase()}`);
  for (const c of chars) if (!hasFile(c.identity) && !hasFile(c.look)) warnings.push(`${c.name} has no approved reference image`);
  if (!hasFile(i.set) && !hasFile(i.setMaster)) warnings.push('the set has no approved reference image');

  // ── Reference audio: voices of characters who speak in this shot, max 3 ──
  const voices: CompileAsset[] = [];
  for (const c of chars) if (speaking.has(c.key) && hasFile(c.voice)) {
    if (voices.length < H3.maxAudios) voices.push(c.voice); else warnings.push(`voice reference dropped for ${c.name} (limit 3)`);
  }

  // ── Prompt text ──
  const ar = project.aspect === '9:16' ? 'Vertical 9:16' : project.aspect;
  const cuts = plan.beats.length - 1;
  const L: string[] = [];
  L.push(`${ar} live-action cinematic drama shot, ${plan.duration} seconds${cuts > 0 ? `, with ${cuts} hard cut${cuts > 1 ? 's' : ''}` : ', one continuous take'}. Photorealistic, natural performances, no animation.`);
  if (images.length) L.push(`References: ${images.map((a, n) => `reference image ${n + 1} is ${label.get(a.id)}`).join('; ')}.`);
  if (voices.length) L.push(`Voices: ${voices.map((v, n) => `${firstName(chars.find((c) => c.voice?.id === v.id)?.name || v.name)} speaks with the voice in reference audio ${n + 1}`).join('; ')}.`);
  if (i.chainNote) L.push(i.chainNote);

  const set = i.set || i.setMaster;
  const place = [clean(i.scene.heading)];
  if (set) {
    place.push(i.setMaster && i.set && i.set.id !== i.setMaster.id ? `${clean(i.setMaster.description)}. Now: ${clean(i.set.description)}` : clean(set.description));
    const layout = clean((i.setMaster || set)?.meta?.layout);
    if (layout) place.push(`Layout: ${layout}`);
  }
  L.push(`Setting: ${place.filter(Boolean).join('. ')}.`);

  if (chars.length) {
    L.push(`Characters: ${chars.map((c) => {
      const refs = [c.identity, c.look].filter(hasFile).map((a) => `reference image ${images.findIndex((x) => x.id === a.id) + 1}`).filter((s) => !s.endsWith(' 0'));
      const idText = clean(c.identity?.description);
      const wear = clean(c.look?.description);
      return `${c.name}${refs.length ? ` (${refs.join(' and ')})` : ''}: ${idText || 'as established'}${wear ? `; wearing ${wear}` : ''}`;
    }).join('. ')}.`);
  }
  if (plan.screen_positions) L.push(`Screen positions, keep consistent: ${clean(plan.screen_positions)}.`);
  const propsIn = i.props.filter((p) => plan.props.map((x) => x.toUpperCase()).includes(p.key));
  if (propsIn.length) L.push(`Key objects: ${propsIn.map((p) => `${clean(p.name)}${hasFile(p) ? ` (reference image ${images.findIndex((x) => x.id === p.id) + 1})` : ''}: ${clean(p.description)}`).join('. ')}.`);

  L.push('Timeline:');
  plan.beats.forEach((b, n) => {
    const who = (k: string) => i.characters.find((c) => c.key === k.toUpperCase())?.name || k;
    const head = `${b.t0}–${b.t1}s: ${n ? 'Cut to ' : ''}${[b.shot, b.angle && !/^eye.?level$/i.test(b.angle) ? `${b.angle} angle` : '', b.camera].filter(Boolean).map(clean).join(', ')}.`;
    const lines = (b.dialogue || []).map((d) => `${firstName(who(d.who))}${d.delivery ? `, ${clean(d.delivery)},` : ''} says: "${String(d.line).trim().replace(/"/g, "'")}"`).join(' ');
    L.push(`${head} ${clean(b.action)}.${lines ? ' ' + lines : ''}`);
  });

  const hasDialogue = plan.beats.some((b) => b.dialogue?.length);
  L.push(`Sound: ${plan.sound ? clean(plan.sound) + '. ' : ''}${hasDialogue ? `Dialogue spoken on camera in ${project.language}, clear and lip-synced, natural pace.` : 'No dialogue.'} No background music.`);
  const look = [st.camera, st.lighting, st.grade].filter(Boolean).map(clean).join('; ');
  if (look) L.push(`Look: ${look}.`);
  if (st.look) L.push(`Mood: ${clean(st.look)}.`);
  const avoid = [...new Set(['on-screen text', 'subtitles', 'captions', 'watermarks', 'logos', ...String(st.negative || '').split(/[,;]/).map((x) => clean(x).toLowerCase()).filter(Boolean)])];
  L.push(`Avoid: ${avoid.join(', ')}; faces or outfits that differ from the references; extra people in frame unless described.`);

  let prompt = L.join('\n');
  if (prompt.length > H3.maxPromptChars) {
    // Trim the least important parts first: mood, then long descriptions.
    prompt = prompt.replace(/\nMood: [^\n]*/, '');
    if (prompt.length > H3.maxPromptChars) prompt = prompt.slice(0, H3.maxPromptChars - 1);
    warnings.push('prompt trimmed to the 7000-character limit');
  }
  return { prompt, images, voices, warnings };
}

/** Final validation of the request body against MiniMax's documented rules. Throws on violations. */
export function validateH3(body: any) {
  const errs: string[] = [];
  if (!['MiniMax-H3', 'MiniMax-H3-Max'].includes(body.model)) errs.push(`unknown model ${body.model}`);
  const texts = (body.content || []).filter((c: any) => c.type === 'text');
  if (texts.length !== 1 || !texts[0].text?.trim()) errs.push('exactly one non-empty text item is required');
  if (texts[0]?.text?.length > H3.maxPromptChars) errs.push('prompt over 7000 characters');
  if (!Number.isInteger(body.duration) || body.duration < (body.model === 'MiniMax-H3-Max' ? 5 : 4) || body.duration > 15) errs.push(`duration ${body.duration} out of range`);
  if (body.model === 'MiniMax-H3' && !['768P', '2K'].includes(body.resolution)) errs.push(`resolution ${body.resolution} not supported by H3`);
  if (body.model === 'MiniMax-H3-Max' && !['480P', '768P'].includes(body.resolution)) errs.push(`resolution ${body.resolution} not supported by H3-Max`);
  if (body.ratio && !H3.ratios.includes(body.ratio)) errs.push(`ratio ${body.ratio} invalid`);
  const roles = (body.content || []).map((c: any) => c.role).filter(Boolean);
  const i2v = roles.some((r: string) => r === 'first_frame' || r === 'last_frame');
  const ref = roles.some((r: string) => r.startsWith('reference_'));
  if (i2v && ref) errs.push('first/last frame and reference media cannot be mixed');
  const count = (r: string) => roles.filter((x: string) => x === r).length;
  if (count('reference_image') > 9) errs.push('more than 9 reference images');
  if (count('reference_video') > 3) errs.push('more than 3 reference videos');
  if (count('reference_audio') > 3) errs.push('more than 3 reference audio clips');
  if (count('reference_audio') && !count('reference_image') && !count('reference_video')) errs.push('reference audio needs an image or video reference with it');
  if (errs.length) throw new Error('H3 request invalid: ' + errs.join('; '));
  return true;
}

export const costOf = (resolution: string, seconds: number) => (config.pricing.videoPerSecond[resolution] ?? config.pricing.videoPerSecond['768P']) * seconds;
