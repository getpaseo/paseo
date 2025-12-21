import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { extractAgentModel } from "./extract-agent-model";

describe("extractAgentModel", () => {
  it("returns runtime model when present", () => {
    const agent = {
      runtimeInfo: { model: "gpt-5.2-codex" },
    } as Partial<Agent> as Agent;

    expect(extractAgentModel(agent)).toBe("gpt-5.2-codex");
  });

  it("returns null when runtime model missing even if config model is set", () => {
    const agent = {
      model: "gpt-5.1-codex",
      runtimeInfo: {},
    } as Partial<Agent> as Agent;

    expect(extractAgentModel(agent)).toBeNull();
  });
});
