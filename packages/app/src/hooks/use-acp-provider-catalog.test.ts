import { describe, expect, it } from "vitest";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { buildAcpProviderConfigPatch, getAcpProviderCatalog } from "./use-acp-provider-catalog";

function findProvider(id: string) {
  const entry = getAcpProviderCatalog().find((provider) => provider.id === id);
  if (!entry) {
    throw new Error(`Missing ACP provider catalog entry: ${id}`);
  }
  return entry;
}

describe("ACP provider catalog", () => {
  it("vendors provider entries with unique ids and concrete commands", () => {
    const ids = new Set<string>();

    for (const entry of ACP_PROVIDER_CATALOG) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.title).not.toBe("");
      expect(entry.description).not.toBe("");
      expect(entry.installLink).toMatch(/^https:\/\//);
      expect(entry.command.length).toBeGreaterThan(0);
      expect(entry.command[0]).not.toBe("");
    }
  });

  it("bundles SVG icons for catalog entries that declare an icon", () => {
    const entriesWithIcons = ACP_PROVIDER_CATALOG.filter((entry) => entry.id !== "hermes");

    expect(entriesWithIcons.length).toBeGreaterThan(0);
    for (const entry of entriesWithIcons) {
      expect(entry.iconSvg).toContain("<svg");
    }
  });

  it("uses PATH commands for entries that were binary distributions upstream", () => {
    expect(findProvider("amp-acp").command).toEqual(["amp-acp"]);
    expect(findProvider("cursor").command).toEqual(["cursor-agent", "acp"]);
    expect(findProvider("goose").command).toEqual(["goose", "acp"]);
    expect(findProvider("junie").command).toEqual(["junie", "--acp", "true"]);
    expect(findProvider("poolside").command).toEqual(["pool", "acp"]);
  });

  it("maps a catalog entry to the daemon provider config patch", () => {
    expect(buildAcpProviderConfigPatch(findProvider("amp-acp"))).toEqual({
      providers: {
        "amp-acp": {
          extends: "acp",
          label: "Amp",
          description: "ACP wrapper for Amp - the frontier coding agent",
          command: ["amp-acp"],
          env: {},
        },
      },
    });
  });

  it("preserves provider env in the daemon config patch", () => {
    const patch = buildAcpProviderConfigPatch(findProvider("auggie"));

    expect(patch.providers?.auggie?.env).toEqual({
      AUGMENT_DISABLE_AUTO_UPDATE: "1",
    });
  });
});
