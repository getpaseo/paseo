import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import {
  expectProviderInstalledInSettings,
  installAcpRegistryProvider,
  openAddProviderModal,
  openSettingsHost,
  serveJson,
} from "./helpers/settings";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const ACP_PROVIDER = {
  id: "paseo-e2e-acp",
  name: "Paseo E2E ACP",
};

function createAcpPackage(testInfo: { outputPath: (...pathSegments: string[]) => string }): string {
  const packageDir = testInfo.outputPath("acp-fixture-package");
  const binDir = path.join(packageDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: "paseo-e2e-acp-fixture",
        version: "0.0.1",
        bin: {
          "paseo-e2e-acp-fixture": "bin/acp-fixture.js",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(binDir, "acp-fixture.js"),
    `#!/usr/bin/env node
const readline = require("node:readline");

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: []
      });
      return;
    }
    if (message.method === "session/new") {
      send(message.id, {
        sessionId: "paseo-e2e-session",
        modes: {
          availableModes: [{ id: "default", name: "Default", description: null }],
          currentModeId: "default"
        },
        models: {
          availableModels: [{ modelId: "e2e-model", name: "E2E Model", description: null }],
          currentModelId: "e2e-model"
        },
        configOptions: []
      });
      return;
    }
    send(message.id, {});
  });
`,
    { mode: 0o755 },
  );
  return `file:${packageDir}`;
}

function createRegistryFixture(packageSpec: string) {
  return {
    version: "1.0.0",
    agents: [
      {
        ...ACP_PROVIDER,
        version: "0.0.1",
        description: "E2E ACP provider fixture",
        distribution: {
          npx: {
            package: packageSpec,
          },
        },
        icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg",
      },
      {
        id: "amp-acp",
        name: "Amp",
        version: "0.7.0",
        description: "ACP wrapper for Amp - the frontier coding agent",
        distribution: {
          binary: {
            "darwin-aarch64": {
              archive:
                "https://github.com/tao12345666333/amp-acp/releases/download/v0.7.0/amp-acp-darwin-aarch64.tar.gz",
              cmd: "./amp-acp",
            },
          },
        },
      },
    ],
  };
}

function getSeededServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

test.describe("ACP provider registry", () => {
  test("installs a registry provider from settings", async ({ page }, testInfo) => {
    const packageSpec = createAcpPackage(testInfo);
    await serveJson(page, ACP_REGISTRY_URL, createRegistryFixture(packageSpec));
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, getSeededServerId());
    await openAddProviderModal(page);

    await installAcpRegistryProvider(page, ACP_PROVIDER.name);
    await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
  });
});
