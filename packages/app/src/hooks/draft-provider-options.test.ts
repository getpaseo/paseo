import { describe, expect, it } from "vitest";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import { isControlActive } from "@/agent-controls/option-controls";
import { composeDraftOptions } from "./draft-provider-options";

const SPEED: AgentOptionControl = {
  type: "select",
  key: "service_tier",
  label: "Speed",
  defaultValue: "default",
  choices: [
    { value: "default", label: "Standard" },
    { value: "priority", label: "Fast" },
  ],
};
const WEB_SEARCH: AgentOptionControl = { type: "toggle", key: "web_search", label: "Web search" };

describe("composeDraftOptions", () => {
  it("shows a legacy Fast profile as the Fast tier, highlighted", () => {
    const { shown } = composeDraftOptions({
      seed: { service_tier: "fast" },
      persisted: {},
      edits: {},
      controls: [SPEED],
      resolved: { service_tier: "priority" },
    });

    expect(shown).toEqual({ service_tier: "priority" });
    expect(isControlActive(SPEED, shown)).toBe(true);
  });

  it("creates with the profile's options, including ones no control draws", () => {
    const { own } = composeDraftOptions({
      seed: { service_tier: "fast", sandbox_mode: "read-only" },
      persisted: {},
      edits: {},
      controls: [SPEED],
      resolved: { service_tier: "priority" },
    });

    expect(own).toEqual({ service_tier: "fast", sandbox_mode: "read-only" });
  });

  it("lets an edit win over the daemon-resolved value and the seed", () => {
    const { shown, own } = composeDraftOptions({
      seed: { service_tier: "fast" },
      persisted: {},
      edits: { service_tier: "default" },
      controls: [SPEED],
      resolved: { service_tier: "priority" },
    });

    expect(shown).toEqual({ service_tier: "default" });
    expect(own).toEqual({ service_tier: "default" });
  });

  it("restores last-used values only for controls the provider still draws, and not over the seed", () => {
    const { shown, own } = composeDraftOptions({
      seed: { service_tier: "fast" },
      persisted: { web_search: true, retired: true, service_tier: "default" },
      edits: {},
      controls: [SPEED, WEB_SEARCH],
      resolved: { service_tier: "priority" },
    });

    expect(shown).toEqual({ service_tier: "priority", web_search: true });
    expect(own).toEqual({ service_tier: "fast", web_search: true });
  });

  it("sends nothing when nothing was seeded, remembered or edited", () => {
    expect(
      composeDraftOptions({
        seed: {},
        persisted: {},
        edits: {},
        controls: [SPEED],
        resolved: { service_tier: "default" },
      }).own,
    ).toBeUndefined();
  });
});
