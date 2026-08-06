import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PluginService } from "../../plugin/service.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { PluginSession } from "./plugin-session.js";

const DAEMON_VERSION = "0.2.6";

async function writePlugin(dir: string, pluginId: string, paseoVersion: string): Promise<void> {
  const pluginDir = join(dir, pluginId);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: "CSV Table",
      version: "1.0.0",
      paseoVersion,
      contributes: {
        filePreviews: [
          { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
        ],
      },
    }),
  );
  await writeFile(join(pluginDir, "preview.html"), "<h1>table</h1>");
}

describe("PluginSession get_entry errors", () => {
  let dir: string;
  let service: PluginService;
  let emitted: SessionOutboundMessage[];
  let session: PluginSession;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plugin-session-test-"));
    service = new PluginService({
      dir,
      daemonVersion: DAEMON_VERSION,
      logger: pino({ level: "silent" }),
    });
    emitted = [];
    session = new PluginSession({
      host: { emit: (msg) => emitted.push(msg) },
      pluginService: service,
      logger: pino({ level: "silent" }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function getEntryError(pluginId: string): Promise<string | null> {
    emitted = [];
    await session.handleGetEntryRequest({
      type: "plugins.get_entry.request",
      requestId: "req-1",
      pluginId,
      entry: "preview.html",
    });
    const message = emitted[0];
    if (message?.type !== "plugins.get_entry.response") {
      throw new Error(`Expected a get_entry response, got ${message?.type}`);
    }
    return message.payload.error;
  }

  test("tells the client the plugin is disabled rather than a generic read failure", async () => {
    await writePlugin(dir, "csv-table", ">=0.2.0");
    await service.setEnabled("csv-table", false);

    expect(await getEntryError("csv-table")).toBe(
      'Plugin "csv-table" is not available: the plugin is disabled',
    );
  });

  test("tells the client which version the plugin needs", async () => {
    await writePlugin(dir, "future-plugin", ">=9.0.0");

    expect(await getEntryError("future-plugin")).toBe(
      'Plugin "future-plugin" is not available: Requires Paseo >=9.0.0, this daemon is 0.2.6',
    );
  });
});
