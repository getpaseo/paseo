import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "./persisted-config.js";

describe("PersistedConfigSchema agent provider runtime settings", () => {
  test("accepts provider command append args and env", () => {
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

    expect(parsed.agents?.providers?.claude?.command?.mode).toBe("append");
    expect(parsed.agents?.providers?.claude?.env?.FOO).toBe("bar");
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

    expect(parsed.agents?.providers?.codex?.command?.mode).toBe("replace");
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
