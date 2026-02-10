import { describe, expect, it } from "vitest";

import type { CheckoutStatusPayload } from "@/hooks/use-checkout-status-query";
import {
  buildNewAgentRoute,
  resolveNewAgentWorkingDir,
} from "./new-agent-routing";

describe("buildNewAgentRoute", () => {
  it("falls back to /agent when no working directory is provided", () => {
    expect(buildNewAgentRoute(undefined)).toBe("/agent");
    expect(buildNewAgentRoute("   ")).toBe("/agent");
  });

  it("encodes the working directory query parameter", () => {
    expect(buildNewAgentRoute("/Users/me/dev/paseo")).toBe(
      "/agent?workingDir=%2FUsers%2Fme%2Fdev%2Fpaseo"
    );
  });
});

describe("resolveNewAgentWorkingDir", () => {
  it("returns the current cwd for regular checkouts", () => {
    expect(resolveNewAgentWorkingDir("/repo/path", null)).toBe("/repo/path");
  });

  it("returns the main repo root for paseo-owned worktrees", () => {
    const checkout = {
      isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repo/main",
    } as CheckoutStatusPayload;

    expect(resolveNewAgentWorkingDir("/repo/.paseo/worktrees/feature", checkout)).toBe(
      "/repo/main"
    );
  });
});
