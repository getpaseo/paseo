import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineForgeFacts, type PluginForgeClientProviderContribution } from "@getpaseo/plugin";
import {
  ClientForgeRegistry,
  deriveHostMergeCapability,
  getClientForgeDefinition,
  parseHostForgeFacts,
} from "./client-forge-registry";

function provider(
  displayName: string,
  overrides: Partial<PluginForgeClientProviderContribution> = {},
): PluginForgeClientProviderContribution {
  return {
    definition: {
      id: "acme",
      displayName,
      changeRequestAbbrev: "MR",
      changeRequestNoun: "merge request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: { cli: "aliyun", command: "aliyun configure" },
      cloudHosts: ["forge.example.com"],
    },
    view: {
      icon: { kind: "svg-path", viewBox: [0, 0, 24, 24], path: "M0 0h24v24H0z" },
      brandColor: { light: "#ff6a00", dark: "#ff6a00" },
    },
    ...overrides,
  };
}

describe("ClientForgeRegistry", () => {
  it("isolates plugin providers by host", () => {
    const registry = new ClientForgeRegistry();
    registry.replaceHost("host-a", [{ pluginId: "acme-plugin", contribution: provider("A") }]);

    expect(getClientForgeDefinition(registry.getHostSnapshot("host-a"), "acme")?.displayName).toBe(
      "A",
    );
    expect(getClientForgeDefinition(registry.getHostSnapshot("host-b"), "acme")).toBeNull();
    expect(
      getClientForgeDefinition(registry.getHostSnapshot("host-b"), "github")?.displayName,
    ).toBe("GitHub");
  });

  it("atomically replaces and removes one host without changing another", () => {
    const registry = new ClientForgeRegistry();
    registry.replaceHost("host-a", [{ pluginId: "acme-plugin", contribution: provider("A1") }]);
    registry.replaceHost("host-b", [{ pluginId: "acme-plugin", contribution: provider("B") }]);

    registry.replaceHost("host-a", [{ pluginId: "acme-plugin", contribution: provider("A2") }]);
    expect(getClientForgeDefinition(registry.getHostSnapshot("host-a"), "acme")?.displayName).toBe(
      "A2",
    );
    expect(getClientForgeDefinition(registry.getHostSnapshot("host-b"), "acme")?.displayName).toBe(
      "B",
    );

    registry.removeHost("host-a");
    expect(getClientForgeDefinition(registry.getHostSnapshot("host-a"), "acme")).toBeNull();
    expect(getClientForgeDefinition(registry.getHostSnapshot("host-b"), "acme")?.displayName).toBe(
      "B",
    );
  });

  it("rejects built-in ids instead of overriding them", () => {
    const registry = new ClientForgeRegistry();
    const conflict = registry.replaceHost("host-a", [
      {
        pluginId: "fake-github",
        contribution: provider("Fake GitHub", {
          definition: { ...provider("unused").definition, id: "github" },
        }),
      },
    ]);

    expect(conflict).toEqual([
      expect.objectContaining({ pluginId: "fake-github", providerId: "github" }),
    ]);
    expect(
      getClientForgeDefinition(registry.getHostSnapshot("host-a"), "github")?.displayName,
    ).toBe("GitHub");
  });

  it("parses plugin facts and validates merge capability callback output", () => {
    const registry = new ClientForgeRegistry();
    let transformCalls = 0;
    const facts = defineForgeFacts({
      family: "acme" as const,
      schema: z.object({ forge: z.literal("acme"), ready: z.boolean() }).transform((value) => {
        transformCalls += 1;
        return value;
      }),
      deriveMergeCapability: ({ ready }) => ({
        directMergeReady: ready,
        canEnableAutoMerge: false,
        autoMergeEnabled: false,
        canDisableAutoMerge: false,
        mergeBlockedByQueue: false,
        allowedMethods: ["merge"],
        preferredMethod: "merge",
      }),
    });
    registry.replaceHost("host-a", [
      { pluginId: "acme-plugin", contribution: provider("Acme", { facts }) },
    ]);
    const host = registry.getHostSnapshot("host-a");

    expect(parseHostForgeFacts(host, { forge: "acme", ready: true })).toEqual({
      forge: "acme",
      ready: true,
    });
    expect(deriveHostMergeCapability(host, { forge: "acme", ready: true })).toMatchObject({
      directMergeReady: true,
      allowedMethods: ["merge"],
    });
    expect(transformCalls).toBe(2);
    expect(deriveHostMergeCapability(host, { forge: "acme", ready: "yes" })).toBeNull();
  });
});
