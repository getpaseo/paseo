import { describe, expect, test } from "vitest";

import { buildProviderCommand } from "@/utils/provider-command-templates";

describe("buildProviderCommand", () => {
  test("resumes a custom Codex profile with its configured command and environment", () => {
    expect(
      buildProviderCommand({
        provider: "codex-agentplan",
        id: "resume",
        sessionId: "native-codex-session",
        providers: {
          "codex-agentplan": {
            extends: "codex",
            command: ["codex", "--config", 'model_provider="paseo-agent-plan"'],
            env: { AI_PROXY_TAGS: "agent-plan" },
          },
        },
      }),
    ).toBe(
      "env -- AI_PROXY_TAGS=agent-plan codex --config 'model_provider=\"paseo-agent-plan\"' resume native-codex-session",
    );
  });

  test("builds Hermes resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "hermes",
        id: "resume",
        sessionId: "20260813_111500_abc123",
      }),
    ).toBe("hermes --resume 20260813_111500_abc123");
  });

  test("builds OpenCode resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });

  test("retains a selfhosted OpenCode preset and inherits the base environment", () => {
    expect(
      buildProviderCommand({
        provider: "guomo-lite-glm-selfhosted",
        id: "resume",
        sessionId: "ses_abc123",
        providers: {
          opencode: {
            env: { OPENCODE_BASE_URL: "https://proxy.example/v1", MODEL_ROUTE: "default" },
          },
          "guomo-lite-glm-selfhosted": {
            extends: "opencode",
            env: {
              OH_MY_OPENCODE_SLIM_PRESET: "guomo-lite-glm-selfhosted",
              MODEL_ROUTE: "selfhosted",
            },
          },
        },
      }),
    ).toBe(
      "env -- OH_MY_OPENCODE_SLIM_PRESET=guomo-lite-glm-selfhosted MODEL_ROUTE=selfhosted OPENCODE_BASE_URL=https://proxy.example/v1 opencode --session ses_abc123",
    );
  });

  test("retains an inherited binary prefix and quotes paths, values and session ids", () => {
    expect(
      buildProviderCommand({
        provider: "work-codex",
        id: "resume",
        sessionId: "session with spaces",
        providers: {
          codex: {
            command: ["/opt/Codex Preview/codex", "--config", 'model_provider="work"'],
            env: { MODEL_DESCRIPTION: "Yanick's $HOME" },
          },
          "work-codex": { extends: "codex" },
        },
      }),
    ).toBe(
      "env -- 'MODEL_DESCRIPTION=Yanick'\"'\"'s $HOME' '/opt/Codex Preview/codex' --config 'model_provider=\"work\"' resume 'session with spaces'",
    );
  });

  test.each([
    {
      provider: "work-codex",
      providers: { "work-codex": { extends: "codex", env: { MODEL_ROUTE: "work" } } },
      cwd: "C:\\workspace\\project",
    },
    { provider: "unknown", providers: {}, cwd: "/workspace" },
    { provider: "custom-acp", providers: { "custom-acp": { extends: "acp" } }, cwd: "/workspace" },
    {
      provider: "first",
      providers: { first: { extends: "second" }, second: { extends: "first" } },
      cwd: "/workspace",
    },
  ])(
    "rejects unsupported or cyclic provider inheritance: $provider",
    ({ provider, providers, cwd }) => {
      expect(
        buildProviderCommand({ provider, providers, cwd, id: "resume", sessionId: "native-id" }),
      ).toBeNull();
    },
  );
});
