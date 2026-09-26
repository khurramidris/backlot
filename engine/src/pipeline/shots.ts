// Shot planning: each scene → H3-sized shots (4–15 s, up to 4 hard cuts inside).
// Claude directs; code guarantees the script's dialogue is all there, verbatim and once,
// that every line has time to be spoken, and that no shot breaks H3's limits.

import { sql } from '../db.js';
import { PermanentError, type JobCtx } from '../queue.js';
import { claudeJSON, llmCost } from '../providers/claude.js';
import { recordUsage } from '../usage.js';
import { dialogueOf } from './fountain.js';
import { SHOTS_SYSTEM, shotsPrompt, RETAKE_SYSTEM, retakePrompt } from './prompts.js';
import { compileShot, fitBeats, H3, speechSeconds, type Beat, type ShotPlan, type CompileAsset, type CompileInput } from './compiler.js';

const up = (s: any) => String(s || '').toUpperCase().trim();
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

type Line = { who: string; line: string; paren?: string };

/** Make a raw shot list safe: known keys only, dialogue verbatim/complete/once, timing that fits H3. */
export function repairShots(raw: any, dialogue: Line[], known: { chars: Set<string>; props: Set<string> }, estSeconds = 10): { shots: ShotPlan[]; warnings: string[] } {
  const warnings: string[] = [];
  let shots: ShotPlan[] = (Array.isArray(raw?.shots) ? raw.shots : Array.isArray(raw) ? raw : []).map((s: any) => ({
    duration: Math.round(+s.duration || 0),
    purpose: String(s.purpose || ''),
    characters: [...new Set((s.characters || []).map(up).filter((k: string) => known.chars.has(k)))] as string[],
    props: [...new Set((s.props || []).map(up).filter((k: string) => known.props.has(k)))] as string[],
    sound: String(s.sound || ''),
    beats: (Array.isArray(s.beats) ? s.beats : []).map((b: any) => ({
      t0: +b.t0 || 0, t1: +b.t1 || 0, shot: String(b.shot || 'medium'), angle: String(b.angle || ''), camera: String(b.camera || 'static'),
      action: String(b.action || ''),
      dialogue: (Array.isArray(b.dialogue) ? b.dialogue : []).map((d: any) => ({ who: up(d.who), line: String(d.line || ''), delivery: String(d.delivery || '') })).filter((d: any) => d.line.trim()),
    })),
  })).filter((s: ShotPlan) => s.beats.length);
  const positions = String(raw?.screen_positions || '');

  if (!shots.length) {
    // Nothing usable came back: one shot per dialogue exchange, simplest faithful coverage.
    shots = [{ duration: Math.min(15, Math.max(4, estSeconds)), characters: [...new Set(dialogue.map((d) => d.who))].filter((k) => known.chars.has(k)), props: [], beats: [{ t0: 0, t1: 4, shot: 'wide', camera: 'static', action: 'Establish the scene.', dialogue: [] }] }];
    warnings.push('planner returned no shots; used a fallback');
  }

  // ── Dialogue: map every planned line to the script, in order ──
  const covered = new Array(dialogue.length).fill(false);
  let cursor = 0;
  const lastBeatFor: { shot: number; beat: number }[] = new Array(dialogue.length);
  shots.forEach((s, si) => s.beats.forEach((b, bi) => {
    b.dialogue = (b.dialogue || []).filter((d) => {
      const nd = norm(d.line);
      if (!nd) return false;
      for (let k = cursor; k < dialogue.length; k++) {
        const ne = norm(dialogue[k].line);
        const same = ne === nd || (nd.length > 8 && ne.includes(nd)) || (ne.length > 8 && nd.includes(ne));
        if (!same) continue;
        const partial = ne !== nd && ne.includes(nd);
        if (!partial) d.line = dialogue[k].line;            // restore verbatim wording
        d.who = dialogue[k].who;                            // trust the script for the speaker
        covered[k] = true; lastBeatFor[k] = { shot: si, beat: bi };
        cursor = partial ? k : k + 1;
        return true;
      }
      warnings.push(`removed a line not in the script: "${d.line.slice(0, 60)}"`);
      return false;
    });
  }));
  // Missing lines go right after the previous line's beat (or at the start).
  for (let k = 0; k < dialogue.length; k++) {
    if (covered[k]) continue;
    const d = dialogue[k];
    let pos = { shot: 0, beat: -1 };
    for (let j = k - 1; j >= 0; j--) if (lastBeatFor[j]) { pos = lastBeatFor[j]; break; }
    const s = shots[pos.shot];
    const beat: Beat = { t0: 0, t1: 0, shot: 'medium close-up', camera: 'static', action: `${d.who} speaks${d.paren ? ' ' + d.paren.replace(/[()]/g, '') : ''}`, dialogue: [{ who: d.who, line: d.line, delivery: d.paren ? d.paren.replace(/[()]/g, '') : '' }] };
    s.beats.splice(pos.beat + 1, 0, beat);
    if (known.chars.has(d.who) && !s.characters.includes(d.who)) s.characters.push(d.who);
    lastBeatFor[k] = { shot: pos.shot, beat: pos.beat + 1 };
    // Later bookkeeping positions in the same shot shift by one.
    for (let j = k + 1; j < dialogue.length; j++) if (lastBeatFor[j] && lastBeatFor[j].shot === pos.shot && lastBeatFor[j].beat > pos.beat) lastBeatFor[j].beat++;
    warnings.push(`added a missing line: ${d.who}: "${d.line.slice(0, 60)}"`);
  }

  // ── Timing: split anything H3 can't hold, then fit beats to whole seconds ──
  const out: ShotPlan[] = [];
  const queue = [...shots];
  while (queue.length) {
    const s = queue.shift()!;
    // A single beat with more speech than one shot can hold: split its lines.
    const bigBeat = s.beats.findIndex((b) => (b.dialogue || []).reduce((t, d) => t + speechSeconds(d.line), 0) > H3.maxSec - 0.5);
    if (bigBeat >= 0) {
      const b = s.beats[bigBeat];
      let lines = b.dialogue!;
      if (lines.length === 1) lines = splitLine(lines[0]);
      const half = Math.ceil(lines.length / 2);
      const b1 = { ...b, dialogue: lines.slice(0, half) }, b2 = { ...b, shot: b.shot.includes('close') ? 'medium' : 'close-up', dialogue: lines.slice(half), action: `${b.action} (continues)` };
      s.beats.splice(bigBeat, 1, b1, b2);
      if (lines.length > 1) { queue.unshift(s); continue; }
    }
    const need = s.beats.reduce((t, b) => t + Math.max(2, (b.dialogue || []).reduce((x, d) => x + speechSeconds(d.line), 0)), 0);
    if ((need > H3.maxSec || s.beats.length > 4) && s.beats.length > 1) {
      const mid = Math.ceil(s.beats.length / 2);
      queue.unshift({ ...s, beats: s.beats.slice(mid), duration: 0 }, );
      queue.unshift({ ...s, beats: s.beats.slice(0, mid), duration: 0 });
      warnings.push('split a shot that was too long for one H3 generation');
      continue;
    }
    const fit = fitBeats(s.beats, s.duration || need);
    const chars = new Set(s.characters);
    fit.beats.forEach((b) => (b.dialogue || []).forEach((d) => { if (known.chars.has(d.who)) chars.add(d.who); }));
    out.push({ ...s, beats: fit.beats, duration: fit.duration, characters: [...chars], screen_positions: positions });
  }
  return { shots: out, warnings };
}

/** Break one very long line at sentence boundaries. */
function splitLine(d: { who: string; line: string; delivery?: string }) {
  const parts = d.line.match(/[^.!?।؟]+[.!?।؟]*\s*/g) || [d.line];
  if (parts.length < 2) { const w = d.line.split(' '); const h = Math.ceil(w.length / 2); return [{ ...d, line: w.slice(0, h).join(' ') }, { ...d, line: w.slice(h).join(' ') }]; }
  const h = Math.ceil(parts.length / 2);
  return [{ ...d, line: parts.slice(0, h).join('').trim() }, { ...d, line: parts.slice(h).join('').trim() }];
}

// ───────────────────────── loading context for compile ─────────────────────────

export async function projectAssets(projectId: string) {
  const rows = await sql`select id, kind, key, name, description, meta, file_key, status, parent_id from assets where project_id = ${projectId}`;
  const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
  const byKey = new Map<string, any>(rows.map((r: any) => [`${r.kind}:${r.key}`, r]));
  return { rows, byId, byKey };
}

/** Only approved assets are sent to H3; unapproved ones are treated as missing. */
const usable = (a: any): CompileAsset | null => (a && a.status === 'approved' && a.file_key ? a : null);

export function compileInputFor(shot: { plan: ShotPlan }, scene: any, project: any, A: Awaited<ReturnType<typeof projectAssets>>, chainNote?: string | null): CompileInput {
  const setRow = scene?.location_asset_id ? A.byId.get(scene.location_asset_id) : null;
  const master = setRow?.kind === 'set_variant' ? A.byId.get(setRow.parent_id) : setRow;
  const keys = new Set([...(shot.plan.characters || []), ...shot.plan.beats.flatMap((b) => (b.dialogue || []).map((d) => d.who))].map(up));
  const characters = [...keys].map((k) => {
    const id = A.byKey.get(`character:${k}`);
    const lookId = scene?.looks?.[k];
    const look = lookId ? A.byId.get(lookId) : [...A.rows].find((r: any) => r.kind === 'look' && r.key.startsWith(k + '/'));
    return { key: k, name: id?.name || k, identity: usable(id), look: usable(look), voice: usable(A.byKey.get(`voice:${k}/VOICE`)) };
  });
  const props = (shot.plan.props || []).map((k) => A.byKey.get(`prop:${up(k)}`)).filter(Boolean).map((p: any) => (usable(p) || { ...p, file_key: null }));
  return {
    plan: shot.plan,
    project: { aspect: project.aspect, language: project.language, style: project.style, format: project.format },
    scene: { heading: scene?.heading || '', time_of_day: scene?.time_of_day || '', int_ext: scene?.int_ext || '' },
    set: usable(setRow) || (setRow ? { ...setRow, file_key: null } : null),
    setMaster: master && master.id !== setRow?.id ? usable(master) || { ...master, file_key: null } : null,
    characters, props, chainNote,
  };
}

// ───────────────────────── planning ─────────────────────────

export async function planEpisode(episodeId: string, ctx: JobCtx, o: { force?: boolean } = {}) {
  const [ep] = await sql`select * from episodes where id = ${episodeId}`;
  if (!ep) throw new PermanentError('episode not found');
  const [p] = await sql`select * from projects where id = ${ep.project_id}`;
  const [{ n }] = await sql`select count(*)::int n from takes t join shots s on s.id = t.shot_id where s.episode_id = ${episodeId}`;
  if (n && !o.force) throw new PermanentError('This episode already has rendered takes. Re-plan with force=true to discard them.', 'conflict');
  const scenes = await sql`select * from scenes where episode_id = ${episodeId} order by idx`;
  if (!scenes.length) throw new PermanentError('Run the breakdown first.', 'bad_state');
  const A = await projectAssets(p.id);
  const bible = (p.story_bible?.characters || []).map((c: any) => ({ ...c, id: up(c.id || c.name) }));
  const knownChars = new Set<string>(A.rows.filter((r: any) => r.kind === 'character').map((r: any) => r.key));
  const knownProps = new Set<string>(A.rows.filter((r: any) => r.kind === 'prop').map((r: any) => r.key));

  const planned: { scene: any; shots: ShotPlan[]; warnings: string[] }[] = [];
  let lastShot = '';
  for (let k = 0; k < scenes.length; k++) {
    const sc = scenes[k];
    await ctx.progress(`Planning shots: scene ${k + 1} of ${scenes.length}`);
    const dialogue = dialogueOf(sc.body, bible);
    const setRow = sc.location_asset_id ? A.byId.get(sc.location_asset_id) : null;
    const master = setRow?.kind === 'set_variant' ? A.byId.get(setRow.parent_id) : null;
    const input = {
      title: p.title, format: p.format, aspect: p.aspect, language: p.language, style: p.style,
      episode: { idx: ep.idx, title: ep.title },
      prev: k ? scenes[k - 1].heading : '', next: scenes[k + 1]?.heading || '', lastShot,
      set: setRow ? { key: setRow.key, name: setRow.name, description: master ? `${master.description} Now: ${setRow.description}` : setRow.description, layout: (master || setRow).meta?.layout } : null,
      characters: (sc.characters || []).map((ck: string) => {
        const c = A.byKey.get(`character:${ck}`); const l = sc.looks?.[ck] ? A.byId.get(sc.looks[ck]) : null;
        return { key: ck, name: c?.name || ck, look: l?.description || '' };
      }),
      props: (sc.props || []).map((pk: string) => ({ key: pk, name: A.byKey.get(`prop:${pk}`)?.name || pk })),
      scene: { idx: sc.idx, body: sc.body, est_seconds: sc.est_seconds },
      dialogue,
    };
    const r = await claudeJSON({ task: 'shots', system: SHOTS_SYSTEM, prompt: shotsPrompt(input), input, maxTokens: 12000 });
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'llm', units: r.usage.input + r.usage.output, cost: llmCost(r.model, r.usage), ref: `plan:${sc.id}` });
    const fixed = repairShots(r.data, dialogue, { chars: knownChars, props: knownProps }, sc.est_seconds);
    planned.push({ scene: sc, ...fixed });
    const ls = fixed.shots[fixed.shots.length - 1];
    lastShot = ls ? ls.beats[ls.beats.length - 1]?.action || '' : '';
  }

  const chain = !!p.settings?.chain_clips;
  const total = await sql.begin(async (tx) => {
    await tx`delete from shots where episode_id = ${episodeId}`;
    let idx = 0;
    for (const { scene, shots, warnings } of planned) {
      let n = 0;
      for (const s of shots) {
        idx++; n++;
        const plan = { ...s, warnings: n === 1 ? warnings : [] };
        const c = compileShot(compileInputFor({ plan }, scene, p, A));
        await tx`insert into shots (project_id, episode_id, scene_id, idx, code, duration, plan, prompt, asset_ids, voice_ids, chain_prev)
          values (${p.id}, ${episodeId}, ${scene.id}, ${idx}, ${`${scene.idx}.${n}`}, ${s.duration}, ${tx.json({ ...plan, compile_warnings: c.warnings } as any)},
                  ${c.prompt}, ${c.images.map((a) => a.id)}, ${c.voices.map((a) => a.id)}, ${chain && n > 1})`;
      }
    }
    await tx`update episodes set status = 'planned', updated_at = now() where id = ${episodeId}`;
    await tx`update projects set status = 'planning', updated_at = now() where id = ${p.id}`;
    return idx;
  });
  const secs = planned.reduce((t, x) => t + x.shots.reduce((a, s) => a + s.duration, 0), 0);
  return { shots: total, seconds: secs, warnings: planned.flatMap((x) => x.warnings).length };
}

/** Revise one shot's plan from a review note (Claude), keeping dialogue verbatim. */
export async function reviseShot(shotId: string, note: string) {
  const [s] = await sql`select s.*, sc.heading, sc.body from shots s left join scenes sc on sc.id = s.scene_id where s.id = ${shotId}`;
  if (!s) throw new PermanentError('shot not found');
  const [p] = await sql`select * from projects where id = ${s.project_id}`;
  const A = await projectAssets(p.id);
  const dialogue = s.plan.beats.flatMap((b: Beat) => b.dialogue || []);
  const input = { code: s.code, scene: s.heading, plan: s.plan, note, dialogue };
  const r = await claudeJSON({ task: 'retake', system: RETAKE_SYSTEM, prompt: retakePrompt(input), input, fast: true, maxTokens: 6000 });
  await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'llm', units: r.usage.input + r.usage.output, cost: llmCost(r.model, r.usage), ref: `retake:${shotId}` });
  const known = { chars: new Set<string>(A.rows.filter((x: any) => x.kind === 'character').map((x: any) => x.key)), props: new Set<string>(A.rows.filter((x: any) => x.kind === 'prop').map((x: any) => x.key)) };
  const fixed = repairShots({ shots: [r.data?.shot || r.data], screen_positions: s.plan.screen_positions }, dialogue.map((d: any) => ({ who: d.who, line: d.line })), known, s.duration);
  // A revision must stay one shot; if repair split it, keep the first and fold the rest's dialogue back in by keeping the original.
  const plan: ShotPlan = fixed.shots.length === 1 ? { ...fixed.shots[0], warnings: fixed.warnings } : { ...s.plan, warnings: ['revision would not fit one shot; kept the original plan and added the note to the prompt'] };
  const scene = s.scene_id ? (await sql`select * from scenes where id = ${s.scene_id}`)[0] : null;
  const c = compileShot(compileInputFor({ plan }, scene, p, A));
  const prompt = fixed.shots.length === 1 ? c.prompt : `${s.prompt}\nDirector's note for this take: ${note}`;
  await sql`update shots set plan = ${sql.json({ ...plan, compile_warnings: c.warnings } as any)}, duration = ${plan.duration}, prompt = ${prompt},
    prompt_locked = false, review_note = ${note}, updated_at = now() where id = ${shotId}`;
  return { plan, prompt };
}
