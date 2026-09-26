import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Film, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  engine,
  FORMATS,
  isWorking,
  STAGE_LABEL,
  usd,
  type FormatId,
  type ProjectSummary,
} from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Create — Backlot" }] }),
  component: Dashboard,
});

const EXAMPLES = [
  "A night-shift nurse finds a letter in a patient's coat that proves her husband is alive.",
  "Two rival food-truck owners are forced to share one parking spot for a week.",
  "A grandmother teaches her grandson to drive and confesses the secret she kept for 40 years.",
];

function Dashboard() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<FormatId>("microdrama");
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: engine.projects,
    refetchInterval: (q) => (q.state.data?.some((p) => isWorking(p.stage)) ? 5000 : false),
  });

  const create = useMutation({
    mutationFn: () => engine.create({ prompt: prompt.trim(), format }),
    onSuccess: (p) => void navigate({ to: "/p/$projectId", params: { projectId: p.id } }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <StudioShell>
      <section className="mx-auto max-w-3xl">
        <h1 className="text-center text-4xl font-bold leading-tight sm:text-5xl">
          What should we <span className="text-primary">make</span>?
        </h1>
        <p className="mt-3 text-center text-muted-foreground">
          Describe a story. We write it, cast it, shoot it and cut it. You approve the script and
          the price before anything is rendered.
        </p>

        <form
          className="mt-8 border border-border-strong bg-surface p-4 shadow-[var(--shadow-glow)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim().length >= 10) create.mutate();
          }}
        >
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={EXAMPLES[0]}
            rows={4}
            maxLength={4000}
            className="resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={cn(
                  "rounded-sm border px-3 py-1.5 text-left text-xs transition-colors",
                  format === f.id
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:border-primary/60",
                )}
              >
                <span className="font-semibold">{f.label}</span>
                <span className="ml-2 font-mono text-[10px] opacity-70">{f.hint}</span>
              </button>
            ))}
            <Button
              type="submit"
              className="ml-auto"
              disabled={prompt.trim().length < 10 || create.isPending}
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              Create
            </Button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {me?.credits_enforced ? (
            <span>
              Writing and casting {usd(me.prices.setup_fee_usd)} · rendering{" "}
              {usd(me.prices.per_second["768P"] ?? 0)}/second
            </span>
          ) : null}
          {EXAMPLES.slice(1).map((ex) => (
            <button
              key={ex}
              type="button"
              className="underline-offset-2 hover:text-primary hover:underline"
              onClick={() => setPrompt(ex)}
            >
              Try: “{ex.slice(0, 48)}…”
            </button>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="meta-label mb-4">My videos</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !projects?.length ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Your first video starts with one sentence above.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        )}
      </section>
    </StudioShell>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <Link
      to="/p/$projectId"
      params={{ projectId: p.id }}
      className="group border border-border bg-background transition-colors hover:border-primary/60"
    >
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden bg-surface",
          p.aspect === "9:16" ? "aspect-[3/4]" : "aspect-video",
        )}
      >
        {p.thumb_url ? (
          <img src={p.thumb_url} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <Film className="size-6 text-muted-foreground" />
        )}
      </div>
      <div className="p-3">
        <div className="line-clamp-2 text-sm font-semibold">{p.title}</div>
        <div
          className={cn(
            "mt-1 font-mono text-[10px] uppercase tracking-[0.15em]",
            p.stage === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {p.stage ? STAGE_LABEL[p.stage] : "Studio project"}
          {isWorking(p.stage) ? "…" : ""}
        </div>
      </div>
    </Link>
  );
}
