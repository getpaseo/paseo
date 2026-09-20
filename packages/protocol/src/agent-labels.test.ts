import { describe, expect, test } from "vitest";
import {
  AUTO_OPEN_AGENT_TAB_LABEL,
  getParentAgentIdFromLabels,
  isDelegatedAgent,
  PARENT_AGENT_ID_LABEL,
  shouldAutoOpenAgentTab,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("recognizes the explicit auto-open tab value", () => {
    expect(shouldAutoOpenAgentTab({ labels: { [AUTO_OPEN_AGENT_TAB_LABEL]: "true" } })).toBe(true);
  });

  test("does not treat missing or non-true values as auto-open", () => {
    expect(shouldAutoOpenAgentTab({ labels: {} })).toBe(false);
    expect(shouldAutoOpenAgentTab({ labels: { [AUTO_OPEN_AGENT_TAB_LABEL]: "false" } })).toBe(
      false,
    );
  });
});
