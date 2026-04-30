import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "./persisted-config.js";

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
});
