import { describe, expect, it } from "vitest";
import { buildAgentPlanUsage } from "./agent-plan-usage";
import type { ProviderUsage } from "./types";

const providerEntry: ProviderUsage = {
  providerId: "claude-work",
  displayName: "Claude (Work)",
  status: "unavailable",
  planLabel: "Max 20x",
  windows: [],
  balances: [],
  details: [],
  error: null,
};

describe("buildAgentPlanUsage", () => {
  it("builds an available entry from the agent's windows, borrowing name and plan from the provider entry", () => {
    const usage = buildAgentPlanUsage({
      providerId: "claude-work",
      providerUsage: providerEntry,
      planWindows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 12,
          resetsAt: "2026-08-31T02:30:00.000Z",
          tone: "ok",
        },
        { id: "seven_day_overage_included", label: "Weekly · Fable", usedPct: 93, tone: "danger" },
      ],
      observedAt: "2026-08-31T01:00:00.000Z",
    });

    expect(usage).toEqual({
      providerId: "claude-work",
      displayName: "Claude (Work)",
      status: "available",
      planLabel: "Max 20x",
      sourceLabel: "Live from this agent",
      fetchedAt: "2026-08-31T01:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 12,
          remainingPct: 88,
          resetsAt: "2026-08-31T02:30:00.000Z",
          tone: "ok",
        },
        {
          id: "seven_day_overage_included",
          label: "Weekly · Fable",
          usedPct: 93,
          remainingPct: 7,
          resetsAt: null,
          tone: "danger",
        },
      ],
      balances: [],
      details: [],
      error: null,
    });
  });

  it("falls back to the provider id as the name when no provider entry exists", () => {
    const usage = buildAgentPlanUsage({
      providerId: "claude-pinned",
      providerUsage: null,
      planWindows: [{ id: "five_hour", label: "Session", usedPct: 130 }],
      observedAt: null,
    });

    expect(usage).toMatchObject({ displayName: "claude-pinned", planLabel: null, fetchedAt: null });
    expect(usage?.windows[0]).toMatchObject({ usedPct: 130, remainingPct: 0 });
  });

  it("returns null without windows or a provider id", () => {
    expect(
      buildAgentPlanUsage({
        providerId: "claude",
        providerUsage: null,
        planWindows: [],
        observedAt: null,
      }),
    ).toBeNull();
    expect(
      buildAgentPlanUsage({
        providerId: null,
        providerUsage: null,
        planWindows: [{ id: "five_hour", label: "Session", usedPct: 1 }],
        observedAt: null,
      }),
    ).toBeNull();
  });
});
