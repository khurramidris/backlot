import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, ImagePlus, Loader2, Mic, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CLIP_MODES, engine, usd, type ClipMode, type Me } from "@/lib/engine";
import { cn } from "@/lib/utils";

const ASPECTS = [
  { id: "9:16", label: "Vertical" },
  { id: "16:9", label: "Wide" },
  { id: "1:1", label: "Square" },
];

const PLACEHOLDER: Record<ClipMode, string> = {
  text: "A paper boat drifts down a rain-soaked street at night, neon reflections in the puddles.",
  image: "The woman slowly turns to the camera and smiles as the wind lifts her hair.",
  reference:
    "Maya in image 1 holds up the sneaker in image 2 and says: “These changed my mornings.”",
  remix: "Replace the man in the video with the woman in image 1. Keep the motion and the camera.",
};

const MB = 1024 * 1024;
type Picked = { file: File; url: string; label: string };

/** One clip from text, a picture, references or a video to remix. */
export function ClipForm({ me }: { me: Me | undefined }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ClipMode>("text");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [aspect, setAspect] = useState("9:16");
  const [images, setImages] = useState<Picked[]>([]);
  const [video, setVideo] = useState<Picked | null>(null);
  const [voice, setVoice] = useState<Picked | null>(null);
  const [consent, setConsent] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLInputElement>(null);

  const min = me?.clips.min_seconds ?? 5;
  const max = me?.clips.max_seconds ?? 15;
  const maxImages = mode === "image" ? 1 : mode === "remix" ? 8 : 9;
  const hasFiles = images.length > 0 || !!video || !!voice;
  const price = (me?.prices.per_second["768P"] ?? 0) * seconds;

  // Free the previews' memory when they go away.
  const all = useMemo(
    () => [...images, video, voice].filter(Boolean) as Picked[],
    [images, video, voice],
  );
  const live = useRef(all);
  live.current = all;
  useEffect(() => () => live.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const pick = (file: File, limit: number, what: string): Picked | null => {
    if (file.size > limit * MB) {
      toast.error(`${what} is over ${limit} MB.`);
      return null;
    }
    return { file, url: URL.createObjectURL(file), label: "" };
  };

  const switchMode = (m: ClipMode) => {
    setMode(m);
    if (m === "text") {
      images.forEach((p) => URL.revokeObjectURL(p.url));
      setImages([]);
    }
    if (m !== "remix" && video) {
      URL.revokeObjectURL(video.url);
      setVideo(null);
    }
    if ((m === "text" || m === "image") && voice) {
      URL.revokeObjectURL(voice.url);
      setVoice(null);
    }
    const keep = m === "image" ? 1 : m === "remix" ? 8 : 9;
    if (images.length > keep) {
      images.slice(keep).forEach((p) => URL.revokeObjectURL(p.url));
      setImages(images.slice(0, keep));
    }
  };

  const missing =
    prompt.trim().length < 3
      ? "Describe the clip"
      : mode === "image" && images.length !== 1
        ? "Add a picture"
        : mode === "reference" && images.length === 0
          ? "Add at least one picture"
          : mode === "remix" && !video
            ? "Add a video"
            : hasFiles && !consent
              ? "Confirm you may use these files"
              : null;

  const create = useMutation({
    mutationFn: () => {
      const f = new FormData();
      f.append("mode", mode);
      f.append("prompt", prompt.trim());
      f.append("seconds", String(seconds));
      f.append("aspect", aspect);
      f.append("consent", String(consent));
      for (const p of images) {
        f.append("images", p.file, p.file.name);
        f.append("labels", p.label.trim());
      }
      if (video) f.append("video", video.file, video.file.name);
      if (voice) {
        f.append("audio", voice.file, voice.file.name);
        f.append("audio_label", voice.label.trim());
      }
      return engine.createClip(f);
    },
    onSuccess: (p) => void navigate({ to: "/p/$projectId", params: { projectId: p.id } }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <form
      className="mt-3 rounded-lg border border-border-strong bg-cinema/80 p-3 backdrop-blur-sm focus-within:border-primary/70"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) create.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind of clip">
        {CLIP_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            onClick={() => switchMode(m.id)}
            title={m.hint}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              mode === m.id
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border-strong text-muted-foreground hover:border-primary/60 hover:text-foreground",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={PLACEHOLDER[mode]}
        aria-label="Describe the clip"
        rows={3}
        maxLength={2000}
        className="mt-2 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      {mode !== "text" ? (
        <div className="mt-1 space-y-3 px-1">
          <div className="flex flex-wrap gap-3">
            {images.map((p, i) => (
              <div key={p.url} className="w-28">
                <div className="relative overflow-hidden rounded-md border border-border-strong">
                  <img src={p.url} alt="" className="aspect-square w-full object-cover" />
                  <span className="absolute left-1 top-1 rounded bg-cinema/80 px-1.5 text-[10px] font-semibold">
                    {mode === "image" ? "Start" : `Image ${i + 1}`}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove image ${i + 1}`}
                    onClick={() => {
                      URL.revokeObjectURL(p.url);
                      setImages(images.filter((x) => x !== p));
                    }}
                    className="absolute right-1 top-1 rounded bg-cinema/80 p-0.5 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {mode !== "image" ? (
                  <Input
                    value={p.label}
                    onChange={(e) =>
                      setImages(images.map((x) => (x === p ? { ...x, label: e.target.value } : x)))
                    }
                    placeholder="Who or what?"
                    aria-label={`What image ${i + 1} shows`}
                    maxLength={60}
                    className="mt-1 h-7 px-2 text-xs"
                  />
                ) : null}
              </div>
            ))}
            {images.length < maxImages ? (
              <button
                type="button"
                onClick={() => imageInput.current?.click()}
                className="flex aspect-square w-28 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-strong text-xs text-muted-foreground hover:border-primary/60 hover:text-foreground"
              >
                <ImagePlus className="size-5" />
                {mode === "image"
                  ? "Add the picture"
                  : mode === "remix"
                    ? "Add a picture (optional)"
                    : "Add a picture"}
              </button>
            ) : null}
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple={mode !== "image"}
              hidden
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])]
                  .slice(0, maxImages - images.length)
                  .map((f) => pick(f, 20, f.name))
                  .filter(Boolean) as Picked[];
                setImages([...images, ...picked]);
                e.target.value = "";
              }}
            />
          </div>

          {mode === "remix" ? (
            <div className="flex flex-wrap items-center gap-3">
              {video ? (
                <div className="relative w-40 overflow-hidden rounded-md border border-border-strong">
                  <video
                    src={video.url}
                    muted
                    playsInline
                    className="aspect-video w-full object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded bg-cinema/80 px-1.5 text-[10px] font-semibold">
                    Video 1
                  </span>
                  <button
                    type="button"
                    aria-label="Remove the video"
                    onClick={() => {
                      URL.revokeObjectURL(video.url);
                      setVideo(null);
                    }}
                    className="absolute right-1 top-1 rounded bg-cinema/80 p-0.5 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => videoInput.current?.click()}
                >
                  <Video /> Add the video to remix
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                MP4 or MOV; the first 15 seconds are used.
              </span>
              <input
                ref={videoInput}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setVideo(pick(f, 100, "The video"));
                  e.target.value = "";
                }}
              />
            </div>
          ) : null}

          {mode === "reference" || mode === "remix" ? (
            <div className="flex flex-wrap items-center gap-3">
              {voice ? (
                <div className="flex items-center gap-2 rounded-md border border-border-strong px-2 py-1">
                  <Mic className="size-4 text-primary" />
                  <span className="max-w-40 truncate text-xs">{voice.file.name}</span>
                  <Input
                    value={voice.label}
                    onChange={(e) => setVoice({ ...voice, label: e.target.value })}
                    placeholder="Whose voice?"
                    aria-label="Whose voice this is"
                    maxLength={60}
                    className="h-7 w-32 px-2 text-xs"
                  />
                  <button
                    type="button"
                    aria-label="Remove the voice"
                    onClick={() => {
                      URL.revokeObjectURL(voice.url);
                      setVoice(null);
                    }}
                    className="hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => voiceInput.current?.click()}
                >
                  <Mic /> Add a voice (optional)
                </Button>
              )}
              <input
                ref={voiceInput}
                type="file"
                accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setVoice(pick(f, 25, "The voice clip"));
                  e.target.value = "";
                }}
              />
            </div>
          ) : null}

          {mode === "reference" || mode === "remix" ? (
            <p className="text-xs text-muted-foreground">
              Refer to your files in the description as image 1, image 2
              {mode === "remix" ? ", the video" : ""}
              {voice ? " and the voice" : ""}.
            </p>
          ) : null}

          {hasFiles ? (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span>
                I have the right to use these files, and permission from anyone shown or heard in
                them.
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Length
          <select
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            className="rounded-md border border-border-strong bg-transparent px-2 py-1 text-xs text-foreground"
          >
            {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((s) => (
              <option key={s} value={s} className="bg-cinema">
                {s} seconds
              </option>
            ))}
          </select>
        </label>
        {ASPECTS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAspect(a.id)}
            aria-pressed={aspect === a.id}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              aspect === a.id
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border-strong text-muted-foreground hover:border-primary/60 hover:text-foreground",
            )}
          >
            {a.label} {a.id}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {me?.credits_enforced ? usd(price) : null}
        </span>
        <Button type="submit" disabled={!!missing || create.isPending} title={missing ?? undefined}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          {create.isPending ? (hasFiles ? "Uploading…" : "Starting…") : "Make the clip"}
        </Button>
      </div>
    </form>
  );
}
