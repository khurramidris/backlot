import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Clapperboard, Film, Loader2, Play, Timer, Trash2, Wallet } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import heroImage from "@/assets/hero-stage.jpg";
import { ClipForm } from "@/components/ClipForm";
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
  type Me,
  type ProjectSummary,
} from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Home — Backlot" }] }),
  component: Dashboard,
});

const EXAMPLES = [
  "A night-shift nurse finds a letter in a patient's coat that proves her husband is alive.",
  "Two rival food-truck owners are forced to share one parking spot for a week.",
  "A grandmother teaches her grandson to drive and confesses the secret she kept for 40 years.",
];

function Dashboard() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: engine.projects,
    refetchInterval: (q) => (q.state.data?.some((p) => isWorking(p.stage)) ? 5000 : false),
  });

  return (
    <StudioShell>
      <section
        id="create"
        className="relative scroll-mt-24 overflow-hidden rounded-xl border border-border bg-cinema"
      >
        <img
          src={heroImage}
          alt=""
          className="absolute inset-0 size-full object-cover opacity-60"
          aria-hidden
        />
        <div className="absolute inset-0 bg-gradient-to-r from-cinema via-cinema/85 to-cinema/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-cinema via-transparent to-transparent" />
        <div className="relative grid gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <span className="meta-label text-primary">Your studio</span>
            <h1 className="mt-3 text-4xl leading-[1.02] sm:text-5xl">
              From prompt
              <br />
              to picture.
            </h1>
            <p className="mt-3 max-w-lg text-muted-foreground">
              Describe a story. We write it, cast it, shoot it and cut it. You approve the script
              and the price before anything is filmed. Or make a single clip from a sentence, a
              picture or a video.
            </p>
            {me && !canCreate(me) ? <SubscribePanel me={me} /> : <Creator me={me} />}
          </div>
          <div className="hidden self-end text-right lg:block">
            <p className="meta-label leading-relaxed text-foreground/80">
              Same stories.
              <br />
              New worlds.
            </p>
            <span className="brand-dash ml-auto mt-3" />
          </div>
        </div>
      </section>

      <Stats me={me} projects={projects} />

      <section className="mt-12">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-xl">Recent videos</h2>
          {projects?.length ? (
            <span className="text-xs text-muted-foreground">{projects.length} in your studio</span>
          ) : null}
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !projects?.length ? (
          <div className="rounded-xl border border-dashed border-border-strong p-10 text-center">
            <Film className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              Nothing yet. Your first video starts with one sentence above.
            </p>
          </div>
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

/** Story film (the whole pipeline) or a quick clip (one shot from text, a picture or a video). */
function Creator({ me }: { me: Me | undefined }) {
  const [kind, setKind] = useState<"story" | "clip">(() =>
    typeof window !== "undefined" && window.location.hash === "#clip" ? "clip" : "story",
  );
  return (
    <>
      <div
        className="mt-6 inline-flex rounded-lg border border-border-strong bg-cinema/80 p-0.5 text-sm backdrop-blur-sm"
        role="tablist"
        aria-label="What to make"
      >
        {(["story", "clip"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              "rounded-md px-4 py-1.5 transition-colors",
              kind === k
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {k === "story" ? "Story film" : "Quick clip"}
          </button>
        ))}
      </div>
      {kind === "story" ? <CreateForm me={me} /> : <ClipForm me={me} />}
    </>
  );
}

function CreateForm({ me }: { me: Me | undefined }) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<FormatId>("microdrama");
  const box = useRef<HTMLTextAreaElement>(null);
  // "New video" in the top bar links to #create: put the cursor in the prompt box.
  useEffect(() => {
    const focus = () => window.location.hash === "#create" && box.current?.focus();
    focus();
    window.addEventListener("hashchange", focus);
    return () => window.removeEventListener("hashchange", focus);
  }, []);

  const create = useMutation({
    mutationFn: () => engine.create({ prompt: prompt.trim(), format }),
    onSuccess: (p) => void navigate({ to: "/p/$projectId", params: { projectId: p.id } }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <>
      <form
        className="mt-3 rounded-lg border border-border-strong bg-cinema/80 p-3 backdrop-blur-sm focus-within:border-primary/70"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim().length >= 10) create.mutate();
        }}
      >
        <Textarea
          ref={box}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={EXAMPLES[0]}
          aria-label="Your story"
          rows={3}
          maxLength={4000}
          className="resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              title={f.hint}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                format === f.id
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border-strong text-muted-foreground hover:border-primary/60 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
          <Button
            type="submit"
            className="ml-auto"
            disabled={prompt.trim().length < 10 || create.isPending}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            Create
          </Button>
        </div>
      </form>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {me?.credits_enforced ? (
          <span>
            Writing and casting {usd(me.prices.setup_fee_usd)} · filming{" "}
            {usd(me.prices.per_second["768P"] ?? 0)}/second
          </span>
        ) : null}
        {EXAMPLES.slice(1).map((ex) => (
          <button
            key={ex}
            type="button"
            className="underline-offset-2 hover:text-primary hover:underline"
            onClick={() => {
              setPrompt(ex);
              box.current?.focus();
            }}
          >
            Try: “{ex.slice(0, 40)}…”
          </button>
        ))}
      </div>
    </>
  );
}

function SubscribePanel({ me }: { me: Me }) {
  const ended = !!me.plan.status;
  return (
    <div className="mt-6 max-w-lg rounded-lg border border-primary/50 bg-cinema/80 p-6 shadow-[var(--shadow-glow)] backdrop-blur-sm">
      <h2 className="text-xl">{ended ? "Your plan has ended" : "Subscribe to start creating"}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The {me.plan.name} plan is {usd(me.plan.price_usd)}/month and includes{" "}
        {usd(me.plan.credits_usd)} of credits every month and {me.plan.storage_gb} GB of storage for
        your films and clips.
      </p>
      <Button asChild className="mt-5">
        <Link to="/billing">{ended ? "Subscribe again" : "See the plan"}</Link>
      </Button>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary [&_svg]:size-5">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-extrabold leading-none tracking-tight">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function Stats({ me, projects }: { me: Me | undefined; projects: ProjectSummary[] | undefined }) {
  const all = projects ?? [];
  return (
    <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat icon={<Clapperboard />} label="Videos" value={String(all.length)} />
      <Stat
        icon={<Play />}
        label="Finished"
        value={String(all.filter((p) => p.stage === "done").length)}
      />
      <Stat
        icon={<Timer />}
        label="In production"
        value={String(all.filter((p) => isWorking(p.stage)).length)}
      />
      <Stat
        icon={<Wallet />}
        label={me?.credits_enforced ? "Credits" : "Credits (not charged locally)"}
        value={me ? usd(me.credits.total) : "…"}
      />
    </section>
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
  const working = isWorking(p.stage);
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/60">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            aria-label={`Delete ${p.title}`}
            className="absolute right-2 top-2 z-10 rounded-md bg-cinema/70 p-1.5 text-muted-foreground opacity-100 backdrop-blur-sm transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
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
        <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-surface">
          {p.thumb_url ? (
            <img
              src={p.thumb_url}
              alt=""
              className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <Film className="size-6 text-muted-foreground" />
          )}
          {p.thumb_url ? (
            <span className="absolute inset-0 flex items-center justify-center bg-cinema/40 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Play className="size-5 fill-current" />
              </span>
            </span>
          ) : null}
          <span className="absolute bottom-2 left-2 rounded bg-cinema/75 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 backdrop-blur-sm">
            {p.mode === "clip" ? "Clip · " : ""}
            {p.aspect}
          </span>
        </div>
        <div className="p-3">
          <div className="line-clamp-1 text-sm font-semibold">{p.title}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs">
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                p.stage === "failed"
                  ? "text-destructive"
                  : p.stage === "ready"
                    ? "text-warning"
                    : p.stage === "done"
                      ? "text-success"
                      : "text-muted-foreground",
              )}
            >
              {working ? <span className="size-1.5 animate-pulse rounded-full bg-primary" /> : null}
              {p.stage ? STAGE_LABEL[p.stage] : "Studio project"}
            </span>
            <span className="text-muted-foreground">
              {formatDistanceToNow(new Date(p.updated_at), { addSuffix: true })}
            </span>
          </div>
        </div>
      </Link>
    </div>
  );
}
