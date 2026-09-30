import { describe, expect, it, test } from "vitest";
import {
  getParentAgentIdFromLabels,
  isPersonFacingOrigin,
  getOpenAgentTabLabel,
  hasOpenAgentTab,
  isDelegatedAgent,
  isOpenAgentTabLabel,
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

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });
});

describe("withOriginLabel", () => {
  test("derives the origin from what started the session", async () => {
    const { withOriginLabel } = await import("./agent-labels.js");
    expect(withOriginLabel(undefined, {})["paseo.origin"]).toBe("user");
    expect(withOriginLabel({}, { internal: true })["paseo.origin"]).toBe("internal");
    expect(withOriginLabel({ "paseo.schedule-id": "s1" }, {})["paseo.origin"]).toBe("schedule:s1");
    expect(withOriginLabel({ "paseo.parent-agent-id": "a1" }, {})["paseo.origin"]).toBe("agent:a1");
  });

  test("keeps an origin the caller set", async () => {
    const { withOriginLabel } = await import("./agent-labels.js");
    const labels = { "paseo.origin": "systemd:g4-watch.service", "paseo.parent-agent-id": "a1" };
    expect(withOriginLabel(labels, {})).toBe(labels);
  });
});

describe("isPersonFacingOrigin", () => {
  it("keeps people, Paperclip's Boss and delegated agents; drops Paperclip workers and timers", () => {
    expect(isPersonFacingOrigin(undefined)).toBe(true);
    expect(isPersonFacingOrigin("user")).toBe(true);
    expect(isPersonFacingOrigin("user:cli")).toBe(true);
    expect(isPersonFacingOrigin("agent:abc")).toBe(true);
    expect(isPersonFacingOrigin("paperclip:Boss")).toBe(true);
    for (const origin of [
      "paperclip:Dev",
      "paperclip:Reviewer",
      "paperclip:Tester",
      "paperclip:Scout",
      "schedule:21bb6e3a",
      "systemd:g4-watch.service",
      "process:cron",
      "internal",
    ]) {
      expect(isPersonFacingOrigin(origin)).toBe(false);
    }
  });
});
