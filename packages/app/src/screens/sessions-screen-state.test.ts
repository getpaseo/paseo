import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  ALL_PROJECTS_OPTION_ID,
  buildSessionProjectOptions,
  filterAgentsByProject,
  sessionProjectKey,
  sessionProjectLabel,
} from "./sessions-screen-state";

function projectAgent(input: {
  projectKey?: string;
  projectName?: string;
  cwd?: string;
  lastActivityAt?: Date;
}): AggregatedAgent {
  return {
    id: Math.random().toString(36).slice(2),
    cwd: input.cwd ?? "/repo",
    lastActivityAt: input.lastActivityAt ?? new Date("2026-03-02T12:00:00.000Z"),
    projectPlacement: input.projectKey
      ? {
          projectKey: input.projectKey,
          projectName: input.projectName ?? "",
          checkout: { remoteUrl: null, currentBranch: "main" },
        }
      : null,
  } as unknown as AggregatedAgent;
}

describe("sessionProjectKey", () => {
  it("prefers the daemon placement key", () => {
    const placed = projectAgent({ projectKey: "remote:github.com/acme/app", cwd: "/other/path" });
    expect(sessionProjectKey(placed)).toBe("remote:github.com/acme/app");
  });

  it("falls back to the cwd-derived key without a placement", () => {
    const unplaced = projectAgent({ cwd: "/Users/me/app" });
    expect(sessionProjectKey(unplaced)).toBe("/Users/me/app");
  });

  it("collapses a paseo worktree cwd back to the repo root", () => {
    const unplaced = projectAgent({ cwd: "/Users/me/app/.paseo/worktrees/abc123" });
    expect(sessionProjectKey(unplaced)).toBe("/Users/me/app");
  });
});

describe("buildSessionProjectOptions", () => {
  it("dedupes rows by project key and labels them with the placement name", () => {
    const options = buildSessionProjectOptions([
      projectAgent({ projectKey: "k1", projectName: "app" }),
      projectAgent({ projectKey: "k1", projectName: "app" }),
      projectAgent({ projectKey: "k2", projectName: "api" }),
    ]);
    expect(options.map((option) => option.projectKey).sort()).toEqual(["k1", "k2"]);
    expect(options.find((option) => option.projectKey === "k1")?.label).toBe("app");
  });

  it("orders projects by their most recent loaded row", () => {
    const options = buildSessionProjectOptions([
      projectAgent({
        projectKey: "old",
        projectName: "old",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      projectAgent({
        projectKey: "new",
        projectName: "new",
        lastActivityAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
      projectAgent({
        projectKey: "old",
        projectName: "old",
        lastActivityAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);
    expect(options.map((option) => option.projectKey)).toEqual(["new", "old"]);
  });

  it("derives a label from the key when no row carries a project name", () => {
    const options = buildSessionProjectOptions([
      projectAgent({ projectKey: "remote:github.com/acme/app" }),
    ]);
    expect(options[0]?.label).toBe("acme/app");
  });

  it("skips rows whose project key resolves empty", () => {
    const options = buildSessionProjectOptions([projectAgent({ cwd: "" })]);
    expect(options).toEqual([]);
  });
});

describe("filterAgentsByProject", () => {
  const inProject = projectAgent({ projectKey: "k1", projectName: "app" });
  const elsewhere = projectAgent({ projectKey: "k2", projectName: "api" });

  it("keeps the caller's array untouched for `all`", () => {
    const agents = [inProject, elsewhere];
    expect(filterAgentsByProject(agents, ALL_PROJECTS_OPTION_ID)).toBe(agents);
  });

  it("keeps only rows whose key matches the selection", () => {
    expect(filterAgentsByProject([inProject, elsewhere], "k1")).toEqual([inProject]);
  });

  it("returns an empty list for a project absent from the loaded rows", () => {
    expect(filterAgentsByProject([inProject], "gone")).toEqual([]);
  });
});

describe("sessionProjectLabel", () => {
  it("derives a display name for a key that is no longer an option", () => {
    expect(sessionProjectLabel("remote:github.com/acme/app")).toBe("acme/app");
    expect(sessionProjectLabel("/Users/me/app")).toBe("app");
  });

  it("returns empty for the all-projects sentinel", () => {
    expect(sessionProjectLabel(ALL_PROJECTS_OPTION_ID)).toBe("");
  });
});
