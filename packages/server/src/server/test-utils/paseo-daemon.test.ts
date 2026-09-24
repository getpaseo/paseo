import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestPaseoDaemon } from "./paseo-daemon.js";

describe("createTestPaseoDaemon", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("keeps a caller-owned home when startup on a taken port fails", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-owned-home-"));
    cleanups.push(() => rm(paseoHomeRoot, { recursive: true, force: true }));
    const ownedFile = path.join(paseoHomeRoot, "owned-by-caller");
    await writeFile(ownedFile, "keep");
    const takenPort = await occupyPort(cleanups);

    await expect(
      createTestPaseoDaemon({
        listenPort: takenPort,
        paseoHomeRoot,
        staticDir: path.join(paseoHomeRoot, "static"),
        cleanup: false,
        mcpEnabled: false,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(existsSync(ownedFile)).toBe(true);
  }, 60_000);
});

async function occupyPort(cleanups: Array<() => Promise<void>>): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Port holder did not bind a TCP port");
  }
  return address.port;
}
