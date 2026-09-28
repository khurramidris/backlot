// Client for the Backlot engine (same origin in production; the Vite dev server proxies /v1). The engine owns every paid call and all heavy work;
// the browser only sends the signed-in user's Supabase access token.
import { devUserId, supabase } from "@/lib/supabase";

const ENGINE_URL = (import.meta.env["VITE_ENGINE_URL"] ?? "").replace(/\/$/, "");

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = devUserId
    ? `dev:${devUserId}`
    : (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${ENGINE_URL}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? ""}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Engine errors are written for end users: show `message` as is.
    throw new EngineError(
      json.error?.message ?? `Engine error ${res.status}`,
      json.error?.code ?? "error",
      res.status,
    );
  }
  return json as T;
}

export type FormatId = "microdrama" | "short_film" | "web_series" | "youtube";

export const FORMATS: { id: FormatId; label: string; hint: string; aspect: string }[] = [
  { id: "microdrama", label: "Microdrama", hint: "Vertical, ~75 s episodes", aspect: "9:16" },
  { id: "short_film", label: "Short film", hint: "Widescreen, 1–5 min", aspect: "16:9" },
  { id: "web_series", label: "Web series", hint: "2–3 episodes", aspect: "16:9" },
  { id: "youtube", label: "YouTube story", hint: "Hook-first, 1–5 min", aspect: "16:9" },
];

export type Stage =
  | "writing"
  | "breakdown"
  | "casting"
  | "planning"
  | "ready"
  | "rendering"
  | "assembling"
  | "done"
  | "failed";

export type ProjectSummary = {
  id: string;
  title: string;
  aspect: string;
  mode: "vibe" | "studio";
  stage: Stage | null;
  stage_error: string | null;
  episodes: number;
  thumb_url: string | null;
  updated_at: string;
};

export type Cut = {
  id: string;
  episode_id: string;
  kind: "final" | "preview";
  status: "queued" | "running" | "done" | "failed";
  duration: number | null;
  error: string | null;
  url: string | null;
  srt_url: string | null;
  thumb_url: string | null;
};

export type ProjectDetail = {
  project: {
    id: string;
    title: string;
    aspect: string;
    resolution: string;
    mode: "vibe" | "studio";
    stage: Stage | null;
    stage_error: string | null;
    brief: { prompt?: string; format?: FormatId; episodes?: number; seconds?: number };
    story_bible: { logline?: string; world?: string };
  };
  episodes: {
    id: string;
    idx: number;
    label: string;
    title: string;
    shots: number;
    approved: number;
    seconds: number;
  }[];
  jobs: {
    id: number;
    kind: string;
    status: string;
    progress: string | null;
    error: string | null;
  }[];
  latest_cuts: Cut[];
  render_price_usd: number;
};

export type Asset = {
  id: string;
  kind: "character" | "look" | "voice" | "location" | "set_variant" | "prop";
  key: string;
  name: string;
  description: string;
  status: string;
  url: string | null;
  parent_id: string | null;
  meta: { unused?: boolean };
};

export type Take = {
  id: string;
  n: number;
  status: string;
  url: string | null;
  thumb_url: string | null;
  error: string | null;
};

export type Shot = {
  id: string;
  code: string;
  duration: number;
  status: string;
  approved_take_id: string | null;
  plan: {
    purpose?: string;
    beats: { action: string; dialogue?: { who: string; line: string }[] }[];
  };
  takes: Take[];
};

export type Plan = {
  name: string;
  status: string | null;
  active: boolean;
  renews_at: string | null;
  ends_at: string | null;
  price_usd: number;
  credits_usd: number;
  storage_gb: number;
};

export type SetupCheck = {
  area: string;
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export type Me = {
  user_id: string;
  email: string | null;
  is_admin: boolean;
  balance_usd: number;
  credits: { plan: number; topup: number; total: number };
  credits_enforced: boolean;
  plan: Plan;
  storage: { used_bytes: number; quota_bytes: number };
  prices: { per_second: Record<string, number>; setup_fee_usd: number };
  packs: { id: string; usd: number; available: boolean }[];
  payments_enabled: boolean;
};

export const engine = {
  me: () => call<Me>("GET", "/me"),
  subscribe: () => call<{ url: string }>("POST", "/billing/subscribe", {}),
  topup: (pack: string) => call<{ url: string }>("POST", "/billing/topup", { pack }),
  portal: () => call<{ url: string }>("GET", "/billing/portal"),
  preflight: () => call<{ checks: SetupCheck[] }>("GET", "/admin/preflight").then((r) => r.checks),
  projects: () => call<{ projects: ProjectSummary[] }>("GET", "/projects").then((r) => r.projects),
  project: (id: string) => call<ProjectDetail>("GET", `/projects/${id}`),
  create: (input: { prompt: string; format: FormatId; language?: string }) =>
    call<{ project: { id: string } }>("POST", "/create", input).then((r) => r.project),
  produce: (id: string) => call<{ price_usd: number }>("POST", `/projects/${id}/produce`, {}),
  resume: (id: string) => call<unknown>("POST", `/projects/${id}/resume`, {}),
  remove: (id: string) => call<unknown>("DELETE", `/projects/${id}`),
  assets: (id: string) =>
    call<{ assets: Asset[] }>("GET", `/projects/${id}/assets`).then((r) => r.assets),
  episode: (id: string) =>
    call<{ episode: { id: string; script: string; title: string } }>("GET", `/episodes/${id}`).then(
      (r) => r.episode,
    ),
  shots: (episodeId: string) =>
    call<{ shots: Shot[] }>("GET", `/episodes/${episodeId}/shots`).then((r) => r.shots),
  fixShot: (shotId: string, note: string) =>
    call<unknown>("POST", `/shots/${shotId}/retake`, { note, recut: true }),
};

export const STAGE_LABEL: Record<Stage, string> = {
  writing: "Writing",
  breakdown: "Casting",
  casting: "Casting",
  planning: "Planning shots",
  ready: "Ready for your approval",
  rendering: "Filming",
  assembling: "Editing",
  done: "Finished",
  failed: "Needs attention",
};

/** Stages the autopilot is actively working through (worth polling). */
export const isWorking = (stage: Stage | null | undefined) =>
  !!stage && !["ready", "done", "failed"].includes(stage);

export const usd = (v: number) => `$${v.toFixed(2)}`;

/** Whether this customer can start new work: always in local development, otherwise with an active plan. */
export const canCreate = (me: Me | undefined) => !me || !me.credits_enforced || me.plan.active;

/** 53687091200 → "50 GB", 1288490188 → "1.2 GB", 52428800 → "50 MB". */
export function formatBytes(bytes: number) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${+gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${+mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const formatDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

/** Plan status in words, for the billing and account pages. */
export function planLabel(plan: Plan) {
  if (!plan.status) return "Not subscribed";
  if (plan.status === "cancelled" && plan.active)
    return `Cancelled · ends ${formatDate(plan.ends_at)}`;
  if (plan.status === "past_due") return "Payment failed · update your card";
  if (plan.active)
    return plan.renews_at ? `Active · renews ${formatDate(plan.renews_at)}` : "Active";
  return plan.status === "paused" ? "Paused" : "Ended";
}
