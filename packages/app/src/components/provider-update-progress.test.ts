import { describe, expect, it } from "vitest";
import type { ProviderInstallationUpdateProgress } from "@getpaseo/protocol/messages";
import { applyProviderUpdateProgress } from "./provider-update-progress";

const running = {
  status: "running",
  id: "update-1",
  startedAt: "2026-11-13T00:00:00.000Z",
} as const;

function progress(...texts: string[]): ProviderInstallationUpdateProgress {
  return {
    provider: "codex",
    operation: running,
    output: texts.map((text) => ({ type: "stdout", text })),
  };
}

describe("applyProviderUpdateProgress", () => {
  it("appends output for the same update", () => {
    const first = applyProviderUpdateProgress(null, progress("a"), { outputLimit: 10 });
    const second = applyProviderUpdateProgress(first, progress("b"), { outputLimit: 10 });
    expect(second.output.map((entry) => entry.text)).toEqual(["a", "b"]);
    expect(second.truncated).toBeUndefined();
  });

  it("drops the oldest output beyond the limit and marks the update truncated", () => {
    let update = applyProviderUpdateProgress(null, progress("12345"), { outputLimit: 8 });
    update = applyProviderUpdateProgress(update, progress("6789"), { outputLimit: 8 });
    expect(update.output.map((entry) => entry.text)).toEqual(["6789"]);
    expect(update.truncated).toBe(true);

    update = applyProviderUpdateProgress(update, progress("abcdefghij"), { outputLimit: 8 });
    expect(update.output.map((entry) => entry.text)).toEqual(["cdefghij"]);
    expect(update.truncated).toBe(true);
  });

  it("starts a new update empty", () => {
    const first = applyProviderUpdateProgress(null, progress("123456789"), { outputLimit: 4 });
    const next = applyProviderUpdateProgress(
      first,
      { ...progress("x"), operation: { ...running, id: "update-2" } },
      { outputLimit: 4 },
    );
    expect(next.output.map((entry) => entry.text)).toEqual(["x"]);
    expect(next.truncated).toBeUndefined();
  });
});
