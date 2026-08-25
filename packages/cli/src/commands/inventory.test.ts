import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonClient = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  getLastServerInfoMessage: vi.fn(),
  inventorySessions: vi.fn(),
}));

vi.mock("../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => daemonClient),
}));

import { runInventorySessionsCommand } from "./inventory.js";

describe("runInventorySessionsCommand", () => {
  beforeEach(() => {
    daemonClient.close.mockClear();
    daemonClient.getLastServerInfoMessage.mockReset();
    daemonClient.inventorySessions.mockReset();
  });

  it.each([0, Number.NaN, 1.5, 201])(
    "rejects invalid --limit %s before connecting",
    async (limit) => {
      await expect(
        runInventorySessionsCommand({ limit, json: true }, new Command()),
      ).rejects.toMatchObject({
        code: "INVALID_INVENTORY_LIMIT",
        message: "--limit must be an integer between 1 and 200",
      });
    },
  );

  it("returns UNSUPPORTED_BY_HOST without sending an unknown RPC to an old daemon", async () => {
    daemonClient.getLastServerInfoMessage.mockReturnValue(null);

    await expect(runInventorySessionsCommand({ json: true }, new Command())).rejects.toMatchObject({
      code: "UNSUPPORTED_BY_HOST",
    });
    expect(daemonClient.inventorySessions).not.toHaveBeenCalled();
    expect(daemonClient.close).toHaveBeenCalledOnce();
  });
});
