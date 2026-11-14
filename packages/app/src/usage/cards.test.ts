import { describe, expect, it } from "vitest";
import {
  arrangeUsageCards,
  arrangeUsageReports,
  DEFAULT_USAGE_PREFERENCES,
  setUsageCardOn,
  UsagePreferencesSchema,
  usageReportsOn,
  type UsagePreferences,
} from "./preferences";
import { resolvePinnedUsage } from "./pinned";
import type { UsageReportEntry } from "./types";

function report(sourceId: string, sourceLabel: string, account?: string): UsageReportEntry {
  return {
    id: `${sourceId}:${account ?? "default"}`,
    sourceId,
    sourceLabel,
    account: account ? { label: account } : {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    report: {
      status: "available",
      windows: [{ id: "weekly", label: "Weekly", summary: true, usedPct: 40 }],
    },
  };
}

const codex = report("codex", "Codex");
const claudeWork = report("claude", "Claude", "work");
const claudePersonal = report("claude", "Claude", "personal");
const copilot = report("copilot", "Copilot");
const gemini = report("gemini", "Gemini");

function ids(reports: readonly UsageReportEntry[]): string[] {
  return reports.map((entry) => entry.id);
}

function arranged(cardOrder: string[]): UsagePreferences {
  return { ...DEFAULT_USAGE_PREFERENCES, cardOrder };
}

describe("usage card order", () => {
  it("shows cards by provider, then account, whatever order they arrive in", () => {
    const expected = ["claude:personal", "claude:work", "codex:default", "copilot:default"];
    for (const arrival of [
      [codex, claudeWork, copilot, claudePersonal],
      [copilot, claudePersonal, codex, claudeWork],
    ]) {
      expect(ids(arrangeUsageReports(arrival, DEFAULT_USAGE_PREFERENCES))).toEqual(expected);
    }
  });

  it("puts the cards the user arranged first, in their order", () => {
    const preferences = arranged(["copilot:default", "claude:work"]);

    expect(
      ids(arrangeUsageReports([claudeWork, codex, claudePersonal, copilot], preferences)),
    ).toEqual(["copilot:default", "claude:work", "claude:personal", "codex:default"]);
  });

  it("lands a report from a new login in its default slot after the arranged cards", () => {
    const preferences = arrangeUsageCards(DEFAULT_USAGE_PREFERENCES, {
      moved: "codex:default",
      after: ["codex:default", "claude:work"],
    });
    const newLogin = report("claude", "Claude", "agent");

    expect(ids(arrangeUsageReports([newLogin, claudeWork, codex], preferences))).toEqual([
      "codex:default",
      "claude:work",
      "claude:agent",
    ]);
  });

  it("keeps another host's arrangement when a drop on this host moves a card both show", () => {
    // Host A shows Codex, Claude and Gemini; host B shows Copilot and the same Claude account.
    const hostA = [codex, claudeWork, gemini];
    const hostB = [claudeWork, copilot];
    const arrangedOnA = arrangeUsageCards(DEFAULT_USAGE_PREFERENCES, {
      moved: "codex:default",
      after: ["codex:default", "claude:work", "gemini:default"],
    });

    const after = ["copilot:default", "claude:work"];
    const arrangedOnB = arrangeUsageCards(arrangedOnA, { moved: "copilot:default", after });

    expect(ids(arrangeUsageReports(hostA, arrangedOnB))).toEqual([
      "codex:default",
      "claude:work",
      "gemini:default",
    ]);
    expect(ids(arrangeUsageReports(hostB, arrangedOnB))).toEqual(after);
  });

  it("moves only the dragged card when it swaps with its neighbour", () => {
    // Gemini sits between Codex and Copilot, but only another host shows it.
    const preferences = arranged(["codex:default", "gemini:default", "copilot:default"]);
    const swapped = arrangeUsageCards(preferences, {
      moved: "codex:default",
      after: ["copilot:default", "codex:default"],
    });

    expect(ids(arrangeUsageReports([codex, copilot], swapped))).toEqual([
      "copilot:default",
      "codex:default",
    ]);
    expect(ids(arrangeUsageReports([gemini, copilot], swapped))).toEqual([
      "gemini:default",
      "copilot:default",
    ]);
  });
});

describe("usage cards turned off", () => {
  it("turns a card off and back on", () => {
    const off = setUsageCardOn(DEFAULT_USAGE_PREFERENCES, "codex:default", false);
    expect(off.cardsOff).toEqual(["codex:default"]);
    expect(setUsageCardOn(off, "codex:default", true).cardsOff).toEqual([]);
  });

  it("leaves off cards out of the sidebar summary", () => {
    const preferences = setUsageCardOn(DEFAULT_USAGE_PREFERENCES, "codex:default", false);

    expect(ids(usageReportsOn([codex, claudeWork], preferences))).toEqual(["claude:work"]);
    expect(
      resolvePinnedUsage([codex, claudeWork], preferences).map((source) => source.key),
    ).toEqual(["claude:work"]);
  });

  it("orders the sidebar summary like the cards", () => {
    const preferences = arranged(["codex:default"]);

    expect(
      resolvePinnedUsage([claudeWork, codex], preferences).map((source) => source.key),
    ).toEqual(["codex:default", "claude:work"]);
  });
});

describe("stored card preferences", () => {
  it("reads settings saved before cards could be arranged as no arrangement", () => {
    expect(UsagePreferencesSchema.parse({ displayAs: "used", serverId: null })).toEqual(
      DEFAULT_USAGE_PREFERENCES,
    );
  });

  it("survives a save and reload, and ignores a malformed arrangement", () => {
    const saved = setUsageCardOn(arranged(["codex:default"]), "claude:work", false);
    expect(UsagePreferencesSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(
      UsagePreferencesSchema.parse({ displayAs: "used", cardOrder: "bad", cardsOff: [1] }),
    ).toEqual(DEFAULT_USAGE_PREFERENCES);
  });
});
