import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Download, Loader2, Play, RotateCcw, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  engine,
  isWorking,
  STAGE_LABEL,
  usd,
  type Cut,
  type ProjectDetail,
  type Shot,
  type Stage,
} from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/p/$projectId")({
  head: () => ({ meta: [{ title: "Your video — Backlot" }] }),
  component: ProjectPage,
});

const STEPS: { label: string; stages: Stage[] }[] = [
  { label: "Script", stages: ["writing"] },
  { label: "Cast & sets", stages: ["breakdown", "casting"] },
  { label: "Shot plan", stages: ["planning"] },
  { label: "Your approval", stages: ["ready"] },
  { label: "Filming", stages: ["rendering"] },
  { label: "Editing", stages: ["assembling"] },
  { label: "Finished", stages: ["done"] },
];
const PAST_CASTING: Stage[] = ["planning", "ready", "rendering", "assembling", "done"];

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data, error, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => engine.project(projectId),
    refetchInterval: (q) => (isWorking(q.state.data?.project.stage) ? 4000 : false),
  });

  if (isLoading)
    return (
      <StudioShell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </StudioShell>
    );
  if (error || !data)
    return (
      <StudioShell>
        <p className="text-sm text-destructive">{error?.message ?? "Not found."}</p>
      </StudioShell>
    );

  const { project } = data;
  const stage = project.stage;
  const progress = data.jobs.find(
    (j) => j.kind === "project.autopilot" && j.status !== "failed",
  )?.progress;

  return (
    <StudioShell>
      <div className="mb-2">
        <Link to="/dashboard" className="meta-label hover:text-primary">
          ← My videos
        </Link>
      </div>
      <h1 className="text-3xl font-bold">{project.title}</h1>
      {project.story_bible?.logline ? (
        <p className="mt-2 max-w-3xl text-muted-foreground">{project.story_bible.logline}</p>
      ) : null}

      {stage ? <Timeline stage={stage} /> : null}

      {isWorking(stage) ? (
        <div className="mt-6 flex items-center gap-3 text-sm">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>{progress || STAGE_LABEL[stage!]}…</span>
          <span className="text-muted-foreground">You can close this page; we'll keep going.</span>
        </div>
      ) : null}

      {project.stage_error && stage !== "failed" ? (
        <Notice tone="warn">{project.stage_error}</Notice>
      ) : null}

      {stage === "failed" ? <Failed data={data} /> : null}
      {stage === "ready" ? <Checkpoint data={data} /> : null}
      {stage === "done" ? <Finished data={data} /> : null}
      {stage && ["rendering", "assembling", "done"].includes(stage) ? (
        <ShotBoard data={data} />
      ) : null}
      {stage && PAST_CASTING.includes(stage) ? <CastAndSets projectId={project.id} /> : null}
      {stage && PAST_CASTING.includes(stage) ? (
        <Scripts data={data} open={stage === "ready"} />
      ) : null}
    </StudioShell>
  );
}

function Timeline({ stage }: { stage: Stage }) {
  const current = STEPS.findIndex((s) => s.stages.includes(stage));
  return (
    <ol className="mt-8 grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-center">
      {STEPS.map((s, i) => {
        const done = stage === "done" || i < current;
        const active = i === current && stage !== "done";
        return (
          <li key={s.label} className={cn("bg-card px-1 py-3", active && "bg-primary/10")}>
            <div
              className={cn(
                "mx-auto mb-1 flex size-5 items-center justify-center rounded-full border text-[10px]",
                done
                  ? "border-primary bg-primary text-primary-foreground"
                  : active
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </div>
            <div
              className={cn(
                "text-[10px] leading-tight sm:text-xs",
                active ? "font-semibold" : "text-muted-foreground",
              )}
            >
              {s.label}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Notice({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mt-6 flex gap-3 rounded-lg border p-4 text-sm",
        tone === "error" ? "border-destructive/50 text-destructive" : "border-primary/40",
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Checkpoint({ data }: { data: ProjectDetail }) {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const price = data.render_price_usd;
  const seconds = data.episodes.reduce((t, e) => t + e.seconds, 0);
  const short = !!me?.credits_enforced && (!me.plan.active || me.balance_usd < price);
  const produce = useMutation({
    mutationFn: () => engine.produce(data.project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", data.project.id] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <section className="mt-8 grid gap-6 rounded-xl border border-primary/50 bg-card p-6 shadow-[var(--shadow-glow)] sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <h2 className="text-xl font-bold">Your film is ready to shoot</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.episodes.length > 1 ? `${data.episodes.length} episodes, ` : ""}
          {data.episodes.reduce((t, e) => t + e.shots, 0)} shots, about {Math.round(seconds)}{" "}
          seconds. Read the script and check the cast below. Nothing is filmed until you say so.
        </p>
      </div>
      <div className="text-right">
        <div className="text-3xl font-bold">{usd(price)}</div>
        {me?.credits_enforced ? (
          <div className="text-xs text-muted-foreground">Balance {usd(me.balance_usd)}</div>
        ) : null}
        {short ? (
          <Button asChild className="mt-3">
            <Link to="/billing">{me?.plan.active ? "Add credits" : "Subscribe"}</Link>
          </Button>
        ) : (
          <Button className="mt-3" onClick={() => produce.mutate()} disabled={produce.isPending}>
            {produce.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Make my video
          </Button>
        )}
      </div>
    </section>
  );
}

function Failed({ data }: { data: ProjectDetail }) {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => engine.resume(data.project.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project", data.project.id] }),
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <Notice tone="error">
      <p>{data.project.stage_error || "Something went wrong."}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={() => resume.mutate()}
        disabled={resume.isPending}
      >
        <RotateCcw className="size-4" /> Try again
      </Button>
    </Notice>
  );
}

function Finished({ data }: { data: ProjectDetail }) {
  const vertical = data.project.aspect === "9:16";
  const byEpisode = new Map(data.latest_cuts.map((c) => [c.episode_id, c]));
  return (
    <section className="mt-8 space-y-10">
      {data.episodes.map((e) => {
        const cut = byEpisode.get(e.id);
        return (
          <div
            key={e.id}
            className={cn("grid gap-6", vertical ? "md:grid-cols-[minmax(0,360px)_1fr]" : "")}
          >
            <CutPlayer cut={cut} vertical={vertical} />
            <div>
              <div className="meta-label">{e.label}</div>
              <h2 className="text-xl font-bold">{e.title || data.project.title}</h2>
              {cut?.duration ? (
                <p className="text-sm text-muted-foreground">{Math.round(cut.duration)} seconds</p>
              ) : null}
              {cut?.kind === "preview" ? (
                <p className="mt-2 text-sm text-primary">
                  Some shots couldn't be filmed and show a placeholder. Use “Fix this shot” below.
                </p>
              ) : null}
              {cut?.url ? (
                <div className="mt-4 flex gap-2">
                  <Button asChild size="sm">
                    <a href={cut.url} target="_blank" rel="noreferrer">
                      <Download className="size-4" /> MP4
                    </a>
                  </Button>
                  {cut.srt_url ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={cut.srt_url} target="_blank" rel="noreferrer">
                        Subtitles (SRT)
                      </a>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function CutPlayer({ cut, vertical }: { cut: Cut | undefined; vertical: boolean }) {
  const box = cn(
    "w-full overflow-hidden rounded-xl border border-border bg-black",
    vertical ? "aspect-[9/16]" : "aspect-video",
  );
  if (!cut?.url)
    return (
      <div className={cn(box, "flex items-center justify-center text-sm text-muted-foreground")}>
        {cut?.status === "failed" ? cut.error : "Editing…"}
      </div>
    );
  return (
    <video
      className={box}
      src={cut.url}
      poster={cut.thumb_url ?? undefined}
      controls
      playsInline
      preload="metadata"
    />
  );
}

function ShotBoard({ data }: { data: ProjectDetail }) {
  const working = isWorking(data.project.stage);
  const [fixing, setFixing] = useState<Shot | null>(null);
  return (
    <section className="mt-12">
      <h2 className="meta-label mb-4">Shots</h2>
      {data.episodes.map((e) => (
        <EpisodeShots
          key={e.id}
          episodeId={e.id}
          label={data.episodes.length > 1 ? e.label : ""}
          aspect={data.project.aspect}
          poll={working}
          canFix={data.project.stage === "done"}
          onFix={setFixing}
        />
      ))}
      <FixDialog
        shot={fixing}
        projectId={data.project.id}
        resolution={data.project.resolution}
        onClose={() => setFixing(null)}
      />
    </section>
  );
}

function EpisodeShots({
  episodeId,
  label,
  aspect,
  poll,
  canFix,
  onFix,
}: {
  episodeId: string;
  label: string;
  aspect: string;
  poll: boolean;
  canFix: boolean;
  onFix: (s: Shot) => void;
}) {
  const { data: shots } = useQuery({
    queryKey: ["shots", episodeId],
    queryFn: () => engine.shots(episodeId),
    refetchInterval: poll ? 5000 : false,
  });
  return (
    <div className="mb-6">
      {label ? <div className="mb-2 text-sm font-semibold">{label}</div> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {shots?.map((s) => {
          const take =
            s.takes.find((t) => t.id === s.approved_take_id) ??
            [...s.takes].reverse().find((t) => t.status === "succeeded");
          const lines = s.plan.beats.flatMap((b) => b.dialogue ?? []);
          return (
            <div key={s.id} className="overflow-hidden rounded-lg border border-border bg-card">
              <div
                className={cn(
                  "relative flex items-center justify-center bg-surface",
                  aspect === "9:16" ? "aspect-[9/16]" : "aspect-video",
                )}
              >
                {take?.thumb_url ? (
                  <img
                    src={take.thumb_url}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                  />
                ) : null}
                {s.status === "queued" || s.status === "rendering" ? (
                  <Loader2 className="absolute size-5 animate-spin text-primary" />
                ) : null}
                {s.status === "failed" || s.status === "blocked" ? (
                  <AlertTriangle className="absolute size-5 text-destructive" />
                ) : null}
              </div>
              <div className="space-y-1 p-2">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {s.code} · {s.duration}s
                </div>
                <div className="line-clamp-2 text-xs">
                  {lines[0] ? `“${lines[0].line}”` : s.plan.beats[0]?.action}
                </div>
                {canFix ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-full text-xs"
                    onClick={() => onFix(s)}
                  >
                    <Wand2 className="size-3" /> Fix this shot
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FixDialog({
  shot,
  projectId,
  resolution,
  onClose,
}: {
  shot: Shot | null;
  projectId: string;
  resolution: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me, enabled: !!shot });
  const fix = useMutation({
    mutationFn: () => engine.fixShot(shot!.id, note.trim()),
    onSuccess: () => {
      toast.success("Re-shooting. The episode will be re-edited automatically.");
      setNote("");
      onClose();
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const price =
    shot && me
      ? (me.prices.per_second[resolution] ?? me.prices.per_second["768P"] ?? 0) * shot.duration
      : null;
  return (
    <Dialog open={!!shot} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix shot {shot?.code}</DialogTitle>
          <DialogDescription>
            Say what should change, like a director would. The dialogue stays the same.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="She should hesitate before opening the door."
        />
        <DialogFooter>
          {me?.credits_enforced && price !== null ? (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              Costs {usd(price)}
            </span>
          ) : null}
          <Button onClick={() => fix.mutate()} disabled={note.trim().length < 3 || fix.isPending}>
            {fix.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            Re-shoot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CastAndSets({ projectId }: { projectId: string }) {
  const { data: assets } = useQuery({
    queryKey: ["assets", projectId],
    queryFn: () => engine.assets(projectId),
  });
  const shown =
    assets?.filter(
      (a) => !a.meta?.unused && a.url && ["character", "location", "prop"].includes(a.kind),
    ) ?? [];
  if (!shown.length) return null;
  return (
    <section className="mt-12">
      <h2 className="meta-label mb-4">Cast & sets</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {shown.map((a) => (
          <figure key={a.id} className="overflow-hidden rounded-lg border border-border bg-card">
            <img
              src={a.url!}
              alt={a.name}
              className="aspect-[3/4] w-full object-cover"
              loading="lazy"
            />
            <figcaption className="p-2">
              <div className="text-xs font-semibold">{a.name}</div>
              <div className="font-mono text-[10px] uppercase text-muted-foreground">
                {a.kind === "location" ? "set" : a.kind}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function Scripts({ data, open }: { data: ProjectDetail; open: boolean }) {
  return (
    <section className="mt-12">
      <h2 className="meta-label mb-4">Script</h2>
      {data.episodes.map((e, i) => (
        <details
          key={e.id}
          open={open && i === 0}
          className="mb-3 overflow-hidden rounded-lg border border-border bg-card"
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
            {e.label}
            {e.title ? ` · ${e.title}` : ""}
          </summary>
          <EpisodeScript id={e.id} />
        </details>
      ))}
    </section>
  );
}

function EpisodeScript({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["episode", id], queryFn: () => engine.episode(id) });
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs leading-relaxed">
      {data?.script ?? "Loading…"}
    </pre>
  );
}
