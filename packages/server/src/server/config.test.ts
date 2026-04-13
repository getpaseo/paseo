import { describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  test("defaults external codex relaunch command to codex", () => {
    const config = loadConfig("/tmp/paseo-config-test", {
      env: {},
    });

    expect(config.externalCodexRelaunchCommand).toEqual(undefined);
  });

  test("accepts a custom external codex relaunch executable from env", () => {
    const config = loadConfig("/tmp/paseo-config-test", {
      env: {
        PASEO_EXTERNAL_CODEX_RELAUNCH_COMMAND: "/usr/local/bin/codex-root-wrapper",
      },
    });

    expect(config.externalCodexRelaunchCommand).toEqual(["/usr/local/bin/codex-root-wrapper"]);
  });

  test("falls back to codex when relaunch executable env is blank", () => {
    const config = loadConfig("/tmp/paseo-config-test", {
      env: {
        PASEO_EXTERNAL_CODEX_RELAUNCH_COMMAND: "   ",
      },
    });

    expect(config.externalCodexRelaunchCommand).toEqual(["codex"]);
  });
});
