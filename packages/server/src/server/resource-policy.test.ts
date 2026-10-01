import { describe, expect, test } from "vitest";

import {
  buildResourcePolicyPrompt,
  ResourcePolicyRuntime,
  RESOURCE_POLICY_LIMITS,
} from "./resource-policy.js";

describe("resource policy", () => {
  test("builds a stable provider-agnostic prompt for each policy", () => {
    expect(buildResourcePolicyPrompt("economy")).toContain("one status read per run");
    expect(buildResourcePolicyPrompt("balanced")).toContain("four reads per run");
    expect(buildResourcePolicyPrompt("deep")).toContain("twelve status reads per run");
    expect(buildResourcePolicyPrompt("deep")).not.toMatch(/claude|codex|opencode/i);
    expect(buildResourcePolicyPrompt("deep")).toBe(buildResourcePolicyPrompt("deep"));
  });

  test("observation budgets do not end an already-authorized task", () => {
    for (const policy of ["economy", "balanced", "deep"] as const) {
      const prompt = buildResourcePolicyPrompt(policy);
      expect(prompt).toContain("standalone status-only request");
      expect(prompt).toContain("not task completion");
      expect(prompt).toContain("already-authorized task");
      expect(prompt).toContain("automatic continuation is registered");
      expect(prompt).not.toContain("Prefer event notifications and return control");
    }
  });

  test("allows one economy run read and deduplicates a repeated request", () => {
    let now = 0;
    const runtime = new ResourcePolicyRuntime({
      getPolicy: () => "economy",
      now: () => now,
    });

    expect(
      runtime.checkStatusRead({ consumerId: "agent-1", runKey: "run-1", requestKey: "a" }),
    ).toEqual({
      allowed: true,
      deduplicated: false,
      policy: "economy",
    });
    now += 100;
    expect(
      runtime.checkStatusRead({ consumerId: "agent-1", runKey: "run-1", requestKey: "a" }),
    ).toEqual({
      allowed: true,
      deduplicated: true,
      policy: "economy",
    });
    now += RESOURCE_POLICY_LIMITS.economy.statusDedupWindowMs;
    expect(
      runtime.checkStatusRead({ consumerId: "agent-1", runKey: "run-1", requestKey: "b" }),
    ).toMatchObject({
      allowed: false,
      policy: "economy",
    });
  });

  test("resets per-run limits when the agent starts a new run", () => {
    let policy: "economy" | "balanced" = "balanced";
    const runtime = new ResourcePolicyRuntime({ getPolicy: () => policy });

    for (let index = 0; index < RESOURCE_POLICY_LIMITS.balanced.maxStatusReadsPerRun; index += 1) {
      expect(
        runtime.checkStatusRead({
          consumerId: "agent-1",
          runKey: "run-1",
          requestKey: `status-${index}`,
        }).allowed,
      ).toBe(true);
    }
    expect(
      runtime.checkStatusRead({
        consumerId: "agent-1",
        runKey: "run-1",
        requestKey: "status-final",
      }).allowed,
    ).toBe(false);
    expect(
      runtime.checkStatusRead({
        consumerId: "agent-1",
        runKey: "run-2",
        requestKey: "status-first",
      }).allowed,
    ).toBe(true);

    policy = "economy";
    expect(runtime.canStartAutomatedLoop("schedule")).toMatchObject({
      allowed: false,
      policy: "economy",
    });
  });

  test("limits app status reads in a rolling window", () => {
    let now = 0;
    const runtime = new ResourcePolicyRuntime({
      getPolicy: () => "economy",
      now: () => now,
    });

    expect(runtime.checkStatusRead({ consumerId: "app-1", requestKey: "active" }).allowed).toBe(
      true,
    );
    now += RESOURCE_POLICY_LIMITS.economy.statusDedupWindowMs;
    expect(runtime.checkStatusRead({ consumerId: "app-1", requestKey: "history" }).allowed).toBe(
      false,
    );
    now += RESOURCE_POLICY_LIMITS.economy.statusWindowMs;
    expect(runtime.checkStatusRead({ consumerId: "app-1", requestKey: "history" }).allowed).toBe(
      true,
    );
  });
});
