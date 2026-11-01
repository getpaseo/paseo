import { describe, expect, test } from "vitest";
import type { ZodObject, ZodOptional, ZodTypeAny } from "zod";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import { isPaseoToolEnabled, resolvePaseoToolPolicy } from "./paseo-tool-policy.js";

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

  test("create_agent and update_agent schemas document service_tier and fast_mode accurately", () => {
    type OptionalRecordSchema = ZodOptional<ZodObject<{ features: ZodTypeAny }>>;

    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as PaseoToolHostDependencies["agentManager"],
      agentStorage: {} as unknown as PaseoToolHostDependencies["agentStorage"],
      terminalManager: {} as unknown as PaseoToolHostDependencies["terminalManager"],
      workspaceScripts: {} as unknown as PaseoToolHostDependencies["workspaceScripts"],
      scheduleService: {} as unknown as PaseoToolHostDependencies["scheduleService"],
      providerSnapshotManager:
        {} as unknown as PaseoToolHostDependencies["providerSnapshotManager"],
      daemonConfigStore: {} as unknown as PaseoToolHostDependencies["daemonConfigStore"],
      logger: createTestLogger(),
    });

    const createAgentTool = catalog.getTool("create_agent");
    expect(createAgentTool).toBeDefined();
    if (!createAgentTool) throw new Error("create_agent tool not found");
    const createShape = (
      createAgentTool.inputSchema as ZodObject<{ settings: OptionalRecordSchema }>
    ).shape;
    const createFeaturesDesc = createShape.settings.unwrap().shape.features.description;
    expect(createFeaturesDesc).toContain('service_tier: "priority"');
    expect(createFeaturesDesc).toContain("fast_mode: true");

    const updateAgentTool = catalog.getTool("update_agent");
    expect(updateAgentTool).toBeDefined();
    if (!updateAgentTool) throw new Error("update_agent tool not found");
    const updateInput = updateAgentTool.inputSchema as { settings: OptionalRecordSchema };
    const updateFeaturesDesc = updateInput.settings.unwrap().shape.features.description;
    expect(updateFeaturesDesc).toContain('service_tier: "priority"');
    expect(updateFeaturesDesc).toContain("fast_mode: true");
  });
});
