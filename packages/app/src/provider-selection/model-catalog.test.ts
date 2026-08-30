import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { findModelByReference } from "./model-catalog";

describe("findModelByReference", () => {
  it("prefers an exact model id over another model's alias", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "canonical-model",
        label: "Canonical model",
        aliases: ["gateway-model"],
      },
      {
        provider: "claude",
        id: "gateway-model",
        label: "Exact gateway model",
      },
    ];

    expect(findModelByReference(models, "gateway-model")?.label).toBe("Exact gateway model");
  });

  it("matches a parameterized Cursor model id to the base catalog id", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "cursor",
        id: "grok-4.6",
        label: "Cursor Grok 4.6",
      },
    ];

    expect(findModelByReference(models, "grok-4.6[effort=xhigh,fast=false]")?.id).toBe("grok-4.6");
  });
});
