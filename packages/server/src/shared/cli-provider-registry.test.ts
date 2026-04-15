import { describe, expect, test } from "vitest";
import {
  CLI_PROVIDER_IDS,
  CLI_PROVIDERS,
  buildCliAgentArgs,
  getCliProvider,
  getCliProviderInstallCommand,
  isValidCliProviderId,
  listDetectableCliProviders,
  listCliProviders,
  type CliProviderId,
} from "./cli-provider-registry.js";

describe("CLI Provider Registry", () => {
  test("CLI_PROVIDER_IDS has at least 20 providers", () => {
    expect(CLI_PROVIDER_IDS.length).toBeGreaterThanOrEqual(20);
  });

  test("CLI_PROVIDERS matches CLI_PROVIDER_IDS count", () => {
    expect(CLI_PROVIDERS.length).toBe(CLI_PROVIDER_IDS.length);
  });

  test("every provider has a unique id", () => {
    const ids = CLI_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every provider id is in CLI_PROVIDER_IDS", () => {
    for (const provider of CLI_PROVIDERS) {
      expect(CLI_PROVIDER_IDS).toContain(provider.id);
    }
  });

  test("every provider has a name", () => {
    for (const provider of CLI_PROVIDERS) {
      expect(provider.name).toBeTruthy();
    }
  });

  describe("getCliProvider", () => {
    test("returns provider for valid id", () => {
      const claude = getCliProvider("claude");
      expect(claude).toBeDefined();
      expect(claude?.name).toBe("Claude Code");
      expect(claude?.cli).toBe("claude");
    });

    test("returns codex provider", () => {
      const codex = getCliProvider("codex");
      expect(codex).toBeDefined();
      expect(codex?.name).toBe("Codex");
      expect(codex?.autoApproveFlag).toBe("--full-auto");
    });

    test("returns undefined for invalid id", () => {
      expect(getCliProvider("nonexistent" as CliProviderId)).toBeUndefined();
    });
  });

  describe("getCliProviderInstallCommand", () => {
    test("returns install command for claude", () => {
      const cmd = getCliProviderInstallCommand("claude");
      expect(cmd).toContain("claude.ai/install.sh");
    });

    test("returns npm command for codex", () => {
      const cmd = getCliProviderInstallCommand("codex");
      expect(cmd).toContain("@openai/codex");
    });

    test("returns null for unknown provider", () => {
      expect(getCliProviderInstallCommand("nonexistent" as CliProviderId)).toBeNull();
    });
  });

  describe("isValidCliProviderId", () => {
    test("returns true for valid ids", () => {
      expect(isValidCliProviderId("claude")).toBe(true);
      expect(isValidCliProviderId("codex")).toBe(true);
      expect(isValidCliProviderId("gemini")).toBe(true);
      expect(isValidCliProviderId("cursor")).toBe(true);
    });

    test("returns false for invalid values", () => {
      expect(isValidCliProviderId("nonexistent")).toBe(false);
      expect(isValidCliProviderId(123)).toBe(false);
      expect(isValidCliProviderId(null)).toBe(false);
      expect(isValidCliProviderId(undefined)).toBe(false);
    });
  });

  describe("listDetectableCliProviders", () => {
    test("returns only providers with commands and detectable !== false", () => {
      const detectable = listDetectableCliProviders();
      for (const provider of detectable) {
        expect(provider.commands?.length).toBeGreaterThan(0);
        expect(provider.detectable).not.toBe(false);
      }
    });

    test("does not include goose (detectable: false)", () => {
      const detectable = listDetectableCliProviders();
      const goose = detectable.find((p) => p.id === "goose");
      expect(goose).toBeUndefined();
    });

    test("includes claude (detectable by default)", () => {
      const detectable = listDetectableCliProviders();
      const claude = detectable.find((p) => p.id === "claude");
      expect(claude).toBeDefined();
    });

    test("includes enabled custom providers from overrides", () => {
      const detectable = listDetectableCliProviders({
        "my-agent": {
          name: "My Agent",
          command: "my-agent",
        },
      });

      expect(detectable.some((provider) => provider.id === "my-agent")).toBe(true);
    });

    test("does not include disabled providers in active lists", () => {
      const detectable = listDetectableCliProviders({
        codex: {
          enabled: false,
        },
      });

      expect(detectable.some((provider) => provider.id === "codex")).toBe(false);
    });
  });

  describe("provider definitions", () => {
    test("claude has session ID flag", () => {
      const claude = getCliProvider("claude");
      expect(claude?.sessionIdFlag).toBe("--session-id");
    });

    test("providers with auto-approve have the correct flags", () => {
      const cases: Array<[CliProviderId, string]> = [
        ["claude", "--dangerously-skip-permissions"],
        ["codex", "--full-auto"],
        ["cursor", "-f"],
        ["gemini", "--yolo"],
        ["copilot", "--allow-all-tools"],
        ["amp", "--dangerously-allow-all"],
        ["mistral", "--auto-approve"],
      ];

      for (const [id, expectedFlag] of cases) {
        const provider = getCliProvider(id);
        expect(provider?.autoApproveFlag).toBe(expectedFlag);
      }
    });

    test("providers with keystroke injection are flagged correctly", () => {
      const keystrokeProviders = CLI_PROVIDERS.filter((p) => p.useKeystrokeInjection);
      expect(keystrokeProviders.length).toBeGreaterThan(0);
      for (const p of keystrokeProviders) {
        expect(["amp", "opencode", "hermes"]).toContain(p.id);
      }
    });

    test("all providers are terminal-only", () => {
      for (const provider of CLI_PROVIDERS) {
        expect(provider.terminalOnly).toBe(true);
      }
    });

    test("lists disabled custom providers when requested", () => {
      const providers = listCliProviders({
        includeDisabled: true,
        overrides: {
          "my-agent": {
            name: "My Agent",
            command: "my-agent",
            enabled: false,
          },
        },
      });

      expect(providers.find((provider) => provider.id === "my-agent")?.name).toBe("My Agent");
    });

    test("buildCliAgentArgs uses custom provider overrides", () => {
      const args = buildCliAgentArgs(
        {
          providerId: "my-agent",
          initialPrompt: "fix this",
          autoApprove: true,
          resume: true,
        },
        {
          "my-agent": {
            name: "My Agent",
            command: "my-agent",
            autoApproveFlag: "--yes",
            initialPromptFlag: "",
            resumeFlag: "--resume",
          },
        },
      );

      expect(args).toEqual(["--resume", "--yes", "fix this"]);
    });
  });
});
