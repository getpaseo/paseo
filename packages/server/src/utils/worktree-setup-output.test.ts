import { describe, expect, it } from "vitest";

import {
  appendWorktreeSetupOutput,
  createWorktreeSetupOutputAccumulator,
  renderWorktreeSetupOutput,
} from "./worktree-setup-output.js";

describe("worktree setup output", () => {
  it("retains both ends when rendering buffered output under a smaller total budget", () => {
    const accumulator = createWorktreeSetupOutputAccumulator(128);
    appendWorktreeSetupOutput(accumulator, `prefix-${"x".repeat(80)}-suffix`);

    const rendered = renderWorktreeSetupOutput(accumulator, 64);

    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain("prefix-");
    expect(rendered.text).toContain("-suffix");
    expect(rendered.text).toContain(`...<${rendered.omittedBytes} bytes omitted>...`);
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(64);
  });
});
