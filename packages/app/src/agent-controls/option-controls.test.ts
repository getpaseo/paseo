import { describe, expect, it } from "vitest";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import {
  getControlTooltip,
  isControlActive,
  readSelectOption,
  readToggleOption,
} from "./option-controls";

const speed: AgentOptionControl = {
  type: "select",
  key: "service_tier",
  label: "Speed",
  defaultValue: "default",
  choices: [
    { value: "default", label: "Normal" },
    { value: "priority", label: "Fast" },
  ],
};
const fast: AgentOptionControl = { type: "toggle", key: "fast_mode", label: "Fast" };

describe("option controls", () => {
  it("reads a select from options and falls back to the control's default", () => {
    if (speed.type !== "select") throw new Error("select expected");
    expect(readSelectOption(speed, { service_tier: "priority" })).toBe("priority");
    expect(readSelectOption(speed, {})).toBe("default");
    expect(readSelectOption(speed, { service_tier: "unknown-tier" })).toBe("default");
  });

  it("reads a toggle from options and is off when unset", () => {
    if (fast.type !== "toggle") throw new Error("toggle expected");
    expect(readToggleOption(fast, { fast_mode: true })).toBe(true);
    expect(readToggleOption(fast, {})).toBe(false);
  });

  it("is active when the option differs from the control's default", () => {
    expect(isControlActive(speed, { service_tier: "priority" })).toBe(true);
    expect(isControlActive(speed, { service_tier: "default" })).toBe(false);
    expect(isControlActive(speed, {})).toBe(false);
    expect(isControlActive(fast, { fast_mode: true })).toBe(true);
    expect(isControlActive(fast, {})).toBe(false);
  });

  it("prefers a control's tooltip over its label", () => {
    expect(getControlTooltip({ label: "Plan", tooltip: "Toggle plan mode" })).toBe(
      "Toggle plan mode",
    );
    expect(getControlTooltip({ label: "Custom" })).toBe("Custom");
  });
});
