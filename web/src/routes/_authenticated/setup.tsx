import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleX, Loader2, RefreshCw } from "lucide-react";

import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { engine, type SetupCheck } from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/setup")({
  head: () => ({ meta: [{ title: "Setup check — Backlot" }] }),
  component: Setup,
});

const ICON = {
  ok: <CircleCheck className="size-5 text-success" />,
  warn: <CircleAlert className="size-5 text-warning" />,
  fail: <CircleX className="size-5 text-destructive" />,
};

/** Admins only: every setting and service checked for real, with a plain-words fix for anything wrong. */
function Setup() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["preflight"],
    queryFn: engine.preflight,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const areas = [...new Set((data ?? []).map((c) => c.area))];
  const failed = data?.filter((c) => c.status === "fail").length ?? 0;
  const warned = data?.filter((c) => c.status === "warn").length ?? 0;

  return (
    <StudioShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="meta-label">Admin</span>
          <h1 className="mt-2 text-3xl">Setup check</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Every setting and outside service, tested for real. Fix anything red, read anything
            amber, then press "Check again".
          </p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check again
        </Button>
      </div>

      {error ? (
        <p className="mt-8 rounded-lg border border-destructive/50 p-4 text-sm text-destructive">
          {(error as Error).message === "page not found"
            ? "Only admins can see this page. Add your user id (Account page) to ADMIN_USER_IDS on the server, then redeploy."
            : (error as Error).message}
        </p>
      ) : !data ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking every service (about 10 seconds)…
        </p>
      ) : (
        <>
          <div
            className={cn(
              "mt-8 rounded-lg border p-4 text-sm font-medium",
              failed
                ? "border-destructive/50 text-destructive"
                : warned
                  ? "border-warning/50 text-warning"
                  : "border-success/50 text-success",
            )}
          >
            {failed
              ? `${failed} thing${failed === 1 ? "" : "s"} to fix before launch.`
              : warned
                ? "Nothing blocking. Read the amber notes."
                : "Everything is ready."}
          </div>
          {areas.map((area) => (
            <section key={area} className="mt-8">
              <h2 className="meta-label mb-3">{area}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {data
                  .filter((c) => c.area === area)
                  .map((c: SetupCheck) => (
                    <li key={c.name} className="flex gap-3 p-4">
                      <span className="mt-0.5 shrink-0">{ICON[c.status]}</span>
                      <div>
                        <div className="text-sm font-semibold">{c.name}</div>
                        <div className="mt-0.5 text-sm text-muted-foreground">{c.detail}</div>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </StudioShell>
  );
}
