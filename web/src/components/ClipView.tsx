import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Download, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CLIP_MODES, engine, usd, type ProjectDetail } from "@/lib/engine";
import { cn } from "@/lib/utils";

const BUSY = ["pending", "submitted", "running"];

const INPUT_NAMES: Record<string, string> = {
  first_frame: "Start frame",
  reference_image: "Picture",
  reference_video: "Video",
  reference_audio: "Voice",
};

/** A quick clip: the newest good version, every version made, what it was made from, and another try. */
export function ClipView({ data }: { data: ProjectDetail }) {
  const clip = data.clip!;
  const { project } = data;
  const best = clip.takes.find((t) => t.status === "succeeded");
  const busy = clip.takes.some((t) => BUSY.includes(t.status));
  const ratio =
    project.aspect === "9:16"
      ? "aspect-[9/16]"
      : project.aspect === "1:1"
        ? "aspect-square"
        : "aspect-video";
  const mode = CLIP_MODES.find((m) => m.id === clip.mode);
  const pictures = clip.inputs.filter((i) => i.role !== "reference_audio");
  const voices = clip.inputs.filter((i) => i.role === "reference_audio");

  return (
    <>
      <h1 className="text-3xl font-bold">{project.title}</h1>
      <p className="meta-label mt-2">
        {mode?.label ?? "Clip"} · {clip.seconds} seconds · {project.aspect}
      </p>

      {busy ? (
        <div className="mt-6 flex items-center gap-3 text-sm">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>Filming your clip…</span>
          <span className="text-muted-foreground">
            It takes a few minutes. You can close this page.
          </span>
        </div>
      ) : null}
      {project.stage_error && !busy ? (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{project.stage_error}</span>
        </div>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div
            className={cn(
              "mx-auto overflow-hidden rounded-lg border border-border bg-cinema",
              ratio,
              project.aspect === "9:16" ? "max-h-[75vh]" : "w-full",
            )}
          >
            {best?.url ? (
              <video
                key={best.id}
                src={best.url}
                poster={best.thumb_url ?? undefined}
                controls
                playsInline
                className="size-full bg-cinema object-contain"
              />
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {busy ? "Your clip will play here." : "No version worked yet. Try again below."}
              </div>
            )}
          </div>
          {best?.url ? (
            <div className="mt-3 flex justify-center">
              <Button asChild variant="outline" size="sm">
                <a href={best.url} download target="_blank" rel="noopener">
                  <Download /> Download
                </a>
              </Button>
            </div>
          ) : null}
        </div>

        <aside className="space-y-8">
          <AnotherVersion data={data} busy={busy} />
          <section>
            <h2 className="meta-label mb-3">Made from</h2>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{clip.prompt}</p>
            {pictures.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {pictures.map((i, n) => (
                  <figure key={n} className="w-24">
                    {i.role === "reference_video" ? (
                      <video
                        src={i.url ?? undefined}
                        muted
                        playsInline
                        controls
                        className="aspect-square w-24 rounded-md bg-cinema object-cover"
                      />
                    ) : (
                      <img
                        src={i.url ?? undefined}
                        alt=""
                        className="aspect-square w-24 rounded-md object-cover"
                      />
                    )}
                    <figcaption className="mt-1 truncate text-[11px] text-muted-foreground">
                      {i.label || INPUT_NAMES[i.role]}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
            {voices.map((i, n) => (
              <figure key={n} className="mt-3">
                <figcaption className="mb-1 text-[11px] text-muted-foreground">
                  {INPUT_NAMES["reference_audio"]}
                  {i.label ? `: ${i.label}` : ""}
                </figcaption>
                <audio src={i.url ?? undefined} controls className="h-9 w-full" />
              </figure>
            ))}
          </section>
        </aside>
      </div>

      {clip.takes.length > 1 || clip.takes.some((t) => t.status === "failed") ? (
        <section className="mt-12">
          <h2 className="meta-label mb-4">Versions</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {clip.takes.map((t) => (
              <div key={t.id} className="overflow-hidden rounded-lg border border-border bg-card">
                <div
                  className={cn("bg-cinema", ratio === "aspect-[9/16]" ? "aspect-[9/16]" : ratio)}
                >
                  {t.url ? (
                    <video
                      src={t.url}
                      poster={t.thumb_url ?? undefined}
                      controls
                      playsInline
                      className="size-full object-contain"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
                      {BUSY.includes(t.status) ? "Filming…" : (t.error ?? "Didn’t work")}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 p-2 text-xs text-muted-foreground">
                  <span>
                    Version {t.n}
                    {t.status === "failed" ? " · not charged" : ""}
                  </span>
                  <span>{formatDistanceToNow(new Date(t.created_at), { addSuffix: true })}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function AnotherVersion({ data, busy }: { data: ProjectDetail; busy: boolean }) {
  const clip = data.clip!;
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const [prompt, setPrompt] = useState(clip.prompt);
  const [seconds, setSeconds] = useState(clip.seconds);
  const min = me?.clips.min_seconds ?? 5;
  const max = me?.clips.max_seconds ?? 15;
  const price = (me?.prices.per_second["768P"] ?? 0) * seconds;
  const again = useMutation({
    mutationFn: () =>
      engine.retakeClip(data.project.id, {
        ...(prompt.trim() !== clip.prompt ? { prompt: prompt.trim() } : {}),
        seconds,
      }),
    onSuccess: () => {
      toast.success("Making another version.");
      void qc.invalidateQueries({ queryKey: ["project", data.project.id] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <section>
      <h2 className="meta-label mb-3">Another version</h2>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        maxLength={2000}
        aria-label="Description for the next version"
        className="resize-none text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={seconds}
          onChange={(e) => setSeconds(Number(e.target.value))}
          aria-label="Length"
          className="rounded-md border border-border-strong bg-transparent px-2 py-1 text-xs"
        >
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((s) => (
            <option key={s} value={s} className="bg-cinema">
              {s} seconds
            </option>
          ))}
        </select>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || again.isPending || prompt.trim().length < 3}
          onClick={() => again.mutate()}
        >
          {again.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Make it{me?.credits_enforced ? ` · ${usd(price)}` : ""}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Each version is a new take: same prompt, different result. A version that fails isn’t
        charged.
      </p>
    </section>
  );
}
