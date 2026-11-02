import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestPaseoDaemon } from "./paseo-daemon.js";

describe("createTestPaseoDaemon", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  test("removes the directories it created when startup on a taken port fails", async () => {
    const scratchTmp = await mkdtemp(path.join(os.tmpdir(), "paseo-daemon-scratch-"));
    cleanups.push(() => rm(scratchTmp, { recursive: true, force: true }));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, scratchTmp);
    const takenPort = await occupyPort(cleanups);

    await expect(
      createTestPaseoDaemon({ listenPort: takenPort, cleanup: false, mcpEnabled: false }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    // A home under this scratch dir is too long for a unix socket path, so the terminal worker
    // listens in the per-user `paseo-<uid>` directory of the temp root. Like tmux's, that
    // owner-only directory is shared by every worker and outlives them; it must be empty.
    const sharedSocketDir = `paseo-${process.getuid?.() ?? 0}`;
    const leftovers = await readdir(scratchTmp);
    expect(leftovers.filter((name) => name !== sharedSocketDir)).toEqual([]);
    if (leftovers.includes(sharedSocketDir)) {
      expect(await readdir(path.join(scratchTmp, sharedSocketDir))).toEqual([]);
    }
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
