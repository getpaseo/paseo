import { describe, expect, test } from "vitest";

import {
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("subagent model policy protocol", () => {
  test("parses policy fields in mutable provider config and patches", () => {
    const policy = {
      subagentAllowedModels: [],
      subagentModelGuidance: {
        "fast-model": "Use for narrow, inexpensive tasks.",
      },
    };

    const config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: { codex: policy },
    });
    const patch = MutableDaemonConfigPatchSchema.parse({
      providers: { codex: policy },
    });

    expect(config.providers.codex).toEqual(policy);
    expect(patch.providers?.codex).toEqual(policy);
  });

  test("parses the optional server feature gate", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-test",
      features: { subagentModelPolicy: true },
    });

    expect(parsed.features?.subagentModelPolicy).toBe(true);
  });
});
