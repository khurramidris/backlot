import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { CompanyDashboard } from "@/components/admin/CompanyDashboard";
import { StudioShell } from "@/components/layout/StudioShell";
import { Input } from "@/components/ui/input";
import { engine, formatBytes, usd } from "@/lib/engine";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({ meta: [{ title: "Admin — Backlot" }] }),
  component: Admin,
});

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

/** Admins only: the company at a glance, and every customer, searchable. */
function Admin() {
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const customers = useQuery({
    queryKey: ["admin", "customers", query],
    queryFn: () => engine.admin.customers(query),
    retry: false,
  });

  return (
    <StudioShell>
      <span className="meta-label">Admin</span>
      <h1 className="mt-2 text-3xl">Company</h1>
      <p className="mt-2 mb-4 text-sm text-muted-foreground">
        Money in and out, customers, what they made, and anything that needs you.
      </p>
      <CompanyDashboard />

      <section className="mt-12">
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
