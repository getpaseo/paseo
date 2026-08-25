import { describe, expect, it } from "vitest";
import { shouldRenderCompactContextWindowSlot } from "./context-window-slot";

describe("shouldRenderCompactContextWindowSlot", () => {
  const activeAgentKey = "server:agent";

  it("keeps the compact slot after a visible meter loses telemetry", () => {
    expect(
      shouldRenderCompactContextWindowSlot(true, true, false, activeAgentKey, activeAgentKey),
    ).toBe(true);
  });

  it("does not reserve a slot for an agent that never showed a meter", () => {
    expect(shouldRenderCompactContextWindowSlot(true, true, false, activeAgentKey, null)).toBe(
      false,
    );
  });

  it("does not carry a reserved slot to another agent or layout", () => {
    expect(
      shouldRenderCompactContextWindowSlot(true, true, false, activeAgentKey, "server:other"),
    ).toBe(false);
    expect(
      shouldRenderCompactContextWindowSlot(false, true, true, activeAgentKey, activeAgentKey),
    ).toBe(false);
  });
});
