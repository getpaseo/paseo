import { describe, expect, it } from "vitest";
import { createPluginDraftActionGuard } from "./guard";

describe("createPluginDraftActionGuard", () => {
  it("keeps a capture current while the surface is unchanged", () => {
    const guard = createPluginDraftActionGuard();
    const generation = guard.capture();
    expect(guard.isCurrent(generation)).toBe(true);
    expect(guard.isCurrent(generation)).toBe(true);
  });

  it("invalidates captures when the surface inputs change", () => {
    const guard = createPluginDraftActionGuard();
    const generation = guard.capture();
    guard.invalidate();
    expect(guard.isCurrent(generation)).toBe(false);
  });

  it("invalidates earlier captures when a second action is pressed", () => {
    const guard = createPluginDraftActionGuard();
    const first = guard.capture();
    const second = guard.capture();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("invalidates every outstanding capture", () => {
    const guard = createPluginDraftActionGuard();
    const generations = [guard.capture(), guard.capture(), guard.capture()];
    guard.invalidate();
    for (const generation of generations) {
      expect(guard.isCurrent(generation)).toBe(false);
    }
  });
});
