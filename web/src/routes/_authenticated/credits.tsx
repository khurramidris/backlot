import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { engine, usd } from "@/lib/engine";

export const Route = createFileRoute("/_authenticated/credits")({
  validateSearch: z.object({ paid: z.coerce.number().optional() }),
  head: () => ({ meta: [{ title: "Credits — Backlot" }] }),
  component: Credits,
});

function Credits() {
  const { paid } = Route.useSearch();
  const qc = useQueryClient();
  // Stripe confirms payments through a webhook, which can land a moment after the redirect back.
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: engine.me,
    refetchInterval: paid ? 3000 : false,
  });
  useEffect(() => {
    if (paid) toast.success("Payment received. Your credits appear here within a few seconds.");
  }, [paid]);

  const buy = useMutation({
    mutationFn: (pack: string) => engine.checkout(pack),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const perSecond = me?.prices.per_second["768P"] ?? 0;
  return (
    <StudioShell>
      <h1 className="text-3xl font-bold">Credits</h1>
      <p className="mt-2 text-muted-foreground">
        Balance{" "}
        <span className="font-semibold text-foreground">{me ? usd(me.balance_usd) : "…"}</span>
      </p>

      {me ? (
        <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
          Each video costs {usd(me.prices.setup_fee_usd)} for writing, casting and planning, then{" "}
          {usd(perSecond)} per second of finished footage (a one-minute episode is about{" "}
          {usd(perSecond * 60)}). You see the exact price and approve it before anything is filmed.
          Shots that fail to render are never charged.
        </p>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {me?.packs.map((p) => (
          <div key={p.id} className="border border-border bg-background p-6">
            <div className="meta-label">{p.id}</div>
            <div className="mt-2 text-3xl font-bold">{usd(p.usd)}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              ≈ {Math.floor(p.usd / (perSecond * 60 + (me.prices.setup_fee_usd || 0)) || 0)}{" "}
              one-minute videos
            </div>
            <Button
              className="mt-4 w-full"
              onClick={() => buy.mutate(p.id)}
              disabled={!me.payments_enabled || buy.isPending}
            >
              {buy.isPending && buy.variables === p.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Buy
            </Button>
          </div>
        ))}
      </div>
      {me && !me.payments_enabled ? (
        <p className="mt-4 text-sm text-muted-foreground">Payments are not switched on yet.</p>
      ) : null}
    </StudioShell>
  );
}
