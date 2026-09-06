import { describe, expect, test } from "vitest";

import { buildManualVoiceSystemPrompt, wrapSpokenInput } from "../providers/manual/prompt.js";

describe("manual voice prompt", () => {
  test("requires user-facing output to use the provider-owned speak tool", () => {
    const prompt = buildManualVoiceSystemPrompt();

    expect(prompt).toContain("Paseo voice orchestrator");
    expect(prompt).toContain("Use the Paseo tools as your primary way");
    expect(prompt).toContain("delegate to an appropriate agent by default");
    expect(prompt).toContain("Always use the speak tool for all user-facing communication.");
  });

  test("marks transcribed input without changing the conversation owner", () => {
    expect(wrapSpokenInput("Please check the build")).toContain(
      "<spoken-input>\nPlease check the build\n</spoken-input>",
    );
  });
});
