import { describe, expect, it } from "vitest";
import { earliestReset, limitedProviders } from "./usage-limits.js";

const now = Date.parse("2026-10-01T10:00:00Z");
const provider = (
  providerId: string,
  windows: Array<{ usedPct: number; resetsAt: string | null }>,
) => ({
  providerId,
  displayName: providerId,
  status: "available" as const,
  planLabel: null,
  windows: windows.map((w, i) => ({ id: `w${i}`, label: `w${i}`, ...w })),
});

describe("limitedProviders", () => {
  it("marks a provider limited until its last exhausted window resets", () => {
    const limited = limitedProviders(
      [
        provider("codex-plus", [
          { usedPct: 100, resetsAt: "2026-10-01T12:00:00Z" },
          { usedPct: 100, resetsAt: "2026-10-03T00:00:00Z" },
        ]),
        provider("codex-business", [{ usedPct: 40, resetsAt: "2026-10-01T11:00:00Z" }]),
        provider("claude-work", [{ usedPct: 100, resetsAt: "2026-10-01T09:00:00Z" }]),
      ],
      now,
    );
    expect([...limited.keys()]).toEqual(["codex-plus"]);
    expect(limited.get("codex-plus")?.resetsAt).toBe("2026-10-03T00:00:00.000Z");
    expect(earliestReset(["codex-plus", "codex-business"], limited)).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });
});
