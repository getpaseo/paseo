import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACP_REGISTRY_URL,
  buildAcpProviderConfigPatch,
  fetchAcpRegistryEntries,
  parseAcpRegistry,
} from "./use-acp-registry";

function readRegistryFixture(): unknown {
  return JSON.parse(
    readFileSync(new URL("./__fixtures__/acp-registry.json", import.meta.url), "utf8"),
  );
}

describe("ACP registry logic", () => {
  it("fetches and parses the live registry fixture shape through an injected adapter", async () => {
    const fetchRegistry = async (url: string) => ({
      ok: url === ACP_REGISTRY_URL,
      status: url === ACP_REGISTRY_URL ? 200 : 404,
      json: async () => readRegistryFixture(),
    });

    const entries = await fetchAcpRegistryEntries(ACP_REGISTRY_URL, fetchRegistry);

    expect(entries).toMatchObject([
      {
        id: "agoragentic-acp",
        name: "Agoragentic",
        version: "1.3.0",
        npx: {
          package: "agoragentic-mcp@1.3.0",
          args: ["--acp"],
        },
        iconUri: "https://cdn.agentclientprotocol.com/registry/v1/latest/agoragentic-acp.svg",
      },
      {
        id: "amp-acp",
        name: "Amp",
        binary: {
          "darwin-aarch64": {
            cmd: "./amp-acp",
          },
        },
      },
      {
        id: "auggie",
        npx: {
          env: {
            AUGMENT_DISABLE_AUTO_UPDATE: "1",
          },
        },
      },
    ]);
  });

  it("parses the documented flat entry shape and resolves relative icons", () => {
    const entries = parseAcpRegistry([
      {
        id: "example",
        name: "Example",
        description: "Example provider",
        version: "1.0.0",
        icon_path: "icon.svg",
        npx: {
          package: "example-acp@1.0.0",
        },
      },
    ]);

    expect(entries).toEqual([
      {
        id: "example",
        name: "Example",
        description: "Example provider",
        version: "1.0.0",
        iconUri:
          "https://raw.githubusercontent.com/agentclientprotocol/registry/main/example/icon.svg",
        npx: {
          package: "example-acp@1.0.0",
        },
      },
    ]);
  });

  it("maps an NPX registry entry to the daemon config patch", () => {
    const [entry] = parseAcpRegistry(readRegistryFixture());

    expect(buildAcpProviderConfigPatch(entry)).toEqual({
      providers: {
        "agoragentic-acp": {
          extends: "acp",
          label: "Agoragentic",
          description:
            "Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.",
          command: ["npx", "-y", "agoragentic-mcp@1.3.0", "--acp"],
          env: {},
        },
      },
    });
  });

  it("does not build an install patch for binary-only providers", () => {
    const [, binaryOnlyEntry] = parseAcpRegistry(readRegistryFixture());

    expect(() => buildAcpProviderConfigPatch(binaryOnlyEntry)).toThrow(
      "Provider amp-acp does not support NPX installation",
    );
  });
});
