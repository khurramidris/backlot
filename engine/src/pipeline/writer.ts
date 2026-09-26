// Prompt → production. Claude writes the title, look, cast and a Fountain screenplay per episode, in
// the same shape the importer accepts, so everything downstream (breakdown onwards) is unchanged.

import { z } from 'zod';
import { sql } from '../db.js';
import { config } from '../config.js';
import { PermanentError, type JobCtx } from '../queue.js';
import { claudeJSON, llmCost } from '../providers/claude.js';
import { recordUsage } from '../usage.js';
import { parseFountain, parseScenes } from './fountain.js';
import { normalizeImport } from './importer.js';
import { WRITER_SYSTEM, writerPrompt } from './prompts.js';

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

export async function writeProduction(projectId: string, ctx: JobCtx) {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  const brief = p.brief as Brief;
  const f = FORMATS[brief.format];
  const input = { prompt: brief.prompt, format: f.label, formatNotes: f.notes, aspect: brief.aspect, episodes: brief.episodes, secondsPerEpisode: brief.seconds, language: brief.language };

  let written: any = null, problem = '';
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    await ctx.progress(attempt ? 'Rewriting the script' : 'Writing the script');
    const prompt = writerPrompt(input) + (problem ? `\n\nYOUR PREVIOUS ANSWER WAS UNUSABLE: ${problem}. Fix that.` : '');
    const r = await claudeJSON({ task: 'write', system: WRITER_SYSTEM, prompt, input, maxTokens: 16000 });
    await recordUsage({ ownerId: p.owner_id, projectId, kind: 'llm', units: r.usage.input + r.usage.output, cost: llmCost(r.model, r.usage), ref: 'write' });
    problem = checkWritten(r.data, brief);
    if (!problem) written = r.data;
  }
  if (!written) throw new PermanentError(`The script could not be written: ${problem}.`, 'write_failed');

  const str = (v: any) => (v == null ? '' : String(v));
  const n = normalizeImport({
    title: str(written.title).slice(0, 200) || 'Untitled', format: brief.engineFormat, aspect: brief.aspect, resolution: '768P', language: brief.language,
    style: Object.fromEntries(Object.entries(written.style || {}).map(([k, v]) => [k, str(v)])),
    world: str(written.world),
    characters: (Array.isArray(written.characters) ? written.characters : []).map((c: any) => ({
      id: str(c.id || c.name), name: str(c.name || c.id), age: str(c.age), role: str(c.role), description: str(c.description), voice: str(c.voice),
    })),
    episodes: written.episodes.slice(0, brief.episodes).map((e: any, i: number) => ({ label: `Episode ${i + 1}`, title: str(e.title), script: e.script })),
  });

  await sql.begin(async (tx) => {
    await tx`delete from episodes where project_id = ${projectId}`; // a retried write replaces, never appends
    await tx`update projects set title = ${n.title}, format = ${n.format}, aspect = ${n.aspect}, language = ${n.language}, style = ${tx.json(n.style)},
      story_bible = ${tx.json({ ...n.story_bible, logline: str(written.logline) })}, updated_at = now() where id = ${projectId}`;
    let i = 0;
    for (const e of n.episodes) await tx`insert into episodes (project_id, idx, label, title, script) values (${projectId}, ${++i}, ${e.label}, ${e.title}, ${e.script})`;
  });
  return { title: n.title, episodes: n.episodes.length };
}
