import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import { createDaemonTestContext, type DaemonTestContext } from "../../test-utils/index.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";

const COMMAND_NAME = "paseo-issue-903-big-pickle";
const COMMAND_FILE_NAME = `${COMMAND_NAME}.md`;
const OPENCODE_REAL_TEST_MODEL = getRealProviderConfig("opencode").model;
const EXPECTED_RESPONSE = "PASEO_ISSUE_903_BIG_PICKLE_OK";

describe("opencode custom command Big Pickle E2E (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("executes a global custom command through Paseo using Big Pickle", async () => {
    const commandDir = path.join(homedir(), ".config", "opencode", "command");
    const commandFile = path.join(commandDir, COMMAND_FILE_NAME);
    const commandDirExisted = existsSync(commandDir);
    if (existsSync(commandFile)) {
      throw new Error(`Refusing to overwrite existing OpenCode command file: ${commandFile}`);
    }

    const projectDir = await mkdtemp(path.join(tmpdir(), "paseo-opencode-big-pickle-"));
    const logger = pino({ level: "silent" });
    let ctx: DaemonTestContext | undefined;

    try {
      await mkdir(commandDir, { recursive: true });
      await writeFile(
        commandFile,
        [
          "---",
          "description: Paseo issue 903 Big Pickle custom command",
          "agent: build",
          "---",
          "",
          "Reply exactly with this token and nothing else:",
          EXPECTED_RESPONSE,
          "",
        ].join("\n"),
      );

      ctx = await createDaemonTestContext({
        logger,
        agentClients: createRealProviderClients(["opencode"], logger),
      });

      const agent = await ctx.client.createAgent({
        provider: "opencode",
        cwd: projectDir,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "plan",
        title: "OpenCode issue 903 Big Pickle custom command",
      });

      expect(agent.provider).toBe("opencode");
      expect(agent.model).toBe(OPENCODE_REAL_TEST_MODEL);
      expect(agent.status).toBe("idle");

      const commands = await ctx.client.listCommands(agent.id);
      expect(commands.error).toBeNull();
      expect(commands.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: COMMAND_NAME,
            description: "Paseo issue 903 Big Pickle custom command",
          }),
        ]),
      );

      await ctx.client.sendMessage(agent.id, `/${COMMAND_NAME}`);
      const state = await ctx.client.waitForFinish(agent.id, 90_000);

      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();
      expect(state.final?.status).toBe("idle");
      expect(state.lastMessage).toContain(EXPECTED_RESPONSE);
    } finally {
      await ctx?.cleanup();
      await OpenCodeServerManager.getInstance(logger).shutdown();
      await rm(commandFile, { force: true });
      if (!commandDirExisted) {
        await rmdir(commandDir).catch(() => undefined);
      }
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 120_000);
});
