import { describe, expect, it } from "vitest";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import {
  getControlTooltip,
  isControlActive,
  mergeOptionValue,
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

describe("mergeOptionValue", () => {
  it("creates the record when the agent has no options yet", () => {
    expect(mergeOptionValue(undefined, "agent_team", true)).toEqual({ agent_team: true });
  });

  it("sets the pressed key without touching the others", () => {
    const options = { plan_mode: false, agent_team: false, permission_preset: "auto" };
    expect(mergeOptionValue(options, "agent_team", true)).toEqual({
      plan_mode: false,
      agent_team: true,
      permission_preset: "auto",
    });
  });

  it("does not mutate the options record it was given", () => {
    const options = { agent_team: false };
    mergeOptionValue(options, "agent_team", true);
    expect(options).toEqual({ agent_team: false });
  });
});
