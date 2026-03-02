import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLogConfig } from "./logger.js";
import type { PersistedConfig } from "./persisted-config.js";

describe("resolveLogConfig", () => {
  const originalEnv = process.env;
  const paseoHome = "/tmp/paseo-logger-tests";

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PASEO_LOG;
    delete process.env.PASEO_LOG_FORMAT;
    delete process.env.PASEO_LOG_CONSOLE_LEVEL;
    delete process.env.PASEO_LOG_FILE_LEVEL;
    delete process.env.PASEO_LOG_FILE_PATH;
    delete process.env.PASEO_LOG_FILE_ROTATE_SIZE;
    delete process.env.PASEO_LOG_FILE_ROTATE_COUNT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns dual-sink defaults when no config or env vars", () => {
    const result = resolveLogConfig(undefined, { paseoHome });
    expect(result).toEqual({
      level: "trace",
      console: {
        level: "info",
        format: "pretty",
      },
      file: {
        level: "trace",
        path: path.join(paseoHome, "daemon.log"),
        rotate: {
          maxSize: "10m",
          maxFiles: 2,
        },
      },
    });
  });

  it("uses config.json destination-specific values over defaults", () => {
    const config: PersistedConfig = {
      log: {
        console: {
          level: "warn",
          format: "json",
        },
        file: {
          level: "debug",
          path: "/tmp/custom.log",
          rotate: {
            maxSize: "25m",
            maxFiles: 5,
          },
        },
      },
    };
    const result = resolveLogConfig(config, { paseoHome });

    expect(result).toEqual({
      level: "debug",
      console: {
        level: "warn",
        format: "json",
      },
      file: {
        level: "debug",
        path: "/tmp/custom.log",
        rotate: {
          maxSize: "25m",
          maxFiles: 5,
        },
      },
    });
  });

  it("uses env vars over config.json values", () => {
    process.env.PASEO_LOG_CONSOLE_LEVEL = "error";
    process.env.PASEO_LOG_FILE_LEVEL = "fatal";
    process.env.PASEO_LOG_FORMAT = "json";
    process.env.PASEO_LOG_FILE_PATH = "logs/daemon-custom.log";
    process.env.PASEO_LOG_FILE_ROTATE_SIZE = "15m";
    process.env.PASEO_LOG_FILE_ROTATE_COUNT = "4";

    const config: PersistedConfig = {
      log: {
        console: {
          level: "info",
          format: "pretty",
        },
        file: {
          level: "trace",
          path: "/tmp/will-be-overridden.log",
          rotate: {
            maxSize: "30m",
            maxFiles: 8,
          },
        },
      },
    };

    const result = resolveLogConfig(config, { paseoHome });
    expect(result).toEqual({
      level: "error",
      console: {
        level: "error",
        format: "json",
      },
      file: {
        level: "fatal",
        path: path.resolve(paseoHome, "logs/daemon-custom.log"),
        rotate: {
          maxSize: "15m",
          maxFiles: 4,
        },
      },
    });
  });

  it("keeps backwards compatibility for legacy log.level and log.format", () => {
    const config: PersistedConfig = {
      log: {
        level: "warn",
        format: "json",
      },
    };

    const result = resolveLogConfig(config, { paseoHome });
    expect(result).toEqual({
      level: "warn",
      console: {
        level: "warn",
        format: "json",
      },
      file: {
        level: "warn",
        path: path.join(paseoHome, "daemon.log"),
        rotate: {
          maxSize: "10m",
          maxFiles: 2,
        },
      },
    });
  });

  it("keeps backwards compatibility for legacy env vars", () => {
    process.env.PASEO_LOG = "error";
    process.env.PASEO_LOG_FORMAT = "json";

    const result = resolveLogConfig(undefined, { paseoHome });
    expect(result).toEqual({
      level: "error",
      console: {
        level: "error",
        format: "json",
      },
      file: {
        level: "error",
        path: path.join(paseoHome, "daemon.log"),
        rotate: {
          maxSize: "10m",
          maxFiles: 2,
        },
      },
    });
  });

  it("supports partial destination config and retains defaults", () => {
    const config: PersistedConfig = {
      log: {
        console: {
          level: "warn",
        },
      },
    };

    const result = resolveLogConfig(config, { paseoHome });
    expect(result).toEqual({
      level: "trace",
      console: {
        level: "warn",
        format: "pretty",
      },
      file: {
        level: "trace",
        path: path.join(paseoHome, "daemon.log"),
        rotate: {
          maxSize: "10m",
          maxFiles: 2,
        },
      },
    });
  });

  it("ignores invalid rotate count env var and falls back to config value", () => {
    process.env.PASEO_LOG_FILE_ROTATE_COUNT = "0";
    const config: PersistedConfig = {
      log: {
        file: {
          rotate: {
            maxFiles: 7,
          },
        },
      },
    };

    const result = resolveLogConfig(config, { paseoHome });
    expect(result.file.rotate.maxFiles).toBe(7);
  });

  it("supports all log levels for destination-specific env vars", () => {
    const levels: Array<"trace" | "debug" | "info" | "warn" | "error" | "fatal"> = [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ];

    for (const level of levels) {
      process.env.PASEO_LOG_CONSOLE_LEVEL = level;
      process.env.PASEO_LOG_FILE_LEVEL = level;
      const result = resolveLogConfig(undefined, { paseoHome });
      expect(result.console.level).toBe(level);
      expect(result.file.level).toBe(level);
      expect(result.level).toBe(level);
    }
  });
});
