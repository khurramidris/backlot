import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Film, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StudioShell } from "@/components/layout/StudioShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  canCreate,
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

        {me && !canCreate(me) ? (
          <SubscribePanel
            ended={!!me.plan.status}
            price={me.plan.price_usd}
            credits={me.plan.credits_usd}
            storageGb={me.plan.storage_gb}
          />
        ) : (
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
        )}

        <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {me?.credits_enforced ? (
            <span>
              Writing and casting {usd(me.prices.setup_fee_usd)} · rendering{" "}
              {usd(me.prices.per_second["768P"] ?? 0)}/second
            </span>
          ) : null}
          {(canCreate(me) ? EXAMPLES.slice(1) : []).map((ex) => (
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

function SubscribePanel(props: {
  ended: boolean;
  price: number;
  credits: number;
  storageGb: number;
}) {
  return (
    <div className="mt-8 border border-primary/50 bg-surface p-8 text-center shadow-[var(--shadow-glow)]">
      <Sparkles className="mx-auto size-6 text-primary" />
      <h2 className="mt-3 text-xl font-bold">
        {props.ended ? "Your plan has ended" : "Subscribe to start creating"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        The Basic plan is {usd(props.price)}/month and includes {usd(props.credits)} of credits
        every month and {props.storageGb} GB of storage for your films.
      </p>
      <Button asChild className="mt-5">
        <Link to="/billing">{props.ended ? "Subscribe again" : "See the plan"}</Link>
      </Button>
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => engine.remove(p.id),
    onSuccess: () => {
      toast.success("Video deleted.");
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <div className="group relative border border-border bg-background transition-colors hover:border-primary/60">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            aria-label={`Delete ${p.title}`}
            className="absolute right-2 top-2 z-10 rounded-sm bg-background/80 p-1.5 text-muted-foreground opacity-100 backdrop-blur-sm transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          >
            {remove.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The script, cast, every clip and the finished film are deleted for good, and the
              storage they used is freed. Renders still running are stopped and refunded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => remove.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Link to="/p/$projectId" params={{ projectId: p.id }} className="block">
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
    </div>
  );
}
