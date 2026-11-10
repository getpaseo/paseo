import { describe, expect, it } from "vitest";
import { resolveTailEllipsis, tailEllipsisCandidates } from "./resolve";

const candidates = tailEllipsisCandidates("Ten second stream");
const candidateWidths = [34, 80];

describe("tail ellipsis", () => {
  it("cuts at word boundaries, so no whitespace sits before the ellipsis", () => {
    expect(candidates).toEqual(["Ten…", "Ten second…"]);
    expect(tailEllipsisCandidates("  GPT-5.1   Codex  ")).toEqual(["GPT-5.1…"]);
    expect(tailEllipsisCandidates("claude-opus-4-5")).toEqual([]);
  });

  it("shows the full text while it fits", () => {
    expect(
      resolveTailEllipsis({
        candidates,
        measurements: { boxWidth: 132, fullWidth: 132.3, candidateWidths },
      }),
    ).toEqual({ kind: "full" });
  });

  it("keeps the most words that fit with the ellipsis", () => {
    expect(
      resolveTailEllipsis({
        candidates,
        measurements: { boxWidth: 98, fullWidth: 132, candidateWidths },
      }),
    ).toEqual({ kind: "truncated", text: "Ten second…" });
    expect(
      resolveTailEllipsis({
        candidates,
        measurements: { boxWidth: 60, fullWidth: 132, candidateWidths },
      }),
    ).toEqual({ kind: "truncated", text: "Ten…" });
  });

  it("lets the platform cut inside a first word too long for the box", () => {
    expect(
      resolveTailEllipsis({
        candidates,
        measurements: { boxWidth: 20, fullWidth: 132, candidateWidths },
      }),
    ).toEqual({ kind: "clipped" });
    expect(
      resolveTailEllipsis({
        candidates: [],
        measurements: { boxWidth: 60, fullWidth: 132, candidateWidths: [] },
      }),
    ).toEqual({ kind: "clipped" });
  });

  it("decides nothing until the widths it needs are measured", () => {
    expect(resolveTailEllipsis({ candidates, measurements: { candidateWidths } })).toEqual({
      kind: "measuring",
    });
    expect(
      resolveTailEllipsis({
        candidates,
        measurements: { boxWidth: 98, fullWidth: 132, candidateWidths: [34] },
      }),
    ).toEqual({ kind: "measuring" });
  });
});
