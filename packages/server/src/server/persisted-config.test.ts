import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  loadConfigStack,
  loadPersistedConfig,
  PersistedConfigSchema,
  saveConfigStack,
  savePersistedConfig,
} from "./persisted-config.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-config-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("PersistedConfigSchema daemon auth config", () => {
  test("accepts optional daemon password hash", () => {
    const hash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        auth: { password: hash },
      },
    });

    expect(parsed.daemon?.auth?.password).toBe(hash);
  });
});

describe("PersistedConfigSchema daemon append system prompt config", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema daemon browser tools config", () => {
  test("accepts optional browser tools opt-in", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        browserTools: { enabled: true },
      },
    });

    expect(parsed.daemon?.browserTools?.enabled).toBe(true);
  });
});

describe("PersistedConfigSchema daemon relay config", () => {
  test("accepts optional relay TLS setting", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        relay: {
          enabled: true,
          endpoint: "relay.example.com:443",
          publicEndpoint: "public.example.com:443",
          useTls: true,
        },
      },
    });

    expect(parsed.daemon?.relay?.useTls).toBe(true);
  });
});

describe("PersistedConfigSchema daemon trusted proxy config", () => {
  test("accepts optional trusted proxy ranges", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: ["loopback", "172.16.0.0/12"],
      },
    });

    expect(parsed.daemon?.trustedProxies).toEqual(["loopback", "172.16.0.0/12"]);
  });

  test("accepts explicit trust-all proxy config", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: true,
      },
    });

    expect(parsed.daemon?.trustedProxies).toBe(true);
  });
});

describe("PersistedConfigSchema daemon web UI feature config", () => {
  test("accepts optional web UI enable flag and dist dir", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        webUi: {
          enabled: true,
          distDir: "web-ui-dist",
        },
      },
    });

    expect(parsed.features?.webUi).toEqual({
      enabled: true,
      distDir: "web-ui-dist",
    });
  });
});

describe("PersistedConfigSchema worktrees config", () => {
  test("accepts optional worktree root", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        root: "/mnt/fast/paseo-worktrees",
      },
    });

    expect(parsed.worktrees?.root).toBe("/mnt/fast/paseo-worktrees");
  });

  test("accepts service port allocation", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        servicePorts: { range: "3000-4000" },
      },
    });

    expect(parsed.worktrees?.servicePorts).toEqual({ range: "3000-4000" });
  });
});

describe("PersistedConfigSchema provider credentials", () => {
  test("accepts separate OpenAI STT and TTS credentials", () => {
    const parsed = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: {
            apiKey: " stt-secret ",
            baseUrl: " https://stt.example.com/v1 ",
          },
          tts: {
            apiKey: " tts-secret ",
            baseUrl: " https://tts.example.com/v1 ",
          },
        },
      },
    });

    expect(parsed.providers?.openai?.stt?.apiKey).toBe("stt-secret");
    expect(parsed.providers?.openai?.stt?.baseUrl).toBe("https://stt.example.com/v1");
    expect(parsed.providers?.openai?.tts?.apiKey).toBe("tts-secret");
    expect(parsed.providers?.openai?.tts?.baseUrl).toBe("https://tts.example.com/v1");
  });
});

describe("PersistedConfigSchema daemon append system prompt", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema agent provider runtime settings", () => {
  test("legacy append entries are skipped during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "append",
              args: ["--chrome"],
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({});
  });

  test("accepts provider command replace argv", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          codex: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "my-codex-wrapper"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.codex?.command).toEqual([
      "docker",
      "run",
      "--rm",
      "my-codex-wrapper",
    ]);
  });

  test("rejects replace command without argv", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          opencode: {
            command: {
              mode: "replace",
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("accepts metadata generation provider fallbacks", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        metadataGeneration: {
          providers: [
            { provider: "claude", model: "haiku" },
            { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
          ],
        },
      },
    });

    expect(parsed.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("accepts a custom provider catalog refresh timeout", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: { catalogRefreshTimeoutMs: 180_000 },
    });

    expect(parsed.agents?.catalogRefreshTimeoutMs).toBe(180_000);
  });

  test("rejects provider catalog refresh timeouts that overflow Node timers", () => {
    expect(() =>
      PersistedConfigSchema.parse({ agents: { catalogRefreshTimeoutMs: 2_147_483_648 } }),
    ).toThrow();
  });
});

describe("provider overrides (new format)", () => {
  test("override built-in provider with command and env", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: ["/opt/custom/claude"],
            env: {
              ANTHROPIC_API_KEY: "sk-test",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["/opt/custom/claude"],
      env: {
        ANTHROPIC_API_KEY: "sk-test",
      },
    });
  });

  test("new provider extending claude with label", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai).toEqual({
      extends: "claude",
      label: "ZAI",
    });
  });

  test("new provider extending acp with command", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
            command: ["my-agent", "--acp"],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.["my-agent"]).toEqual({
      extends: "acp",
      label: "My Agent",
      command: ["my-agent", "--acp"],
    });
  });

  test("enabled: false accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            enabled: false,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.enabled).toBe(false);
  });

  test("models array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            models: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.models).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("additionalModels array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            additionalModels: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.additionalModels).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("order field accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            order: 1,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.order).toBe(1);
  });

  test("new provider without extends → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("new provider without label → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends: acp without command → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends unknown provider → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "unknown",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("invalid provider ID format → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          ZAI: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("old format with mode: replace auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "claude"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["docker", "run", "--rm", "claude"],
    });
  });

  test("old format with mode: default auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({});
  });

  test("old format env preserved during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      env: {
        FOO: "bar",
      },
    });
  });

  test("mixed old and new format entries both work", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["custom-claude"],
            },
          },
          zai: {
            extends: "claude",
            label: "ZAI",
            command: ["zai"],
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({
      claude: {
        command: ["custom-claude"],
      },
      zai: {
        extends: "claude",
        label: "ZAI",
        command: ["zai"],
      },
    });
  });
});

describe("PersistedConfigSchema logging config", () => {
  test("accepts destination-specific logging config", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        console: {
          level: "info",
          format: "pretty",
        },
        file: {
          level: "trace",
          path: "daemon.log",
          rotate: {
            maxSize: "10m",
            maxFiles: 2,
          },
        },
      },
    });

    expect(parsed.log?.console?.level).toBe("info");
    expect(parsed.log?.file?.level).toBe("trace");
    expect(parsed.log?.file?.rotate?.maxFiles).toBe(2);
  });

  test("accepts legacy logging config fields", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        level: "debug",
        format: "json",
      },
    });

    expect(parsed.log?.level).toBe("debug");
    expect(parsed.log?.format).toBe("json");
  });

  test("rejects unknown logging config fields", () => {
    const result = PersistedConfigSchema.safeParse({
      log: {
        console: {
          level: "info",
          color: "red",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("PersistedConfigSchema voice mode config", () => {
  test("accepts a dedicated turn detection provider", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          turnDetection: {
            provider: "local",
          },
        },
      },
    });

    expect(parsed.features?.voiceMode?.turnDetection?.provider).toBe("local");
  });

  test("accepts trimmed STT language fields", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: " fr ",
          },
        },
        voiceMode: {
          stt: {
            language: " de ",
          },
        },
      },
    });

    expect(parsed.features?.dictation?.stt?.language).toBe("fr");
    expect(parsed.features?.voiceMode?.stt?.language).toBe("de");
  });
});

describe("loadPersistedConfig", () => {
  test("materializes relay disabled for a new Paseo home", () => {
    const home = createTempHome();
    try {
      const config = loadPersistedConfig(home);
      expect(config.daemon?.relay?.enabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("accepts the documented config schema marker", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://paseo.sh/schemas/paseo.config.v1.json",
            version: 1,
            daemon: {
              listen: "127.0.0.1:6767",
              hostnames: ["localhost", ".localhost"],
              mcp: { enabled: true },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.daemon?.listen).toBe("127.0.0.1:6767");
      expect(config.daemon?.hostnames).toEqual(["localhost", ".localhost"]);
      expect(config.daemon?.mcp?.enabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads a config that still uses the removed providers.openai.voice block", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            version: 1,
            providers: {
              openai: {
                apiKey: "global-key",
                voice: { apiKey: "voice-key", baseUrl: "https://voice.example.com/v1" },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.providers?.openai?.apiKey).toBe("global-key");
      expect((config.providers?.openai as Record<string, unknown>)?.voice).toBeUndefined();
      expect(config.providers?.openai?.stt).toBeUndefined();
      expect(config.providers?.openai?.tts).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preserves single-file save behavior without imports or writeTo", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    const config = {
      version: 1,
      daemon: {
        listen: "127.0.0.1:7000",
        relay: { enabled: true },
      },
    } as const;
    try {
      writeJson(configPath, config);

      savePersistedConfig(home, loadPersistedConfig(home));

      expect(readFileSync(configPath, "utf-8")).toBe(`${JSON.stringify(config, null, 2)}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flattens nested imports depth-first with later and local layers winning", () => {
    const home = createTempHome();
    const layersDir = path.join(home, "layers");
    mkdirSync(layersDir);
    const nestedPath = path.join(layersDir, "nested.json");
    const firstPath = path.join(layersDir, "first.json");
    const secondPath = path.join(layersDir, "second.json");
    const configPath = path.join(home, "config.json");
    try {
      writeJson(nestedPath, {
        daemon: {
          mcp: { enabled: true, injectIntoAgents: false },
          git: { maxProcessConcurrency: 2 },
          cors: { allowedOrigins: ["https://nested.example"] },
        },
      });
      writeJson(firstPath, {
        imports: ["nested.json"],
        daemon: {
          mcp: { injectIntoAgents: true },
          relay: { enabled: true },
        },
      });
      writeJson(secondPath, {
        daemon: {
          mcp: { enabled: false },
          git: { maxProcessConcurrency: 4 },
          cors: { allowedOrigins: ["https://second.example"] },
        },
      });
      writeJson(configPath, {
        version: 1,
        imports: ["layers/first.json", "layers/second.json"],
        daemon: { mcp: { injectIntoAgents: false } },
      });

      const stack = loadConfigStack(home);

      expect(stack.layers.map((layer) => layer.path)).toEqual([
        nestedPath,
        firstPath,
        secondPath,
        configPath,
      ]);
      expect(stack.effective.daemon).toEqual({
        mcp: { enabled: false, injectIntoAgents: false },
        git: { maxProcessConcurrency: 4 },
        cors: { allowedOrigins: ["https://second.example"] },
        relay: { enabled: true },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads a shared diamond import once without reapplying it over an importer", () => {
    const home = createTempHome();
    const sharedPath = path.join(home, "shared.json");
    const firstPath = path.join(home, "first.json");
    const secondPath = path.join(home, "second.json");
    const configPath = path.join(home, "config.json");
    try {
      writeJson(sharedPath, {
        daemon: {
          mcp: { enabled: true },
          git: { maxProcessConcurrency: 2 },
        },
      });
      writeJson(firstPath, {
        imports: ["shared.json"],
        daemon: { mcp: { enabled: false } },
      });
      writeJson(secondPath, {
        imports: ["shared.json"],
        daemon: { relay: { enabled: true } },
      });
      writeJson(configPath, {
        imports: ["first.json", "second.json"],
        writeTo: "shared.json",
      });

      const stack = loadConfigStack(home);

      expect(stack.layers.map((layer) => layer.path)).toEqual([
        sharedPath,
        firstPath,
        secondPath,
        configPath,
      ]);
      expect(stack.effective.daemon).toEqual({
        mcp: { enabled: false },
        git: { maxProcessConcurrency: 2 },
        relay: { enabled: true },
      });

      saveConfigStack(stack, {
        daemon: {
          mcp: { enabled: false },
          git: { maxProcessConcurrency: 8 },
          relay: { enabled: true },
        },
      });

      expect(readJson(sharedPath)).toEqual({
        daemon: { git: { maxProcessConcurrency: 8 } },
      });
      expect(loadPersistedConfig(home).daemon).toEqual({
        mcp: { enabled: false },
        git: { maxProcessConcurrency: 8 },
        relay: { enabled: true },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolves relative and home-relative import paths from the referencing file", () => {
    const home = createTempHome();
    const homeImportDir = mkdtempSync(path.join(homedir(), ".paseo-config-import-"));
    const homeImportPath = path.join(homeImportDir, "shared.json");
    const relativePath = path.join(home, "relative.json");
    try {
      const homeReference = `~/${path.relative(homedir(), homeImportPath)}`;
      writeJson(homeImportPath, {
        daemon: { git: { maxProcessesPerSecond: 12 } },
        app: { baseUrl: "https://shared.example" },
      });
      writeJson(relativePath, {
        imports: [homeReference],
        app: { baseUrl: "https://relative.example" },
      });
      writeJson(path.join(home, "config.json"), {
        imports: ["relative.json"],
        writeTo: homeReference,
      });

      const stack = loadConfigStack(home);
      expect(stack.writeTargetPath).toBe(homeImportPath);
      expect(stack.effective).toEqual({
        daemon: { git: { maxProcessesPerSecond: 12 } },
        app: { baseUrl: "https://relative.example" },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(homeImportDir, { recursive: true, force: true });
    }
  });

  test("reports missing imports with the importer and resolved path", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    const missingPath = path.join(home, "missing.json");
    try {
      writeJson(configPath, { imports: ["missing.json"] });

      expect(() => loadPersistedConfig(home)).toThrow(
        `Import ${missingPath} referenced by ${configPath} does not exist`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports import cycles with the complete cycle chain", () => {
    const home = createTempHome();
    const firstPath = path.join(home, "first.json");
    const secondPath = path.join(home, "second.json");
    try {
      writeJson(path.join(home, "config.json"), { imports: ["first.json"] });
      writeJson(firstPath, { imports: ["second.json"] });
      writeJson(secondPath, { imports: ["first.json"] });

      expect(() => loadPersistedConfig(home)).toThrow(
        `Config import cycle: ${firstPath} -> ${secondPath} -> ${firstPath}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects writeTo paths outside the import graph", () => {
    const home = createTempHome();
    const outsidePath = path.join(home, "outside.json");
    try {
      writeJson(outsidePath, {});
      writeJson(path.join(home, "config.json"), { writeTo: "outside.json" });

      expect(() => loadPersistedConfig(home)).toThrow(
        `resolves to ${outsidePath}, which is not the root config or an imported file`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects writeTo in an imported file", () => {
    const home = createTempHome();
    const importedPath = path.join(home, "imported.json");
    try {
      writeJson(path.join(home, "config.json"), { imports: ["imported.json"] });
      writeJson(importedPath, { writeTo: "imported.json" });

      expect(() => loadPersistedConfig(home)).toThrow(
        `Invalid config in ${importedPath}:\n  - writeTo: writeTo is only allowed in the root config file`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("persisted config file permissions", () => {
  test("initializes config.json with private permissions", () => {
    const home = createTempHome();
    try {
      loadPersistedConfig(home);

      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs permissive config.json permissions when loading", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(configPath, "{}\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(configPath, PERMISSIVE_FILE_MODE);

      loadPersistedConfig(home);

      expect(modeOf(configPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not change imported file permissions", () => {
    const home = createTempHome();
    const importedPath = path.join(home, "shared.json");
    try {
      writeFileSync(importedPath, "{}\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(importedPath, PERMISSIVE_FILE_MODE);
      writeJson(path.join(home, "config.json"), { imports: ["shared.json"] });

      loadPersistedConfig(home);

      expect(modeOf(importedPath)).toBe(PERMISSIVE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("saves config.json with private permissions", () => {
    const home = createTempHome();
    try {
      savePersistedConfig(home, {
        providers: {
          openai: {
            apiKey: "secret",
          },
        },
      });

      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
