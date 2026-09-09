import { describe, expect, it } from "vitest";
import { shouldRenderCompactContextWindowSlot } from "./context-window-slot";

describe("shouldRenderCompactContextWindowSlot", () => {
  const activeAgentKey = "server:agent";

  it("keeps the compact slot after a visible meter loses telemetry", () => {
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: true,
        hasAgent: true,
        hasMeter: false,
        activeAgentKey,
        reservedAgentKey: activeAgentKey,
      }),
    ).toBe(true);
  });

  it("does not reserve a slot for an agent that never showed a meter", () => {
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: true,
        hasAgent: true,
        hasMeter: false,
        activeAgentKey,
        reservedAgentKey: null,
      }),
    ).toBe(false);
  });

  it("does not carry a reserved slot to another agent or layout", () => {
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: true,
        hasAgent: true,
        hasMeter: false,
        activeAgentKey,
        reservedAgentKey: "server:other",
      }),
    ).toBe(false);
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: false,
        hasAgent: true,
        hasMeter: true,
        activeAgentKey,
        reservedAgentKey: activeAgentKey,
      }),
    ).toBe(false);
  });
});
