import { describe, expect, test } from "vitest";
import {
  EXTERNAL_WAIT_ID_LABEL,
  getExternalWaitIdFromLabels,
  getParentAgentIdFromLabels,
  isDelegatedAgent,
  PARENT_AGENT_ID_LABEL,
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

  test("reads only non-empty external wait identifiers", () => {
    expect(getExternalWaitIdFromLabels({ [EXTERNAL_WAIT_ID_LABEL]: " wait-123 " })).toBe(
      "wait-123",
    );
    expect(getExternalWaitIdFromLabels({ [EXTERNAL_WAIT_ID_LABEL]: "" })).toBeNull();
    expect(getExternalWaitIdFromLabels({ [EXTERNAL_WAIT_ID_LABEL]: 42 })).toBeNull();
  });
});
