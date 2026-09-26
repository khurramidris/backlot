// What providers cost us (for margins and spend reports). Customer money lives in billing.ts.
import { sql } from './db.js';

export async function recordUsage(o: { ownerId: string; projectId?: string | null; kind: 'llm' | 'image' | 'voice' | 'video'; units: number; cost: number; ref?: string; estimated?: boolean }) {
  await sql`insert into usage_events (owner_id, project_id, kind, ref_id, units, cost_usd, estimated)
    values (${o.ownerId}, ${o.projectId ?? null}, ${o.kind}, ${o.ref ?? null}, ${o.units}, ${o.cost}, ${o.estimated ?? false})`;
}

export async function projectSpend(projectId: string) {
  const rows = await sql`select kind, sum(cost_usd)::float cost, sum(units)::float units from usage_events where project_id = ${projectId} group by kind`;
  const by: Record<string, { cost: number; units: number }> = {};
  let total = 0;
  for (const r of rows) { by[r.kind] = { cost: +r.cost, units: +r.units }; total += +r.cost; }
  return { total_usd: +total.toFixed(4), by_kind: by };
}
