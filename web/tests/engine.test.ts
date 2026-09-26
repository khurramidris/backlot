import { describe, expect, it } from "vitest";

import { FORMATS, isWorking, STAGE_LABEL, usd } from "@/lib/engine";

describe("engine client helpers", () => {
  it("polls only while the autopilot is working", () => {
    expect(isWorking("writing")).toBe(true);
    expect(isWorking("rendering")).toBe(true);
    for (const stage of ["ready", "done", "failed"] as const) expect(isWorking(stage)).toBe(false);
    expect(isWorking(null)).toBe(false);
  });

  it("offers exactly the formats the engine accepts", () => {
    expect(FORMATS.map((f) => f.id).sort()).toEqual([
      "microdrama",
      "short_film",
      "web_series",
      "youtube",
    ]);
  });

  it("labels every stage and formats money", () => {
    expect(Object.keys(STAGE_LABEL)).toHaveLength(9);
    expect(usd(3.9)).toBe("$3.90");
  });
});
