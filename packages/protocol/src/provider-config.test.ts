import { describe, expect, test } from "vitest";

import { ProviderOverrideSchema } from "./provider-config.js";

describe("provider subagent model policy", () => {
  test("accepts an empty allowed-model list as unrestricted", () => {
    const parsed = ProviderOverrideSchema.parse({
      subagentAllowedModels: [],
    });

    expect(parsed).toEqual({ subagentAllowedModels: [] });
  });

  test("keeps model guidance separate from provider model descriptions", () => {
    const parsed = ProviderOverrideSchema.parse({
      models: [{ id: "main", label: "Main", description: "Provider description" }],
      subagentModelGuidance: {
        "fast-model": "Use for narrow, inexpensive tasks.",
      },
    });

    expect(parsed).toEqual({
      models: [{ id: "main", label: "Main", description: "Provider description" }],
      subagentModelGuidance: {
        "fast-model": "Use for narrow, inexpensive tasks.",
      },
    });
  });
});
