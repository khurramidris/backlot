// Story-engine quality run: sample ideas → writers' room → breakdown → director's plan → shot plans, then a
// report of what came out. Use it to judge a prompt change on real output instead of guessing, and to see how far
// the engine carries a cheaper model: run it once per model (CLAUDE_MODEL, or CLAUDE_MODELS for single steps).
//
//   Mock plumbing check (free):   DATABASE_URL=postgres:///evaldb MOCK_PROVIDERS=1 npx tsx scripts/eval-story.ts
//   Real run (costs money):       DATABASE_URL=… ANTHROPIC_API_KEY=… EVAL_CONFIRM=1 npx tsx scripts/eval-story.ts [--only 3]
//   See every prompt as sent:     add PROMPT_LOG_DIR=data/prompts (works in mock runs too, for free)
//   A whole 90-minute microdrama:  add --long (one idea, 72 episodes; shot plans for the first episode only)
//   Estimate what a run costs:     MOCK_PROVIDERS=1 ESTIMATE_COSTS=1 … (prices the mock's prompts as real calls)
//
// A real run makes about 20 to 30 Claude calls per idea (most of them small scene and shot calls), roughly $1–3 per
// idea at Opus prices with high effort. Images and video are not generated. Output: data/eval/<time>/report.md plus
// every take, bible, scene card, script and shot plan, so a person can read them. Use an empty database; it can be
// deleted afterwards. The critic's scores are the model grading its own room's work: compare them across runs, and
// read the scripts.

process.env.ALLOW_DEV_TOKENS ??= process.env.MOCK_PROVIDERS ? '1' : '';
process.env.FILE_SIGNING_SECRET ??= 'eval-only-signing-secret-not-used-for-serving';

const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
const { config } = await import('../src/config.js');
const { sql, migrate } = await import('../src/db.js');
const { resolveBrief, writeProduction } = await import('../src/pipeline/writer.js');
const { runBreakdown } = await import('../src/pipeline/breakdown.js');
const { planEpisode } = await import('../src/pipeline/shots.js');

const LONG = process.argv.includes('--long');
const IDEAS: { prompt: string; format: string; language?: string; total_seconds?: number }[] = LONG ? [
  { prompt: "A night-shift nurse finds a letter in a patient's coat that proves her husband is alive.", format: 'microdrama', total_seconds: 90 * 60 },
] : [
  { prompt: "A night-shift nurse finds a letter in a patient's coat that proves her husband is alive.", format: 'microdrama' },
  { prompt: "A night-shift nurse finds a letter in a patient's coat that proves her husband is alive.", format: 'microdrama' }, // same idea again: should not repeat
  { prompt: 'Two rival food-truck owners are forced to share one parking spot for a week.', format: 'short_film' },
  { prompt: 'A grandmother teaches her grandson to drive and confesses the secret she kept for 40 years.', format: 'youtube' },
  { prompt: "In Lahore, a young woman pretends to be engaged to her boss to stop her family's matchmaking.", format: 'microdrama', language: 'Urdu' },
  { prompt: "A heist crew's getaway driver realises the job is a setup.", format: 'web_series' },
  { prompt: "A lonely lighthouse keeper starts receiving letters from someone who shouldn't exist.", format: 'short_film' },
  { prompt: "An intern discovers the startup's CEO has been faking the company's success.", format: 'microdrama' },
];

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? Number(process.argv[onlyArg + 1]) : IDEAS.length;
if (!config.mock && process.env.EVAL_CONFIRM !== '1') {
  console.error(`This calls Claude for real (about $1–2 per idea, ${only} ideas). Re-run with EVAL_CONFIRM=1 to go ahead.`);
  process.exit(1);
}

const OWNER = 'eeeeeeee-0000-4000-8000-00000000e7a1'; // one owner, so later ideas see earlier ones as "recent work"
const OUT = join('data', 'eval', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(OUT, { recursive: true });
await migrate();
const ctx = { job: { id: 0 } as any, progress: async (m: string) => { process.stdout.write(`    · ${m}\n`); } };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
const rows: string[] = [];
const names: string[] = [];

for (const [n, idea] of IDEAS.slice(0, only).entries()) {
  const t0 = Date.now();
  console.log(`\n${n + 1}. ${idea.prompt} (${idea.format})`);
  const brief = resolveBrief({ prompt: idea.prompt, format: idea.format, language: idea.language || 'English', total_seconds: idea.total_seconds });
  const [p] = await sql`insert into projects (owner_id, title, format, aspect, language, mode, stage, brief, settings)
    values (${OWNER}, ${idea.prompt.slice(0, 80)}, ${brief.engineFormat}, ${brief.aspect}, ${brief.language}, 'vibe', 'writing', ${sql.json(brief as any)}, ${sql.json({ chain_clips: true })}) returning id`;
  const dir = join(OUT, `${n + 1}-${slug(idea.prompt)}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeProduction(p.id, ctx);
    await runBreakdown(p.id, ctx, { force: true });
    const [ep] = await sql`select id from episodes where project_id = ${p.id} order by idx limit 1`;
    await planEpisode(ep.id, ctx, { force: true });

    const [proj] = await sql`select * from projects where id = ${p.id}`;
    const eps = await sql`select idx, title, script, direction from episodes where project_id = ${p.id} order by idx`;
    const assets = await sql`select kind, key, name, description, meta from assets where project_id = ${p.id} order by kind, key`;
    const shots = await sql`select code, duration, plan, prompt from shots where episode_id = ${ep.id} order by idx`;
    const [{ cost, writing, design, shotPlan }] = await sql`select coalesce(sum(cost_usd), 0)::float cost,
        coalesce(sum(cost_usd) filter (where ref_id not like 'breakdown%' and ref_id not like 'plan:%' and ref_id not like 'direct:%'), 0)::float writing,
        coalesce(sum(cost_usd) filter (where ref_id like 'breakdown%'), 0)::float design,
        coalesce(sum(cost_usd) filter (where ref_id like 'plan:%' or ref_id like 'direct:%'), 0)::float "shotPlan"
      from usage_events where project_id = ${p.id}`;
    const nEps = (await sql`select count(*)::int n from episodes where project_id = ${p.id}`)[0].n;
    console.log(`  cost: writing $${writing.toFixed(2)}, breakdown $${design.toFixed(2)}, shot plan $${shotPlan.toFixed(2)} for episode 1 (about $${(shotPlan * nEps).toFixed(2)} for all ${nEps})${process.env.ESTIMATE_COSTS === '1' ? ' (estimated from prompt sizes)' : ''}`);
    const sb = proj.story_bible || {};

    await writeFile(join(dir, 'bible.json'), JSON.stringify(sb.treatment, null, 2));
    const q0 = sb.quality || {};
    await writeFile(join(dir, 'takes.md'), (q0.concepts || []).map((c: any, i: number) => {
      const sc = (q0.choice?.scores || []).find((x: any) => +x.concept === i);
      return `## ${i === q0.choice?.chosen ? '✔ ' : ''}Take ${i}: ${c.title}\n${c.logline}\nHook: ${c.hook}\nTurn: ${c.turn}\nEnding: ${c.ending}${sc ? `\nScores: ${['fidelity', 'hook', 'stakes', 'specificity', 'surprise', 'renderable'].map((k) => `${k} ${sc[k]}`).join(', ')}` : ''}`;
    }).join('\n\n') + (q0.choice?.notes?.length ? `\n\n## Development notes\n${q0.choice.notes.map((n: string) => `- ${n}`).join('\n')}` : ''));
    await writeFile(join(dir, 'outline.md'), (sb.outline || []).map((o: any) => `# Episode ${o.episode}\n\n${o.scenes.map((c: any, i: number) => `## ${i + 1}. ${c.heading} (${c.seconds}s) [${c.characters.join(', ')}]\nPurpose: ${c.purpose}\nWants: ${c.objectives.map((x: any) => `${x.who}: ${x.wants} (${x.tactic})`).join('; ')}\nUnderneath: ${c.subtext}\nTurn: ${c.turn} (${c.value})\nKey image: ${c.key_image}\nExit: ${c.exit}`).join('\n\n')}`).join('\n\n'));
    await writeFile(join(dir, 'script.fountain'), eps.map((e: any) => `# Episode ${e.idx}: ${e.title}\n\n${e.script}`).join('\n\n'));
    await writeFile(join(dir, 'design.md'), assets.map((a: any) => `## ${a.kind}: ${a.name}\n${a.description}${a.meta?.layout ? `\nLayout: ${a.meta.layout}` : ''}`).join('\n\n'));
    await writeFile(join(dir, 'direction.json'), JSON.stringify(eps[0].direction, null, 2));
    await writeFile(join(dir, 'shots.md'), shots.map((s: any) => `## Shot ${s.code} (${s.duration}s): ${s.plan.purpose || ''}\n${s.plan.warnings?.length ? `Warnings: ${s.plan.warnings.join('; ')}\n` : ''}\n\`\`\`\n${s.prompt}\n\`\`\``).join('\n\n'));

    // Shot-language variety: how many different sizes and moves, per beat.
    const beats = shots.flatMap((s: any) => s.plan.beats || []);
    const distinct = (f: (b: any) => string) => new Set(beats.map((b: any) => f(b).toLowerCase().replace(/\b(slow|slowly|very|gentle)\b/g, '').trim())).size;
    const warnings = shots.flatMap((s: any) => s.plan.warnings || []);
    const q = sb.quality || { issues: [], episodes: [], doctor_notes: [] };
    const chars = (sb.characters || []).map((c: any) => c.name);
    names.push(...chars.map((c: string) => c.split(' ')[0]));
    const sc = q.scores || {};
    const critic = ['hook', 'turns', 'escalation', 'dialogue', 'specificity', 'ending', 'fidelity'].map((k) => sc[k] ?? '-').join('/');
    const kept = (q.doctor_notes || []).filter((x: string) => /^E\d+ scene/.test(x)).length;
    rows.push(`| ${n + 1} | ${proj.title} | ${(sb.treatment?.genre || '').slice(0, 24)} | ${q.episodes.map((e: any) => `${e.seconds}/${e.target}s`).join(', ')} | ${q.issues.length} | ${critic} | ${kept} | ${shots.length} | ${beats.length ? (shots.reduce((t: number, s: any) => t + s.duration, 0) / shots.length).toFixed(1) : '-'}s | ${distinct((b) => b.shot)} / ${distinct((b) => b.camera || 'static')} | ${warnings.filter((w: string) => /added/.test(w)).length} | $${cost.toFixed(2)} | ${((Date.now() - t0) / 1000).toFixed(0)}s | ${chars.join(', ')} |`);
    await writeFile(join(dir, 'quality.json'), JSON.stringify({ quality: q, warnings }, null, 2));
    console.log(`  ✓ "${proj.title}": ${shots.length} shots, ${q.issues.length} open issues, $${cost.toFixed(2)}`);
  } catch (e: any) {
    rows.push(`| ${n + 1} | FAILED: ${String(e.message).slice(0, 80)} | | | | | | | | | | | | |`);
    console.log(`  ✗ ${e.message}`);
  }
}

const dupes = [...names.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map<string, number>())].filter(([, c]) => c > 1);
const report = `# Story engine run, ${new Date().toISOString()}

Model ${config.mock ? 'mock' : config.anthropic.model}${Object.keys(config.anthropic.models).length ? ` (per step: ${Object.entries(config.anthropic.models).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}, effort ${config.anthropic.effort} (planning ${config.anthropic.planningEffort}), polish ${config.anthropic.scriptDoctor ? 'on' : 'off'}, ${config.anthropic.keyDrafts} draft(s) of openings and endings, structured outputs ${config.anthropic.structured ? 'on' : 'off'}, thinking ${config.anthropic.thinking ? 'on' : 'off'}.

| # | Title | Genre | Runtime / target | Open issues | Critic: hook/turns/escalation/dialogue/specificity/ending/fidelity | Rewrites kept | Shots | Avg shot | Sizes / moves used | Actions added by code | LLM cost | Time | Characters |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

**Repeated first names across stories:** ${dupes.length ? dupes.map(([n, c]) => `${n} ×${c}`).join(', ') : 'none'}

How to read it: fewer open issues and fewer actions added by code are better; higher critic scores are better (the
model grades its own room, so compare runs rather than trust one number); more sizes and moves used means more varied
direction; repeated names or near-identical titles across stories mean the engine is converging. Read takes.md,
outline.md and the scripts in each folder: the numbers only point at where to look.
`;
await writeFile(join(OUT, 'report.md'), report);
console.log(`\n${report}\nWritten to ${OUT}`);
process.exit(0);
