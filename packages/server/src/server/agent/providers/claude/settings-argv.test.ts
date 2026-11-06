import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { ClaudeAgentClient } from "./agent.js";

test("the real SDK passes the user's settings file contents alongside Paseo flags", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-settings-argv-"));
  const capturePath = path.join(cwd, "argv.json");
  const binaryPath = path.join(cwd, "capture.mjs");
  const settingsPath = path.join(cwd, "settings.json");
  const userSettings = {
    env: { ENABLE_TOOL_SEARCH: "false" },
    permissions: { deny: ["Monitor"] },
  };
  try {
    // A CLI fixture records the real SDK's arguments without making a model request.
    await fs.writeFile(
      binaryPath,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
    );
    await fs.writeFile(settingsPath, JSON.stringify(userSettings));
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      resolveBinary: async () => binaryPath,
    });
    const session = await client.createSession({
      provider: "claude",
      cwd,
      model: "claude-opus-5-5",
      providerOptions: { extraArgs: { settings: settingsPath } },
    });
    try {
      await session.startTurn("hello");
    } finally {
      await session.close();
    }
    const argv: string[] = JSON.parse(await fs.readFile(capturePath, "utf8"));
    const settingsIndex = argv.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[settingsIndex + 1]!)).toEqual({ ...userSettings, fastMode: false });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
