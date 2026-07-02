import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolPermissionPolicy } from "./agent-permissions.js";

import {
  type CreatePaseoAgentSessionOptions,
  type PaseoAgentModelProvider,
  createPaseoAgentSession,
} from "./pi-services.js";

const TEST_OAUTH_FLOW = "paseo-test-oauth";

function oauthModelProvider(): PaseoAgentModelProvider {
  return {
    name: "subscription",
    config: {
      baseUrl: "https://example.invalid/oauth",
      api: "openai-completions",
      models: [
        {
          id: "oauth-model",
          name: "OAuth Model",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  };
}

function registerTestOAuthProvider(): void {
  const provider: OAuthProviderInterface = {
    id: TEST_OAUTH_FLOW,
    name: "Paseo Test OAuth",
    async login(): Promise<OAuthCredentials> {
      return { access: "access-from-login", refresh: "refresh-from-login", expires: Date.now() };
    },
    async refreshToken(credentials): Promise<OAuthCredentials> {
      return {
        ...credentials,
        access: "access-from-refresh",
        expires: Date.now() + 60_000,
      };
    },
    getApiKey(credentials): string {
      return credentials.access;
    },
  };
  registerOAuthProvider(provider);
}

const FAKE_PROVIDER = "paseo-test-openrouter";
const FAKE_MODEL_ID = "test-model";

function toolCallContext(toolName: string): BeforeToolCallContext {
  return {
    assistantMessage: { role: "assistant", content: [] },
    toolCall: { type: "toolCall", id: "call-1", name: toolName, arguments: {} },
    args: {},
    context: {},
  } as BeforeToolCallContext;
}

function fakeModelProvider(): PaseoAgentModelProvider {
  return {
    name: FAKE_PROVIDER,
    config: {
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-in-memory-only",
      api: "openai-completions",
      models: [
        {
          id: FAKE_MODEL_ID,
          name: "Paseo Test Model",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  };
}

describe("createPaseoAgentSession (no-discovery spike)", () => {
  let cwd: string;
  let agentDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-"));
    agentDir = join(mkdtempSync(join(tmpdir(), "paseo-agent-dir-")), "agent");
    fakeHome = mkdtempSync(join(tmpdir(), "paseo-agent-home-"));
    // Redirect HOME so any accidental ~/.pi discovery would land in fakeHome and be detectable.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    resetOAuthProviders();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    for (const dir of [cwd, fakeHome, agentDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function baseOptions(): CreatePaseoAgentSessionOptions {
    return {
      cwd,
      agentDir,
      modelProviders: [fakeModelProvider()],
      model: { provider: FAKE_PROVIDER, id: FAKE_MODEL_ID },
    };
  }

  it("creates a session from an in-memory model provider and selects its model", async () => {
    const { session, modelRegistry } = await createPaseoAgentSession(baseOptions());

    expect(session).toBeDefined();
    expect(session.model?.provider).toBe(FAKE_PROVIDER);
    expect(session.model?.id).toBe(FAKE_MODEL_ID);
    // The in-memory model is the only one reachable with configured auth.
    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === FAKE_PROVIDER && m.id === FAKE_MODEL_ID)).toBe(
      true,
    );
  });

  it("performs no Pi resource discovery", async () => {
    const { resourceLoader } = await createPaseoAgentSession(baseOptions());

    expect(resourceLoader.getSkills().skills).toHaveLength(0);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(0);
    expect(resourceLoader.getPrompts().prompts).toHaveLength(0);
  });

  it("exposes composed prompts through the resource loader without discovery", async () => {
    const { resourceLoader } = await createPaseoAgentSession({
      ...baseOptions(),
      composedPrompt: {
        customPrompt: "Custom Paseo base prompt.",
        appendSystemPrompt: ["Profile append.", "Daemon append."],
      },
    });

    expect(resourceLoader.getSystemPrompt()).toBe("Custom Paseo base prompt.");
    expect(resourceLoader.getAppendSystemPrompt()).toEqual(["Profile append.", "Daemon append."]);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toHaveLength(0);
  });

  it("uses an in-memory session manager with no on-disk session file", async () => {
    const { sessionManager } = await createPaseoAgentSession(baseOptions());

    expect(sessionManager.getSessionFile()).toBeUndefined();
  });

  it("touches no ~/.pi config and writes nothing to the isolated agentDir", async () => {
    await createPaseoAgentSession(baseOptions());

    // No discovery against the redirected home directory: if Pi resolved its
    // default agentDir (~/.pi/agent) it would create or read it under fakeHome.
    expect(existsSync(join(fakeHome, ".pi"))).toBe(false);
    // Nothing persisted to the Paseo-owned isolated agentDir.
    const agentDirContents = existsSync(agentDir) ? readdirSync(agentDir) : [];
    expect(agentDirContents).toHaveLength(0);
    // No session/auth/model files leaked into the cwd either.
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("rejects a model that no model provider registered", async () => {
    await expect(
      createPaseoAgentSession({
        ...baseOptions(),
        modelProviders: [],
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("activates supplied custom tools alongside the built-in tools", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      customTools: [
        {
          name: "paseo__demo",
          label: "demo",
          description: "demo tool",
          parameters: { type: "object" } as never,
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: null };
          },
        },
      ],
    });

    const active = session.getActiveToolNames();
    expect(active).toContain("paseo__demo");
    // Built-in tools remain active too.
    expect(active).toContain("bash");
  });

  it("honors an explicit agent tool allowlist", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      tools: ["read", "paseo__demo"],
      customTools: [
        {
          name: "paseo__demo",
          label: "demo",
          description: "demo tool",
          parameters: { type: "object" } as never,
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: null };
          },
        },
      ],
    });

    expect(session.getActiveToolNames().sort()).toEqual(["paseo__demo", "read"]);
  });

  it("blocks a denied built-in tool through Pi's preflight hook", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      tools: ["bash"],
      permissionPolicy: createToolPermissionPolicy([{ tool: "bash", action: "deny" }]),
    });

    expect(session.getActiveToolNames()).toEqual(["bash"]);
    await expect(session.agent.beforeToolCall?.(toolCallContext("bash"))).resolves.toEqual({
      block: true,
      reason: 'Paseo Agent denied tool "bash" by agent permissions.',
    });
  });

  it("allows unmatched built-in tools to fall through the existing Pi hook", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      tools: ["bash"],
      permissionPolicy: createToolPermissionPolicy([{ tool: "read", action: "deny" }]),
    });

    await expect(session.agent.beforeToolCall?.(toolCallContext("bash"))).resolves.toBeUndefined();
  });

  it("blocks a denied custom tool through the same Pi preflight hook", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      tools: ["paseo__demo"],
      customTools: [
        {
          name: "paseo__demo",
          label: "demo",
          description: "demo tool",
          parameters: { type: "object" } as never,
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: null };
          },
        },
      ],
      permissionPolicy: createToolPermissionPolicy([{ tool: "paseo__*", action: "deny" }]),
    });

    expect(session.getActiveToolNames()).toEqual(["paseo__demo"]);
    await expect(session.agent.beforeToolCall?.(toolCallContext("paseo__demo"))).resolves.toEqual({
      block: true,
      reason: 'Paseo Agent denied tool "paseo__demo" by agent permissions.',
    });
  });

  it("registers an OAuth provider by flow and seeds the advanced refresh-token override", async () => {
    registerTestOAuthProvider();
    const oauthProvider = oauthModelProvider();
    const { session, modelRegistry } = await createPaseoAgentSession({
      cwd,
      agentDir,
      model: { provider: "subscription", id: "oauth-model" },
      modelProviders: [
        { ...oauthProvider, oauth: { flow: TEST_OAUTH_FLOW, refreshToken: "rt-test-only" } },
      ],
    });

    expect(session.model?.provider).toBe("subscription");
    expect(modelRegistry.find("subscription", "oauth-model")?.api).toBe("openai-completions");
    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === "subscription" && m.id === "oauth-model")).toBe(
      true,
    );
  });

  it("rejects an OAuth flow that Pi has not registered", async () => {
    await expect(
      createPaseoAgentSession({
        cwd,
        agentDir,
        model: { provider: "subscription", id: "oauth-model" },
        modelProviders: [{ ...oauthModelProvider(), oauth: { flow: "missing-flow" } }],
      }),
    ).rejects.toThrow(/OAuth flow "missing-flow" is not registered/);
  });

  it("loads an OAuth credential from a Paseo-owned AuthStorage", async () => {
    registerTestOAuthProvider();
    const authPath = join(mkdtempSync(join(tmpdir(), "paseo-agent-auth-")), "auth.json");
    const authStorage = AuthStorage.create(authPath);
    authStorage.set("subscription", {
      type: "oauth",
      access: "access-stored",
      refresh: "rt-stored",
      expires: Date.now() + 60_000,
    });

    const { modelRegistry } = await createPaseoAgentSession({
      cwd,
      agentDir,
      authStorage,
      model: { provider: "subscription", id: "oauth-model" },
      modelProviders: [{ ...oauthModelProvider(), oauth: { flow: TEST_OAUTH_FLOW } }],
    });

    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === "subscription" && m.id === "oauth-model")).toBe(
      true,
    );
    rmSync(authPath, { force: true });
  });
});
