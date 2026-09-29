// Prompt → production, as a writers' room in three steps, each saved before the next (so a restart resumes
// and no single job runs long):
//   1. develop: three different takes on the idea, the strongest developed into a treatment (theme,
//      characters with wants, secrets and voices, world, beat sheet, clichés to avoid);
//   2. screenplay: the full Fountain script from the treatment;
//   3. script doctor: a critique against automated checks and a story editor's checklist, then a rewrite.
// The result has the same shape the importer accepts, so everything downstream is unchanged.

import { z } from 'zod';
import { sql } from '../db.js';
import { config } from '../config.js';
import { PermanentError, type JobCtx } from '../queue.js';
import { claudeJSON, llmCost, llmUnits } from '../providers/claude.js';
import { recordUsage } from '../usage.js';
import { parseFountain, parseScenes } from './fountain.js';
import { normalizeImport } from './importer.js';
import { DEVELOP_SYSTEM, developPrompt, SCREENPLAY_SYSTEM, screenplayPrompt, DOCTOR_SYSTEM, doctorPrompt } from './prompts.js';
import { DevelopSchema, ScreenplaySchema, DoctorSchema } from './schemas.js';
import { recentWork, sparksFor, storyLint } from './story.js';

type Range = readonly [number, number];
export const FORMATS: Record<string, { label: string; aspect: string; engine: string; episodes: Range; seconds: Range; defaults: { episodes: number; seconds: number }; notes: string }> = {
  microdrama: { label: 'Microdrama', aspect: '9:16', engine: 'micro', episodes: [1, 5], seconds: [45, 120], defaults: { episodes: 1, seconds: 75 },
    notes: 'A vertical microdrama for phone feeds: heightened emotion, fast turns, big reveals, and a cliffhanger ending.' },
  short_film: { label: 'Short film', aspect: '16:9', engine: 'film', episodes: [1, 1], seconds: [60, 300], defaults: { episodes: 1, seconds: 120 },
    notes: 'A self-contained short film with a clear beginning, middle and end.' },
  web_series: { label: 'Web series', aspect: '16:9', engine: 'series', episodes: [1, 3], seconds: [90, 240], defaults: { episodes: 2, seconds: 150 },
    notes: 'A web series: every episode has its own arc and ends on a hook into the next.' },
  youtube: { label: 'YouTube story', aspect: '16:9', engine: 'film', episodes: [1, 1], seconds: [60, 300], defaults: { episodes: 1, seconds: 120 },
    notes: 'A narrative story video for YouTube: a strong hook in the first five seconds, then rising tension to the end.' },
};

export const BriefSchema = z.object({
  prompt: z.string().trim().min(10, 'Describe your idea in at least a sentence.').max(4000),
  format: z.enum(['microdrama', 'short_film', 'web_series', 'youtube']).default('microdrama'),
  episodes: z.number().int().positive().optional(),
  seconds: z.number().int().positive().optional(), // per episode
  language: z.string().trim().min(2).max(40).default('English'),
});
export type Brief = Omit<z.infer<typeof BriefSchema>, 'episodes' | 'seconds'> & { episodes: number; seconds: number; aspect: string; engineFormat: string };

const clamp = (v: number, [lo, hi]: Range) => Math.min(hi, Math.max(lo, v));

/** Fill defaults and clamp to what the format allows at launch, inside the per-project runtime cap. */
export function resolveBrief(raw: unknown): Brief {
  const b = BriefSchema.parse(raw);
  const f = FORMATS[b.format];
  const cap = config.autopilot.maxRuntimeSeconds;
  const seconds = Math.min(clamp(b.seconds ?? f.defaults.seconds, f.seconds), cap);
  let episodes = clamp(b.episodes ?? f.defaults.episodes, f.episodes);
  while (episodes > 1 && episodes * seconds > cap) episodes--;
  return { ...b, episodes, seconds, aspect: f.aspect, engineFormat: f.engine };
}

/** Why a written production can't be used, or '' when it can. */
export function checkWritten(d: any, brief: Pick<Brief, 'episodes' | 'seconds'>): string {
  if (!d || typeof d !== 'object') return 'the answer was not a JSON object';
  if (!Array.isArray(d.episodes) || d.episodes.length < brief.episodes) return `expected ${brief.episodes} episode(s), got ${Array.isArray(d.episodes) ? d.episodes.length : 0}`;
  const bible = (Array.isArray(d.characters) ? d.characters : []).map((c: any) => ({ ...c, id: String(c?.id || c?.name || '').toUpperCase() }));
  for (const [i, e] of d.episodes.slice(0, brief.episodes).entries()) {
    if (typeof e?.script !== 'string' || !e.script.trim()) return `episode ${i + 1} has no script`;
    if (!parseFountain(e.script).some((el) => el.t === 'scene')) return `episode ${i + 1} has no INT./EXT. scene headings`;
    const secs = parseScenes(e.script, bible).reduce((t, s) => t + s.estSeconds, 0);
    if (secs > brief.seconds * 2.5) return `episode ${i + 1} runs about ${secs}s but the target is ${brief.seconds}s`;
  }
  return '';
}

/** Why a treatment can't be scripted from, or '' when it can. */
export function checkTreatment(d: any, brief: Pick<Brief, 'episodes'>): string {
  const t = d?.treatment;
  if (!t || typeof t !== 'object') return 'there was no treatment';
  if (!Array.isArray(t.characters) || !t.characters.length) return 'the treatment has no characters';
  if (!Array.isArray(t.episodes) || t.episodes.length < brief.episodes) return `the treatment plans ${Array.isArray(t.episodes) ? t.episodes.length : 0} episode(s), ${brief.episodes} were asked for`;
  if (t.episodes.slice(0, brief.episodes).some((e: any) => !Array.isArray(e?.beats) || !e.beats.length)) return 'an episode has no beats';
  return '';
}

type WriteState = { phase?: 'develop' | 'screenplay' | 'doctor'; treatment?: any; concepts?: any[]; draft?: any; tries?: number; problem?: string };

/**
 * One step of the writers' room per call. Returns done=true once the final screenplay is saved.
 * State lives in projects.autopilot.writing, so a failed or restarted job resumes at its step.
 */
export async function writeStep(projectId: string, ctx: JobCtx): Promise<{ done: boolean; progress: string }> {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  const brief = p.brief as Brief;
  const f = FORMATS[brief.format];
  const st: WriteState = p.autopilot?.writing || {};
  const phase = st.phase || 'develop';
  const base = { format: f.label, formatNotes: f.notes, aspect: brief.aspect, episodes: brief.episodes, secondsPerEpisode: brief.seconds, language: brief.language };
  const retryNote = st.problem ? `\n\nYOUR PREVIOUS ANSWER WAS UNUSABLE: ${st.problem}. Fix that.` : '';
  const save = (patch: WriteState | null) => sql`update projects set autopilot = autopilot || ${sql.json({ writing: patch } as any)}, updated_at = now() where id = ${projectId}`;
  const track = (r: any, ref: string) => recordUsage({ ownerId: p.owner_id, projectId, kind: 'llm', units: llmUnits(r.usage), cost: llmCost(r.model, r.usage), ref });
  const fail = async (problem: string, what: string) => {
    const tries = (st.tries || 0) + 1;
    if (tries >= 2) throw new PermanentError(`The ${what} could not be written: ${problem}.`, 'write_failed');
    await save({ ...st, phase, tries, problem });
    return { done: false, progress: `Rewriting the ${what}` };
  };

  if (phase === 'develop') {
    await ctx.progress('Developing the story');
    const input = { ...base, prompt: brief.prompt, sparks: sparksFor(projectId), recent: await recentWork(p.owner_id, projectId) };
    const r = await claudeJSON({ task: 'develop', system: DEVELOP_SYSTEM, prompt: developPrompt(input) + retryNote, input, schema: DevelopSchema, effort: config.anthropic.effort, maxTokens: 32000 });
    await track(r, 'develop');
    const problem = checkTreatment(r.data, brief);
    if (problem) return fail(problem, 'story');
    await save({ phase: 'screenplay', treatment: r.data.treatment, concepts: r.data.concepts, tries: 0 });
    return { done: false, progress: 'Story developed' };
  }

  if (phase === 'screenplay') {
    await ctx.progress('Writing the screenplay');
    const input = { ...base, treatment: st.treatment };
    const r = await claudeJSON({ task: 'screenplay', system: SCREENPLAY_SYSTEM, prompt: screenplayPrompt(input) + retryNote, input, schema: ScreenplaySchema, effort: config.anthropic.effort, maxTokens: 48000 });
    await track(r, 'screenplay');
    const problem = checkWritten(r.data, brief);
    if (problem) return fail(problem, 'screenplay');
    if (!config.anthropic.scriptDoctor) { await finish(p, brief, st.treatment, r.data, [], storyLint(r.data, brief, brief.prompt)); await save(null); return { done: true, progress: 'Script written' }; }
    await save({ ...st, phase: 'doctor', draft: r.data, tries: 0, problem: undefined });
    return { done: false, progress: 'First draft written' };
  }

  // Script doctor: a critique and rewrite. A worse or broken revision never replaces a usable draft.
  await ctx.progress('Polishing the script');
  const before = storyLint(st.draft, brief, brief.prompt);
  const input = { ...base, treatment: st.treatment, draft: st.draft, checks: before.issues };
  let final = st.draft, notes: string[] = [];
  try {
    const r = await claudeJSON({ task: 'doctor', system: DOCTOR_SYSTEM, prompt: doctorPrompt(input), input, schema: DoctorSchema, effort: config.anthropic.effort, maxTokens: 48000 });
    await track(r, 'doctor');
    const after = storyLint(r.data, brief, brief.prompt);
    if (!checkWritten(r.data, brief) && after.issues.length <= before.issues.length + 2) { final = r.data; notes = (r.data as any).notes || []; }
    else notes = ['kept the first draft: the revision was not an improvement'];
  } catch (e: any) {
    if (e instanceof PermanentError && e.code === 'refused') throw e;
    notes = [`kept the first draft: the polish step failed (${String(e.message).slice(0, 120)})`];
  }
  await finish(p, brief, st.treatment, final, notes, storyLint(final, brief, brief.prompt));
  await save(null);
  return { done: true, progress: 'Script written' };
}

/** Save the final screenplay: project title and look, story bible (with the treatment and quality report), episodes. */
async function finish(p: any, brief: Brief, treatment: any, written: any, notes: string[], report: ReturnType<typeof storyLint>) {
  const str = (v: any) => (v == null ? '' : String(v));
  // Voice and look notes from the treatment enrich the cast the breakdown designs from.
  const tChar = (id: string) => (treatment?.characters || []).find((c: any) => String(c.id).toUpperCase() === id.toUpperCase());
  const n = normalizeImport({
    title: str(written.title).slice(0, 200) || 'Untitled', format: brief.engineFormat, aspect: brief.aspect, resolution: '768P', language: brief.language,
    style: Object.fromEntries(Object.entries(written.style || {}).map(([k, v]) => [k, str(v)])),
    world: str(written.world),
    characters: (Array.isArray(written.characters) ? written.characters : []).map((c: any) => {
      const t = tChar(str(c.id || c.name));
      return {
        id: str(c.id || c.name), name: str(c.name || c.id), age: str(c.age), role: str(c.role),
        description: [str(c.description), t?.look ? `Distinct look: ${t.look}` : ''].filter(Boolean).join(' '),
        voice: [str(c.voice), t?.voice ? `Speaks ${t.voice.manner}; ${t.voice.rhythm}.` : ''].filter(Boolean).join(' '),
      };
    }),
    episodes: written.episodes.slice(0, brief.episodes).map((e: any, i: number) => ({ label: `Episode ${i + 1}`, title: str(e.title), script: e.script })),
  });
  await sql.begin(async (tx) => {
    await tx`delete from episodes where project_id = ${p.id}`; // a retried write replaces, never appends
    await tx`update projects set title = ${n.title}, format = ${n.format}, aspect = ${n.aspect}, language = ${n.language}, style = ${tx.json(n.style)},
      story_bible = ${tx.json({ ...n.story_bible, logline: str(written.logline), treatment: treatment || null, quality: { issues: report.issues, episodes: report.episodes, doctor_notes: notes } })},
      updated_at = now() where id = ${p.id}`;
    let i = 0;
    for (const e of n.episodes) await tx`insert into episodes (project_id, idx, label, title, script) values (${p.id}, ${++i}, ${e.label}, ${e.title}, ${e.script})`;
  });
}

/** All writing steps in one go (tools and tests; the autopilot runs them one job at a time). */
export async function writeProduction(projectId: string, ctx: JobCtx) {
  for (let i = 0; i < 8; i++) if ((await writeStep(projectId, ctx)).done) return;
  throw new PermanentError('The script could not be written.', 'write_failed');
}
