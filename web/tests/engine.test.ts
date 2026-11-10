import { describe, expect, it } from "vitest";

import {
  canCreate,
  formatBytes,
  FORMATS,
  isWorking,
  planLabel,
  STAGE_LABEL,
  usd,
  type Me,
} from "@/lib/engine";
import { googleSignInEnabled } from "@/lib/supabase";

describe("engine client helpers", () => {
  it("polls only while the autopilot is working", () => {
    expect(isWorking("writing")).toBe(true);
    expect(isWorking("rendering")).toBe(true);
    for (const stage of [
      "story_review",
      "script_review",
      "cast_review",
      "ready",
      "done",
      "failed",
    ] as const)
      expect(isWorking(stage)).toBe(false);
    expect(isWorking(null)).toBe(false);
  });

  it("offers exactly the formats the engine accepts", () => {
    expect(FORMATS.map((f) => f.id).sort()).toEqual([
      "feature_film",
      "microdrama",
      "short_film",
      "web_series",
      "youtube",
    ]);
  });

  it("labels every stage and formats money", () => {
    expect(Object.keys(STAGE_LABEL)).toHaveLength(12);
    expect(usd(3.9)).toBe("$3.90");
  });
});

describe("plan, storage and billing helpers", () => {
  const me = (plan: Partial<Me["plan"]>, enforced = true) =>
    ({
      credits_enforced: enforced,
      plan: { name: "Basic", status: null, active: false, renews_at: null, ends_at: null, ...plan },
    }) as Me;

  it("gates creating on an active plan only when credits are enforced", () => {
    expect(canCreate(undefined)).toBe(true);
    expect(canCreate(me({}, false))).toBe(true);
    expect(canCreate(me({}))).toBe(false);
    expect(canCreate(me({ status: "active", active: true }))).toBe(true);
  });

  it("formats storage sizes", () => {
    expect(formatBytes(50 * 1024 ** 3)).toBe("50 GB");
    expect(formatBytes(1.24 * 1024 ** 3)).toBe("1.2 GB");
    expect(formatBytes(52 * 1024 ** 2)).toBe("52 MB");
    expect(formatBytes(0)).toBe("0 KB");
  });

  it("describes the plan status", () => {
    expect(planLabel(me({}).plan)).toBe("Not subscribed");
    expect(planLabel(me({ status: "past_due", active: true }).plan)).toMatch(/update your card/);
    expect(
      planLabel(me({ status: "cancelled", active: true, ends_at: "2026-10-26T00:00:00Z" }).plan),
    ).toMatch(/^Cancelled · ends /);
    expect(planLabel(me({ status: "expired" }).plan)).toBe("Ended");
  });
});

describe("sign-in providers", () => {
  const site = { url: "https://proj.supabase.co", anonKey: "anon" };
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("shows Google sign-in only when it is switched on in Supabase", async () => {
    expect(await googleSignInEnabled(answer(200, { external: { google: true } }), site)).toBe(true);
    expect(await googleSignInEnabled(answer(200, { external: { google: false } }), site)).toBe(
      false,
    );
    expect(await googleSignInEnabled(answer(401, {}), site)).toBe(false);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await googleSignInEnabled(down, site)).toBe(false);
    expect(
      await googleSignInEnabled(answer(200, { external: { google: true } }), {
        url: "",
        anonKey: "",
      }),
    ).toBe(false); // local development: no Supabase
  });
});
