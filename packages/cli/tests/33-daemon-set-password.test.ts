#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { isBearerTokenValid } from "@hubcode/server";
import {
  runSetPasswordCommand,
  setDaemonPasswordInConfig,
  type PromptPassword,
} from "../src/commands/daemon/set-password.ts";

console.log("=== Daemon Set Password Command ===\n");

const root = await mkdtemp(join(tmpdir(), "hubcode-set-password-"));
const hubcodeHome = join(root, ".hubcode");

function promptSequence(values: string[]): PromptPassword {
  return async () => {
    const value = values.shift();
    if (value === undefined) {
      throw new Error("prompt called too many times");
    }
    return value;
  };
}

try {
  {
    console.log("Test 1: setDaemonPasswordInConfig writes hash and preserves config fields");
    await mkdir(hubcodeHome, { recursive: true });
    await writeFile(
      join(hubcodeHome, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          daemon: {
            listen: "127.0.0.1:9999",
            relay: { enabled: false },
          },
          app: { baseUrl: "https://app.hubcode.ai" },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setDaemonPasswordInConfig("shared-secret", { home: hubcodeHome });
    const config = JSON.parse(await readFile(join(hubcodeHome, "config.json"), "utf-8"));

    assert.strictEqual(result.configPath, join(hubcodeHome, "config.json"));
    assert.strictEqual(result.restartCommand, "hubcode daemon restart");
    assert.strictEqual(config.daemon.listen, "127.0.0.1:9999");
    assert.strictEqual(config.daemon.relay.enabled, false);
    assert.notStrictEqual(config.daemon.auth.password, "shared-secret");
    assert.match(config.daemon.auth.password, /^\$2[aby]\$12\$/);
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "shared-secret" }),
      true,
    );
    console.log("✓ set-password writes bcrypt hash without clobbering config\n");
  }

  {
    console.log("Test 2: command prompts twice and accepts matching confirmation");
    const result = await runSetPasswordCommand(
      {
        home: hubcodeHome,
        promptPassword: promptSequence(["new-secret", "new-secret"]),
      },
      {} as Command,
    );
    const config = JSON.parse(await readFile(join(hubcodeHome, "config.json"), "utf-8"));

    assert.strictEqual(result.data.action, "password_set");
    assert.strictEqual(
      isBearerTokenValid({ password: config.daemon.auth.password, token: "new-secret" }),
      true,
    );
    console.log("✓ command accepts matching confirmation\n");
  }

  {
    console.log("Test 3: command refuses mismatched confirmation");
    await assert.rejects(
      runSetPasswordCommand(
        {
          home: hubcodeHome,
          promptPassword: promptSequence(["first-secret", "second-secret"]),
        },
        {} as Command,
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "PASSWORD_MISMATCH",
    );
    console.log("✓ command refuses password mismatch\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("=== Daemon Set Password Command Tests Passed ===");
