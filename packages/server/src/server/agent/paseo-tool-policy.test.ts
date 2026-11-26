import { describe, expect, test } from "vitest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import {
  isPaseoToolEnabled,
  narrowPaseoToolPolicy,
  resolvePaseoToolPolicy,
} from "./paseo-tool-policy.js";

describe("Paseo tool policy", () => {
  test("defaults to all Paseo tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderPaseoToolsPolicy;

    expect(
      resolvePaseoToolPolicy("custom-claude", {
        claude: { paseoTools: { enabled: false } },
        "custom-claude": { paseoTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolvePaseoToolPolicy("other-custom", { claude: { paseoTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isPaseoToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isPaseoToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isPaseoToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });

  test("an agent's own policy only narrows its provider's", () => {
    expect(narrowPaseoToolPolicy({ enabled: true }, undefined)).toEqual({ enabled: true });
    expect(narrowPaseoToolPolicy(undefined, { enabled: false })).toEqual({ enabled: false });
    // The provider's off wins over the agent's on.
    expect(narrowPaseoToolPolicy({ enabled: false }, { enabled: true })).toEqual({
      enabled: false,
    });
    expect(
      narrowPaseoToolPolicy(
        { disabledTools: ["create_agent", "list_agents"] },
        { disabledTools: ["create_terminal", "create_agent"] },
      ),
    ).toEqual({ enabled: true, disabledTools: ["create_agent", "list_agents", "create_terminal"] });
    const narrowed = narrowPaseoToolPolicy({ enabled: true }, { disabledTools: ["create_agent"] });
    expect(isPaseoToolEnabled(narrowed, "create_agent")).toBe(false);
    expect(isPaseoToolEnabled(narrowed, "list_agents")).toBe(true);
  });
});
