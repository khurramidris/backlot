// Story-engine quality run: sample ideas → writers' room → breakdown → director's plan → shot plans, then a
// report of what came out. Use it to judge a prompt change on real output instead of guessing.
//
//   Mock plumbing check (free):   DATABASE_URL=postgres:///evaldb MOCK_PROVIDERS=1 npx tsx scripts/eval-story.ts
//   Real run (costs money):       DATABASE_URL=… ANTHROPIC_API_KEY=… EVAL_CONFIRM=1 npx tsx scripts/eval-story.ts [--only 3]
//
// A real run makes about 8 to 10 Claude calls per idea, roughly $1–2 each at Opus prices with high effort.
// Images and video are not generated. Output: data/eval/<time>/report.md plus every treatment, script and
// shot plan, so a person can read them. Use an empty database; it can be deleted afterwards.

process.env.ALLOW_DEV_TOKENS ??= process.env.MOCK_PROVIDERS ? '1' : '';
process.env.FILE_SIGNING_SECRET ??= 'eval-only-signing-secret-not-used-for-serving';

const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
const { config } = await import('../src/config.js');
const { sql, migrate } = await import('../src/db.js');
const { resolveBrief, writeProduction } = await import('../src/pipeline/writer.js');
const { runBreakdown } = await import('../src/pipeline/breakdown.js');
const { planEpisode } = await import('../src/pipeline/shots.js');

const IDEAS: { prompt: string; format: string; language?: string }[] = [
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
  const brief = resolveBrief({ prompt: idea.prompt, format: idea.format, language: idea.language || 'English' });
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
    const [{ cost }] = await sql`select coalesce(sum(cost_usd), 0)::float cost from usage_events where project_id = ${p.id}`;
    const sb = proj.story_bible || {};

    await writeFile(join(dir, 'treatment.json'), JSON.stringify(sb.treatment, null, 2));
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
    rows.push(`| ${n + 1} | ${proj.title} | ${(sb.treatment?.genre || '').slice(0, 24)} | ${q.episodes.map((e: any) => `${e.seconds}/${e.target}s`).join(', ')} | ${q.issues.length} | ${q.doctor_notes.length} | ${shots.length} | ${beats.length ? (shots.reduce((t: number, s: any) => t + s.duration, 0) / shots.length).toFixed(1) : '-'}s | ${distinct((b) => b.shot)} / ${distinct((b) => b.camera || 'static')} | ${warnings.filter((w: string) => /added/.test(w)).length} | $${cost.toFixed(2)} | ${((Date.now() - t0) / 1000).toFixed(0)}s | ${chars.join(', ')} |`);
    await writeFile(join(dir, 'quality.json'), JSON.stringify({ quality: q, warnings, concepts: proj.autopilot?.writing?.concepts }, null, 2));
    console.log(`  ✓ "${proj.title}": ${shots.length} shots, ${q.issues.length} open issues, $${cost.toFixed(2)}`);
  } catch (e: any) {
    rows.push(`| ${n + 1} | FAILED: ${String(e.message).slice(0, 80)} | | | | | | | | | | | |`);
    console.log(`  ✗ ${e.message}`);
  }
}

const dupes = [...names.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map<string, number>())].filter(([, c]) => c > 1);
const report = `# Story engine run, ${new Date().toISOString()}

Model ${config.mock ? 'mock' : config.anthropic.model}, effort ${config.anthropic.effort} (planning ${config.anthropic.planningEffort}), script doctor ${config.anthropic.scriptDoctor ? 'on' : 'off'}.

| # | Title | Genre | Runtime / target | Open issues | Doctor fixes | Shots | Avg shot | Sizes / moves used | Actions added by code | LLM cost | Time | Characters |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

**Repeated first names across stories:** ${dupes.length ? dupes.map(([n, c]) => `${n} ×${c}`).join(', ') : 'none'}

How to read it: fewer open issues and fewer actions added by code are better; more sizes and moves used means more varied
direction; repeated names or near-identical titles across stories mean the engine is converging. Read the scripts
themselves in each folder: the numbers only point at where to look.
`;
await writeFile(join(OUT, 'report.md'), report);
console.log(`\n${report}\nWritten to ${OUT}`);
process.exit(0);
