import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_AGENT_TIMELINE_MAX_ITEMS, loadConfig } from "./config.js";

const tempHomes: string[] = [];

function createPaseoHome(persistedConfig?: unknown): string {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-config-"));
  tempHomes.push(paseoHome);

  if (persistedConfig !== undefined) {
    writeFileSync(path.join(paseoHome, "config.json"), JSON.stringify(persistedConfig, null, 2));
  }

  return paseoHome;
}

describe("loadConfig agent timeline budget", () => {
  afterEach(() => {
    for (const paseoHome of tempHomes.splice(0)) {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });

  test("defaults to a bounded agent timeline budget", () => {
    const config = loadConfig(createPaseoHome(), { env: {} });

    expect(config.agentTimelineMaxItems).toBe(DEFAULT_AGENT_TIMELINE_MAX_ITEMS);
  });

  test("reads persisted agent timeline budget", () => {
    const config = loadConfig(
      createPaseoHome({
        version: 1,
        daemon: {
          agentTimeline: {
            maxItems: 64,
          },
        },
      }),
      { env: {} },
    );

    expect(config.agentTimelineMaxItems).toBe(64);
  });

  test("lets the environment override the persisted agent timeline budget", () => {
    const config = loadConfig(
      createPaseoHome({
        version: 1,
        daemon: {
          agentTimeline: {
            maxItems: 64,
          },
        },
      }),
      {
        env: {
          PASEO_AGENT_TIMELINE_MAX_ITEMS: "128",
        },
      },
    );

    expect(config.agentTimelineMaxItems).toBe(128);
  });

  test("ignores invalid environment overrides and falls back to persisted config", () => {
    const config = loadConfig(
      createPaseoHome({
        version: 1,
        daemon: {
          agentTimeline: {
            maxItems: 64,
          },
        },
      }),
      {
        env: {
          PASEO_AGENT_TIMELINE_MAX_ITEMS: "not-a-number",
        },
      },
    );

    expect(config.agentTimelineMaxItems).toBe(64);
  });
});
