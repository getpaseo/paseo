import { describe, expect, it } from "vitest";

import { render } from "../../output/index.js";
import { runAddCommand } from "./add.js";

interface CatalogEntry {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  auth: Record<string, unknown>;
  models: Array<{ id: string; label?: string; reasoning?: boolean }>;
}

interface RecordingClientInput {
  catalog: CatalogEntry[];
  features?: Record<string, unknown>;
  setProvider?: (input: {
    name: string;
    providerType: string;
    options: { apiKey?: string; models?: Array<{ id: string }> };
  }) => Promise<unknown>;
  startOAuth?: (
    name: string,
    options?: { mode?: string; requestId?: string } | string,
  ) => Promise<unknown>;
  completeOAuth?: (name: string) => Promise<unknown>;
  storeCredential?: (input: { name: string; credential: unknown }) => Promise<unknown>;
}

function createClient(input: RecordingClientInput) {
  return {
    waitForServerInfo: async () => ({
      status: "server_info",
      serverId: "test-daemon",
      features: input.features ?? { paseoAgentCatalog: true },
    }),
    getPaseoAgentCatalog: async () => ({
      requestId: "catalog-1",
      catalog: input.catalog,
      error: null,
    }),
    setPaseoAgentProvider: async (providerInput: {
      name: string;
      providerType: string;
      options: { apiKey?: string; models?: Array<{ id: string }> };
    }) => {
      if (input.setProvider) {
        return input.setProvider(providerInput);
      }
      return {
        requestId: "set-1",
        success: true,
        provider: {
          name: providerInput.name,
          providerType: providerInput.providerType,
          models: providerInput.options.models ?? [],
          auth: { kind: "api_key", configured: true, source: "literal" },
          available: true,
          error: null,
        },
        error: null,
      };
    },
    startPaseoAgentOAuth: async (
      name: string,
      options?: { mode?: string; requestId?: string } | string,
    ) =>
      input.startOAuth?.(name, options) ?? {
        requestId: "oauth-start-1",
        success: true,
        name,
        authorization: {
          kind: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example.test/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        },
        error: null,
      },
    completePaseoAgentOAuth: async (name: string) =>
      input.completeOAuth?.(name) ?? {
        requestId: "oauth-complete-1",
        success: true,
        name,
        auth: { kind: "oauth", configured: true, source: "stored" },
        error: null,
      },
    storePaseoAgentOAuthCredential: async (credentialInput: {
      name: string;
      credential: unknown;
    }) =>
      input.storeCredential?.(credentialInput) ?? {
        requestId: "oauth-store-1",
        success: true,
        name: credentialInput.name,
        auth: { kind: "oauth", configured: true, source: "stored" },
        error: null,
      },
    close: async () => {},
  };
}

function apiKeyEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "alpha-key",
    label: "Alpha Key",
    api: "test-api",
    baseUrl: "https://alpha.example.test",
    auth: {
      kind: "api_key",
      envVar: "ALPHA_API_KEY",
      hint: "Create an Alpha key before continuing.",
      keyUrl: "https://alpha.example.test/keys",
      placeholder: "Alpha API key",
    },
    models: [{ id: "alpha-model", label: "Alpha Model", reasoning: true }],
    ...overrides,
  };
}

function oauthEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "beta-oauth",
    label: "Beta OAuth",
    api: "test-oauth-api",
    baseUrl: "https://beta.example.test",
    auth: { kind: "oauth", flow: "beta-flow" },
    models: [{ id: "beta-model" }],
    ...overrides,
  };
}

describe("provider add", () => {
  it("configures an API-key provider from a hidden prompt without echoing the key", async () => {
    const setCalls: unknown[] = [];
    const prompts: string[] = [];
    const output: string[] = [];
    const result = await runAddCommand(
      "alpha-key",
      { host: "localhost:7777", name: "alpha-main" },
      {} as never,
      {
        write: (message) => output.push(message),
        promptSecret: async (message) => {
          prompts.push(message);
          return "redaction-sentinel";
        },
        promptText: async () => {
          throw new Error("text prompt should not be used");
        },
        readStdin: async () => {
          throw new Error("stdin should not be read");
        },
        connectDaemon: async (options) => {
          expect(options.host).toBe("localhost:7777");
          return createClient({
            catalog: [apiKeyEntry()],
            setProvider: async (input) => {
              setCalls.push(input);
              return {
                requestId: "set-1",
                success: true,
                provider: {
                  name: input.name,
                  providerType: input.providerType,
                  models: input.options.models ?? [],
                  auth: { kind: "api_key", configured: true, source: "literal" },
                  available: true,
                  error: null,
                },
                error: null,
              };
            },
          });
        },
      },
    );

    expect(setCalls).toEqual([
      {
        name: "alpha-main",
        providerType: "alpha-key",
        options: {
          apiKey: "redaction-sentinel",
          models: [{ id: "alpha-model", label: "Alpha Model", reasoning: true }],
        },
      },
    ]);
    expect(prompts).toEqual(["Enter Alpha API key (leave empty to use $ALPHA_API_KEY):"]);
    expect(output.join("\n")).toContain("Create an Alpha key");
    expect(output.join("\n")).toContain("https://alpha.example.test/keys");
    expect(render(result, { format: "json" })).not.toContain("redaction-sentinel");
    expect(render(result, { format: "table", noColor: true })).toContain("alpha-main");
  });

  it("stores an environment reference when the API-key prompt is empty", async () => {
    const setCalls: unknown[] = [];
    const result = await runAddCommand("alpha-key", {}, {} as never, {
      promptSecret: async () => "",
      promptText: async () => {
        throw new Error("text prompt should not be used");
      },
      readStdin: async () => {
        throw new Error("stdin should not be read");
      },
      write: () => {},
      connectDaemon: async () =>
        createClient({
          catalog: [apiKeyEntry()],
          setProvider: async (input) => {
            setCalls.push(input);
            return {
              requestId: "set-1",
              success: true,
              provider: {
                name: input.name,
                providerType: input.providerType,
                models: input.options.models ?? [],
                auth: { kind: "api_key", configured: false, source: "env" },
                available: false,
                error: null,
              },
              error: null,
            };
          },
        }),
    });

    expect(setCalls).toEqual([
      {
        name: "alpha-key",
        providerType: "alpha-key",
        options: {
          apiKey: "$ALPHA_API_KEY",
          models: [{ id: "alpha-model", label: "Alpha Model", reasoning: true }],
        },
      },
    ]);
    expect(result.data.auth).toBe("Needs attention");
  });

  it("reads an API key from stdin for scripts", async () => {
    const setCalls: unknown[] = [];

    await runAddCommand("alpha-key", { apiKeyStdin: true, model: ["one,two"] }, {} as never, {
      readStdin: async () => "stdin-secret\n",
      promptSecret: async () => {
        throw new Error("prompt should not be used with --api-key-stdin");
      },
      promptText: async () => {
        throw new Error("text prompt should not be used");
      },
      write: () => {},
      connectDaemon: async () =>
        createClient({
          catalog: [apiKeyEntry({ models: [] })],
          setProvider: async (input) => {
            setCalls.push(input);
            return {
              requestId: "set-1",
              success: true,
              provider: {
                name: input.name,
                providerType: input.providerType,
                models: input.options.models ?? [],
                auth: { kind: "api_key", configured: true, source: "literal" },
                available: true,
                error: null,
              },
              error: null,
            };
          },
        }),
    });

    expect(setCalls).toEqual([
      {
        name: "alpha-key",
        providerType: "alpha-key",
        options: {
          apiKey: "stdin-secret",
          models: [{ id: "one" }, { id: "two" }],
        },
      },
    ]);
  });

  it("configures an API-key provider without model defaults", async () => {
    const setCalls: unknown[] = [];

    const result = await runAddCommand("alpha-key", { apiKeyStdin: true }, {} as never, {
      readStdin: async () => "stdin-secret\n",
      promptSecret: async () => {
        throw new Error("prompt should not be used with --api-key-stdin");
      },
      promptText: async () => {
        throw new Error("text prompt should not be used");
      },
      write: () => {},
      connectDaemon: async () =>
        createClient({
          catalog: [apiKeyEntry({ models: [] })],
          setProvider: async (input) => {
            setCalls.push(input);
            return {
              requestId: "set-1",
              success: true,
              provider: {
                name: input.name,
                providerType: input.providerType,
                models: [],
                auth: { kind: "api_key", configured: true, source: "literal" },
                available: true,
                error: null,
              },
              error: null,
            };
          },
        }),
    });

    expect(setCalls).toEqual([
      {
        name: "alpha-key",
        providerType: "alpha-key",
        options: {
          apiKey: "stdin-secret",
        },
      },
    ]);
    expect(result.data).toMatchObject({
      name: "alpha-key",
      auth: "Connected",
      available: "yes",
      models: "-",
    });
  });

  it("runs browser OAuth locally and pushes the credential to the selected daemon", async () => {
    const order: string[] = [];
    const stored: unknown[] = [];
    const openedUrls: string[] = [];

    const result = await runAddCommand(
      "beta-oauth",
      { host: "tcp://remote:7777?ssl=true&password=secret", name: "beta-main" },
      {} as never,
      {
        write: (message) => order.push(`write:${message}`),
        openBrowser: (url) => {
          openedUrls.push(url);
          return true;
        },
        loginBrowserCredential: async (options) => {
          expect(options.flow).toBe("beta-flow");
          order.push("browser-login");
          options.onAuthUrl("https://auth.example.test/browser", "Authorize in the browser.");
          return { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 123 };
        },
        promptText: async () => {
          throw new Error("manual prompt should not be used");
        },
        promptSecret: async () => {
          throw new Error("secret prompt should not be used");
        },
        readStdin: async () => {
          throw new Error("stdin should not be read");
        },
        connectDaemon: async () =>
          createClient({
            catalog: [oauthEntry()],
            setProvider: async (input) => {
              order.push("set-provider");
              return {
                requestId: "set-1",
                success: true,
                provider: {
                  name: input.name,
                  providerType: input.providerType,
                  models: input.options.models ?? [],
                  auth: { kind: "oauth", configured: false },
                  available: false,
                  error: null,
                },
                error: null,
              };
            },
            storeCredential: async (input) => {
              stored.push(input);
              return {
                requestId: "store-1",
                success: true,
                name: input.name,
                auth: { kind: "oauth", configured: true, source: "stored" },
                error: null,
              };
            },
          }),
      },
    );

    expect(order).toEqual([
      "set-provider",
      "browser-login",
      "write:Authorize in the browser.",
      "write:  https://auth.example.test/browser",
      "write:Waiting for you to approve in the browser...",
      "write:Credential accepted by selected daemon (tcp://remote:7777?ssl=true).",
    ]);
    expect(stored).toEqual([
      {
        name: "beta-main",
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
    expect(openedUrls).toEqual(["https://auth.example.test/browser"]);
    expect(result.data.auth).toBe("Connected");
    expect(order.join("\n")).not.toContain("secret");
  });

  it("uses daemon-run OAuth when --device-code is passed", async () => {
    const output: string[] = [];
    const oauthCalls: string[] = [];

    const result = await runAddCommand("beta-oauth", { deviceCode: true }, {} as never, {
      write: (message) => output.push(message),
      openBrowser: () => {
        throw new Error("browser should not be opened for --device-code");
      },
      loginBrowserCredential: async () => {
        throw new Error("browser login should not run for --device-code");
      },
      promptText: async () => {
        throw new Error("prompt should not be used");
      },
      promptSecret: async () => {
        throw new Error("secret prompt should not be used");
      },
      readStdin: async () => {
        throw new Error("stdin should not be read");
      },
      connectDaemon: async () =>
        createClient({
          catalog: [oauthEntry()],
          startOAuth: async (name, options) => {
            oauthCalls.push(
              `start:${name}:${typeof options === "string" ? options : options?.mode}`,
            );
            return {
              requestId: "start-1",
              success: true,
              name,
              authorization: {
                kind: "device_code",
                userCode: "ABCD-EFGH",
                verificationUri: "https://auth.example.test/device",
                expiresInSeconds: 900,
              },
              error: null,
            };
          },
          completeOAuth: async (name) => {
            oauthCalls.push(`complete:${name}`);
            return {
              requestId: "complete-1",
              success: true,
              name,
              auth: { kind: "oauth", configured: true, source: "stored" },
              error: null,
            };
          },
        }),
    });

    expect(oauthCalls).toEqual(["start:beta-oauth:device_code", "complete:beta-oauth"]);
    expect(output.join("\n")).toContain("ABCD-EFGH");
    expect(output.join("\n")).toContain("https://auth.example.test/device");
    expect(result.data.auth).toBe("Connected");
  });

  it("falls back to daemon-run OAuth when the browser cannot open", async () => {
    const output: string[] = [];
    const oauthCalls: string[] = [];

    await runAddCommand("beta-oauth", {}, {} as never, {
      write: (message) => output.push(message),
      openBrowser: () => false,
      loginBrowserCredential: async (options) => {
        options.onAuthUrl("https://auth.example.test/browser");
        throw new Error("onAuthUrl should have switched to device-code");
      },
      promptText: async () => {
        throw new Error("prompt should not be used");
      },
      promptSecret: async () => {
        throw new Error("secret prompt should not be used");
      },
      readStdin: async () => {
        throw new Error("stdin should not be read");
      },
      connectDaemon: async () =>
        createClient({
          catalog: [oauthEntry()],
          startOAuth: async (name, options) => {
            oauthCalls.push(
              `start:${name}:${typeof options === "string" ? options : options?.mode}`,
            );
            return {
              requestId: "start-1",
              success: true,
              name,
              authorization: {
                kind: "device_code",
                userCode: "WXYZ-1234",
                verificationUri: "https://auth.example.test/device",
              },
              error: null,
            };
          },
          completeOAuth: async (name) => {
            oauthCalls.push(`complete:${name}`);
            return {
              requestId: "complete-1",
              success: true,
              name,
              auth: { kind: "oauth", configured: true, source: "stored" },
              error: null,
            };
          },
        }),
    });

    expect(oauthCalls).toEqual(["start:beta-oauth:device_code", "complete:beta-oauth"]);
    expect(output.join("\n")).toContain("Browser could not be opened");
    expect(output.join("\n")).toContain("WXYZ-1234");
  });

  it("updates the same instance on repeated add calls", async () => {
    const setCalls: unknown[] = [];
    const client = createClient({
      catalog: [apiKeyEntry()],
      setProvider: async (input) => {
        setCalls.push(input);
        return {
          requestId: "set-1",
          success: true,
          provider: {
            name: input.name,
            providerType: input.providerType,
            models: input.options.models ?? [],
            auth: { kind: "api_key", configured: true, source: "literal" },
            available: true,
            error: null,
          },
          error: null,
        };
      },
    });
    const dependencies = {
      promptSecret: async () => "secret",
      promptText: async () => {
        throw new Error("text prompt should not be used");
      },
      readStdin: async () => {
        throw new Error("stdin should not be read");
      },
      write: () => {},
      connectDaemon: async () => client,
    };

    await runAddCommand("alpha-key", { name: "same-name" }, {} as never, dependencies);
    await runAddCommand("alpha-key", { name: "same-name" }, {} as never, dependencies);

    expect(setCalls).toHaveLength(2);
    expect(setCalls).toEqual([
      expect.objectContaining({ name: "same-name", providerType: "alpha-key" }),
      expect.objectContaining({ name: "same-name", providerType: "alpha-key" }),
    ]);
  });

  it("mentions known provider ids for an unknown catalog id", async () => {
    await expect(
      runAddCommand("missing-key", {}, {} as never, {
        promptSecret: async () => {
          throw new Error("prompt should not run");
        },
        promptText: async () => {
          throw new Error("text prompt should not run");
        },
        readStdin: async () => {
          throw new Error("stdin should not run");
        },
        write: () => {},
        connectDaemon: async () =>
          createClient({
            catalog: [apiKeyEntry({ id: "alpha-key" }), apiKeyEntry({ id: "gamma-key" })],
            setProvider: async () => {
              throw new Error("set should not run");
            },
          }),
      }),
    ).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER",
      message:
        'Unknown model provider type "missing-key". Known provider ids: alpha-key, gamma-key.',
    });
  });

  it("requires the catalog feature flag before reading the catalog", async () => {
    const calls: string[] = [];

    await expect(
      runAddCommand("alpha-key", {}, {} as never, {
        promptSecret: async () => {
          throw new Error("prompt should not run");
        },
        promptText: async () => {
          throw new Error("text prompt should not run");
        },
        readStdin: async () => {
          throw new Error("stdin should not run");
        },
        write: () => {},
        connectDaemon: async () => ({
          waitForServerInfo: async () => ({
            status: "server_info",
            serverId: "test-daemon",
            features: {},
          }),
          getPaseoAgentCatalog: async () => {
            calls.push("catalog");
            throw new Error("catalog should not be read");
          },
          setPaseoAgentProvider: async () => {
            calls.push("set");
            throw new Error("set should not run");
          },
          startPaseoAgentOAuth: async () => {
            throw new Error("oauth should not run");
          },
          completePaseoAgentOAuth: async () => {
            throw new Error("oauth should not run");
          },
          storePaseoAgentOAuthCredential: async () => {
            throw new Error("oauth should not run");
          },
          close: async () => {},
        }),
      }),
    ).rejects.toMatchObject({
      code: "HOST_UPDATE_REQUIRED",
      message: "Update the Paseo daemon to use this command.",
    });

    expect(calls).toEqual([]);
  });

  it("lets the user choose a provider when no id is passed", async () => {
    const setCalls: unknown[] = [];
    const output: string[] = [];

    await runAddCommand(undefined, {}, {} as never, {
      write: (message) => output.push(message),
      promptText: async (message) => {
        expect(message).toBe("Select provider:");
        return "2";
      },
      promptSecret: async () => "chosen-secret",
      readStdin: async () => {
        throw new Error("stdin should not be read");
      },
      connectDaemon: async () =>
        createClient({
          catalog: [
            apiKeyEntry({ id: "first-key", label: "First Key" }),
            apiKeyEntry({ id: "second-key", label: "Second Key" }),
          ],
          setProvider: async (input) => {
            setCalls.push(input);
            return {
              requestId: "set-1",
              success: true,
              provider: {
                name: input.name,
                providerType: input.providerType,
                models: input.options.models ?? [],
                auth: { kind: "api_key", configured: true, source: "literal" },
                available: true,
                error: null,
              },
              error: null,
            };
          },
        }),
    });

    expect(output.join("\n")).toContain("First Key (first-key)");
    expect(output.join("\n")).toContain("Second Key (second-key)");
    expect(setCalls).toEqual([
      expect.objectContaining({ name: "second-key", providerType: "second-key" }),
    ]);
  });
});
