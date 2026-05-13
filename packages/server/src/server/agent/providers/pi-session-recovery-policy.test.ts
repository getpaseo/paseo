import { describe, expect, test, vi } from "vitest";

import {
  applyPiSessionRecoveryPolicy,
  type PiSessionRecoveryPolicySession,
} from "./pi-session-recovery-policy.js";

function createRecoverySession(
  options: {
    messages?: PiSessionRecoveryPolicySession["messages"];
    errorMessage?: string | null;
    compact?: () => Promise<void>;
  } = {},
): PiSessionRecoveryPolicySession {
  return {
    messages: options.messages ?? [],
    agent: {
      state: {
        errorMessage: options.errorMessage ?? null,
      },
    },
    compact: options.compact ?? vi.fn(async () => undefined),
  };
}

describe("applyPiSessionRecoveryPolicy", () => {
  test("compacts sessions that ended on Pi Copilot short 413 overflow", async () => {
    const compact = vi.fn(async () => undefined);
    const session = createRecoverySession({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "413 failed to parse request",
        },
      ],
      compact,
    });

    const result = await applyPiSessionRecoveryPolicy(session);

    expect(result).toEqual({ applied: true, policyId: "piCopilot413" });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  test("uses Pi agent error state when message history has no matching assistant error", async () => {
    const compact = vi.fn(async () => undefined);
    const session = createRecoverySession({
      messages: [{ role: "user" }],
      errorMessage: "  413 failed to parse request  ",
      compact,
    });

    const result = await applyPiSessionRecoveryPolicy(session);

    expect(result).toEqual({ applied: true, policyId: "piCopilot413" });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  test("does not compact unrelated Pi errors", async () => {
    const compact = vi.fn(async () => undefined);
    const session = createRecoverySession({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "413 unrelated provider error",
        },
      ],
      compact,
    });

    const result = await applyPiSessionRecoveryPolicy(session);

    expect(result).toEqual({ applied: false });
    expect(compact).not.toHaveBeenCalled();
  });

  test("treats already-compacted sessions as recovered", async () => {
    const session = createRecoverySession({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "413 failed to parse request",
        },
      ],
      compact: vi.fn(async () => {
        throw new Error("Already compacted");
      }),
    });

    await expect(applyPiSessionRecoveryPolicy(session)).resolves.toEqual({
      applied: true,
      policyId: "piCopilot413",
    });
  });

  test("surfaces unexpected compaction failures", async () => {
    const session = createRecoverySession({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "413 failed to parse request",
        },
      ],
      compact: vi.fn(async () => {
        throw new Error("disk exploded");
      }),
    });

    await expect(applyPiSessionRecoveryPolicy(session)).rejects.toThrow("disk exploded");
  });
});
