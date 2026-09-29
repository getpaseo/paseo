import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { isSystemOneExcluded } from "./scope.js";
import { createConfiguredSystemOneDecisionSource } from "./tools.js";

const homes: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function homeWithExcludedPaths(excludedPaths: string[]): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "paseo-system-one-scope-"));
  homes.push(home);
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ version: 1, daemon: { systemOne: { enabled: true, excludedPaths } } }),
  );
  return home;
}

describe("isSystemOneExcluded", () => {
  it("matches the excluded directory and everything below it, including ~ paths", () => {
    const home = homeWithExcludedPaths(["/work/company", "~/9elf26"]);

    expect(isSystemOneExcluded(home, "/work/company")).toBe(true);
    expect(isSystemOneExcluded(home, "/work/company/app/src")).toBe(true);
    expect(isSystemOneExcluded(home, path.join(os.homedir(), "9elf26", "repo"))).toBe(true);
    expect(isSystemOneExcluded(home, "/work/company-private")).toBe(false);
    expect(isSystemOneExcluded(home, "/work")).toBe(false);
    expect(isSystemOneExcluded(home, undefined)).toBe(false);
  });

  it("refuses decisions for excluded projects without calling TypeSafe", async () => {
    const home = homeWithExcludedPaths(["/work/company"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const source = createConfiguredSystemOneDecisionSource(
      home,
      {
        get: () => ({
          systemOne: {
            enabled: true,
            model: "jev-latest",
            endpoint: "https://api.typesafe.ai/v1/systemone",
            minimumConfidence: 0.5,
          },
        }),
      } as unknown as Pick<DaemonConfigStore, "get">,
      () => "/work/company/app",
    );

    await expect(
      source.decide({
        state: {},
        questions: { q: { type: "choice", criteria: { a: "A", b: "B" } } },
      }),
    ).rejects.toThrow("turned off for this project");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
