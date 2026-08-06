import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createHome(config: object = {}): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-config-agent-env-"));
  roots.push(home);
  await writeFile(path.join(home, "config.json"), JSON.stringify(config));
  return home;
}

describe("agent environment config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("seeds the direnv preset when nothing has been configured", async () => {
    const home = await createHome();

    expect(loadConfig(home, { env: {} }).agentEnvironment).toEqual({
      entries: [{ kind: "preset", id: "direnv", preset: "direnv" }],
      timeoutMs: 30_000,
    });
  });

  test("an explicitly emptied list stays empty across a restart", async () => {
    const home = await createHome({ agents: { environment: { entries: [] } } });

    expect(loadConfig(home, { env: {} }).agentEnvironment?.entries).toEqual([]);
  });

  test("loads preset and command entries from agents.environment", async () => {
    const home = await createHome({
      agents: {
        environment: {
          timeoutMs: 5_000,
          entries: [
            { kind: "preset", id: "e1", preset: "direnv" },
            {
              kind: "command",
              id: "e2",
              command: ["bash", "-lc", "env -0"],
              format: "env0",
              timeoutMs: 1_000,
            },
          ],
        },
      },
    });

    expect(loadConfig(home, { env: {} }).agentEnvironment).toEqual({
      timeoutMs: 5_000,
      entries: [
        { kind: "preset", id: "e1", preset: "direnv" },
        {
          kind: "command",
          id: "e2",
          command: ["bash", "-lc", "env -0"],
          format: "env0",
          timeoutMs: 1_000,
        },
      ],
    });
  });

  test("rejects a command entry with no argv", async () => {
    const home = await createHome({
      agents: { environment: { entries: [{ kind: "command", id: "e1", command: [] }] } },
    });

    expect(() => loadConfig(home, { env: {} })).toThrow(/agents.environment.entries/);
  });
});
