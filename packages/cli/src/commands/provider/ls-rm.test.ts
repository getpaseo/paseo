import { describe, expect, it } from "vitest";

import { render } from "../../output/index.js";
import { runLsCommand } from "./ls.js";
import { runRmCommand } from "./rm.js";

function createServerInfo() {
  return {
    status: "server_info",
    serverId: "test-daemon",
    features: { paseoAgentCatalog: true },
  };
}

describe("provider ls", () => {
  it("renders an empty configured-provider table with headers", async () => {
    const result = await runLsCommand({ host: "localhost:7777" }, {} as never, {
      connectDaemon: async () => ({
        waitForServerInfo: async () => createServerInfo(),
        getPaseoAgentCatalog: async () => ({
          requestId: "catalog-1",
          catalog: [],
          error: null,
        }),
        getPaseoAgentProviders: async () => ({
          requestId: "providers-1",
          defaultModel: null,
          providers: [],
          error: null,
        }),
        close: async () => {},
      }),
    });

    expect(result.data).toEqual([]);
    expect(render(result, { format: "table", noColor: true })).toContain("NAME");
    expect(render(result, { format: "json" })).toBe("[]");
  });

  it("lists configured model providers with catalog labels and auth states", async () => {
    const result = await runLsCommand({ host: "localhost:7777" }, {} as never, {
      connectDaemon: async (options) => {
        expect(options.host).toBe("localhost:7777");
        return {
          waitForServerInfo: async () => createServerInfo(),
          getPaseoAgentCatalog: async () => ({
            requestId: "catalog-1",
            catalog: [
              {
                id: "alpha-key",
                label: "Alpha Key",
                api: "test-api",
                baseUrl: "https://alpha.example.test",
                auth: { kind: "api_key", envVar: "ALPHA_API_KEY" },
                models: [{ id: "alpha-model" }],
              },
              {
                id: "beta-oauth",
                label: "Beta OAuth",
                api: "test-oauth-api",
                baseUrl: "https://beta.example.test",
                auth: { kind: "oauth", flow: "beta-flow" },
                models: [{ id: "beta-model" }],
              },
            ],
            error: null,
          }),
          getPaseoAgentProviders: async () => ({
            requestId: "providers-1",
            defaultModel: null,
            providers: [
              {
                name: "alpha-main",
                providerType: "alpha-key",
                models: [{ id: "alpha-model" }],
                auth: { kind: "api_key", configured: true, source: "literal" },
                available: true,
                error: null,
              },
              {
                name: "beta-main",
                providerType: "beta-oauth",
                models: [{ id: "beta-model" }],
                auth: { kind: "oauth", configured: false, hint: "sign in again" },
                available: false,
                error: "auth missing",
              },
              {
                name: "manual-main",
                providerType: "manual-type",
                models: [{ id: "manual-model" }],
                available: true,
                error: null,
              },
            ],
            error: null,
          }),
          close: async () => {},
        };
      },
    });

    expect(result.data).toEqual([
      {
        name: "alpha-main",
        providerType: "alpha-key",
        label: "Alpha Key",
        auth: "Connected",
        available: "yes",
        models: "alpha-model",
      },
      {
        name: "beta-main",
        providerType: "beta-oauth",
        label: "Beta OAuth",
        auth: "Needs attention",
        available: "no",
        models: "beta-model",
      },
      {
        name: "manual-main",
        providerType: "manual-type",
        label: "manual-type",
        auth: "not configured",
        available: "yes",
        models: "manual-model",
      },
    ]);

    const table = render(result, { format: "table", noColor: true });
    expect(table).toContain("Connected");
    expect(table).toContain("Needs attention");
    expect(table).toContain("not configured");
  });
});

describe("provider rm", () => {
  it("removes a configured model provider", async () => {
    const removedNames: string[] = [];

    const result = await runRmCommand("alpha-main", { host: "localhost:7777" }, {} as never, {
      connectDaemon: async (options) => {
        expect(options.host).toBe("localhost:7777");
        return {
          waitForServerInfo: async () => createServerInfo(),
          removePaseoAgentProvider: async (name: string) => {
            removedNames.push(name);
            return {
              requestId: "remove-1",
              success: true,
              removed: true,
              error: null,
            };
          },
          close: async () => {},
        };
      },
    });

    expect(removedNames).toEqual(["alpha-main"]);
    expect(result.data).toEqual({ name: "alpha-main", removed: "yes" });
  });
});
