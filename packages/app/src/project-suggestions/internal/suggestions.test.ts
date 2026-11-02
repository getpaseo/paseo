import { describe, expect, it } from "vitest";
import {
  addSuggestedProjects,
  isStillReading,
  isSuggestionChecked,
  mergeProviderSuggestions,
  type ProjectSuggestion,
  type ProviderSuggestions,
} from "./suggestions";

const NOW = new Date("2026-10-31T12:00:00.000Z");

function suggestion(
  rootPath: string,
  overrides: Partial<ProjectSuggestion> = {},
): ProjectSuggestion {
  return {
    rootPath,
    displayName: rootPath.split("/").at(-1) ?? rootPath,
    sessionCount: 1,
    providerIds: ["claude"],
    lastActivityAt: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("mergeProviderSuggestions", () => {
  it("shows one row per folder across providers that answered, newest first", () => {
    const rows = mergeProviderSuggestions(
      [
        {
          provider: "claude",
          status: "answered",
          suggestions: [
            suggestion("/dev/app", { sessionCount: 2, lastActivityAt: "2026-10-29T00:00:00.000Z" }),
            suggestion("/dev/docs", { lastActivityAt: "2026-10-20T00:00:00.000Z" }),
          ],
        },
        {
          provider: "codex",
          status: "answered",
          suggestions: [
            suggestion("/dev/app", {
              sessionCount: 3,
              providerIds: ["codex"],
              lastActivityAt: "2026-10-30T00:00:00.000Z",
            }),
          ],
        },
        { provider: "opencode", status: "loading" },
      ],
      new Set(),
    );

    expect(rows).toEqual([
      suggestion("/dev/app", {
        sessionCount: 5,
        providerIds: ["claude", "codex"],
        lastActivityAt: "2026-10-30T00:00:00.000Z",
      }),
      suggestion("/dev/docs", { lastActivityAt: "2026-10-20T00:00:00.000Z" }),
    ]);
  });

  it("drops folders that are already projects", () => {
    const rows = mergeProviderSuggestions(
      [
        {
          provider: "claude",
          status: "answered",
          suggestions: [suggestion("/dev/app"), suggestion("/dev/docs")],
        },
      ],
      new Set(["/dev/app"]),
    );

    expect(rows.map((row) => row.rootPath)).toEqual(["/dev/docs"]);
  });
});

describe("isSuggestionChecked", () => {
  const busyRecent = suggestion("/dev/app", { sessionCount: 3 });
  const quiet = suggestion("/dev/docs", { sessionCount: 2 });
  const busyOld = suggestion("/dev/legacy", {
    sessionCount: 9,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
  });

  it("starts checked for folders used at least three times in the last 30 days", () => {
    expect([busyRecent, quiet, busyOld].map((row) => isSuggestionChecked(row, {}, NOW))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("keeps the user's choice once they toggle a row", () => {
    const choices = { "/dev/app": false, "/dev/docs": true };
    expect(isSuggestionChecked(busyRecent, choices, NOW)).toBe(false);
    expect(isSuggestionChecked(quiet, choices, NOW)).toBe(true);
  });
});

describe("addSuggestedProjects", () => {
  it("adds every folder and reports the ones the host refused", async () => {
    const added: string[] = [];
    const failures = await addSuggestedProjects(
      ["/dev/app", "/dev/gone", "/dev/docs"],
      async (path) => {
        if (path === "/dev/gone") return { ok: false, error: "Directory not found" };
        added.push(path);
        return { ok: true };
      },
    );

    expect(added).toEqual(["/dev/app", "/dev/docs"]);
    expect(failures).toEqual(new Map([["/dev/gone", "Directory not found"]]));
  });

  it("keeps going when adding one folder throws", async () => {
    const failures = await addSuggestedProjects(["/dev/app", "/dev/docs"], async (path) => {
      if (path === "/dev/app") throw new Error("Host disconnected");
      return { ok: true };
    });

    expect(failures).toEqual(new Map([["/dev/app", "Host disconnected"]]));
  });
});

describe("isStillReading", () => {
  it("keeps reading while any provider has not answered", () => {
    const reading: ProviderSuggestions = { provider: "codex", status: "loading" };
    const answered: ProviderSuggestions = {
      provider: "opencode",
      status: "answered",
      suggestions: [],
    };

    expect(isStillReading([answered, reading])).toBe(true);
    expect(isStillReading([answered, { ...answered, provider: "pi" }])).toBe(false);
    expect(isStillReading([])).toBe(false);
  });
});
