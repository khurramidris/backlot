import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Search } from "lucide-react";
import { useDeferredValue, useState, type ReactNode } from "react";

import { StudioShell } from "@/components/layout/StudioShell";
import { Input } from "@/components/ui/input";
import { engine, formatBytes, usd } from "@/lib/engine";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({ meta: [{ title: "Admin — Backlot" }] }),
  component: Admin,
});

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-extrabold tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Admins only: how the business is doing this week, and every customer, searchable. */
function Admin() {
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: engine.admin.overview,
    retry: false,
  });
  const customers = useQuery({
    queryKey: ["admin", "customers", query],
    queryFn: () => engine.admin.customers(query),
    retry: false,
  });
  const o = overview.data;
  const spend = o?.provider_spend_7d.reduce((t, s) => t + s.usd, 0) ?? 0;

  if (overview.error) {
    return (
      <StudioShell>
        <p className="rounded-lg border border-destructive/50 p-4 text-sm text-destructive">
          Only admins can see this page. Add your user id (Account page) to ADMIN_USER_IDS on the
          server.
        </p>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <span className="meta-label">Admin</span>
      <h1 className="mt-2 text-3xl">Studio overview</h1>
      <p className="mt-2 text-sm text-muted-foreground">The last 7 days.</p>

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Paying customers"
          value={o ? o.subscriptions.paying : "…"}
          hint={o ? `${usd(o.subscriptions.mrr_usd)} a month` : undefined}
        />
        <Tile
          label="Accounts"
          value={o ? o.people.accounts : "…"}
          hint={o ? `${o.people.new_7d} new · ${o.people.active_7d} active` : undefined}
        />
        <Tile
          label="Films"
          value={o ? o.films.finished_7d : "…"}
          hint={
            o
              ? `finished of ${o.films.created_7d} started · ${o.films.failed_7d} failed`
              : undefined
          }
        />
        <Tile
          label="Money in / AI costs out"
          value={o ? `${usd(o.payments_7d.usd)} / ${usd(spend)}` : "…"}
          hint={
            o?.provider_spend_7d.length
              ? o.provider_spend_7d.map((s) => `${s.kind} ${usd(s.usd)}`).join(" · ")
              : "no provider spend yet"
          }
        />
      </section>

      {o?.recent_failures.length ? (
        <section className="mt-10">
          <h2 className="meta-label mb-3">Recent failed films</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {o.recent_failures.map((f) => (
              <li key={f.id} className="p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{f.title}</span>
                  <span className="text-xs text-muted-foreground">{ago(f.updated_at)}</span>
                </div>
                <div className="mt-1 text-destructive">{f.stage_error || "No error recorded."}</div>
                <Link
                  to="/admin/$ownerId"
                  params={{ ownerId: f.owner_id }}
                  className="mt-1 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  {f.email || f.owner_id}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="meta-label">Customers</h2>
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search email or user id"
              className="pl-9"
              aria-label="Search customers"
            />
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 text-right font-medium">Credits</th>
                <th className="px-4 py-3 text-right font-medium">Videos</th>
                <th className="px-4 py-3 text-right font-medium">Storage</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {customers.data?.map((c) => (
                <tr key={c.owner_id} className="hover:bg-accent/50">
                  <td className="px-4 py-3">
                    <Link
                      to="/admin/$ownerId"
                      params={{ ownerId: c.owner_id }}
                      className="font-medium hover:text-primary"
                    >
                      {c.email || <span className="font-mono text-xs">{c.owner_id}</span>}
                    </Link>
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">
                    {c.plan_status?.replace("_", " ") || "none"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {usd(c.plan_usd + c.topup_usd)}
                  </td>
                  <td className="px-4 py-3 text-right">{c.projects}</td>
                  <td className="px-4 py-3 text-right">{formatBytes(c.storage_bytes)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{ago(c.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {customers.data && !customers.data.length ? (
            <p className="p-4 text-sm text-muted-foreground">No customers match.</p>
          ) : null}
        </div>
      </section>
    </StudioShell>
  );
}
