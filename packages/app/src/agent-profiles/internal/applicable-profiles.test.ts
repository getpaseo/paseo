import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { selectApplicableProfiles } from "./applicable-profiles";

function profile(id: string, provider: string, name = id): AgentProfile {
  return { id, name, provider };
}

describe("selectApplicableProfiles", () => {
  it("keeps only profiles naming a provider the composer can run", () => {
    const claude = profile("a", "claude");
    const codex = profile("b", "codex");
    expect(selectApplicableProfiles([claude, codex], ["claude"])).toEqual([claude]);
  });

  it("keeps the first profile when a stored config repeats an id", () => {
    const first = profile("same", "claude", "First");
    const second = profile("same", "claude", "Second");
    expect(selectApplicableProfiles([first, second], ["claude"])).toEqual([first]);
  });
});
