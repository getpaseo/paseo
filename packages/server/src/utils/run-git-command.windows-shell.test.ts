import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function allowConnectionReset(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET") throw error;
}

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-shell-"));
  tempDirs.push(repo);
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand shell behavior", () => {
  it.each(["http", "ssh"])(
    "closes a stalled %s fetch connection on timeout and admits the next command",
    async (protocol) => {
      const repo = makeTempRepo();
      await runGitCommand(["init"], { cwd: repo });
      const sockets: Socket[] = [];
      const server = createServer((socket) => {
        sockets.push(socket);
        // Force-killing a Windows peer resets the connection instead of sending EOF.
        socket.on("error", allowConnectionReset);
        // Consume the request but never answer, keeping the real transport helper busy.
        socket.resume();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing TCP address");
      const remote = `${protocol}://127.0.0.1:${address.port}/repo.git`;
      try {
        await expect(
          runGitCommand(["fetch", remote, "main"], {
            cwd: repo,
            timeout: 2000,
            envOverlay: {
              NO_PROXY: "127.0.0.1",
              no_proxy: "127.0.0.1",
              GIT_SSH_COMMAND: "ssh -F none -o BatchMode=yes",
            },
          }),
        ).rejects.toThrow("Git command timed out after 2000ms");

        expect(sockets).toHaveLength(1);
        await expect.poll(() => sockets[0]?.destroyed, { timeout: 3000 }).toBe(true);
        await expect(runGitCommand(["--version"], { cwd: repo })).resolves.toMatchObject({
          exitCode: 0,
          truncated: false,
        });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("passes git arguments directly instead of through the platform shell", async () => {
    const repo = makeTempRepo();
    const literalName = "%PASEO_GIT_SHELL_SENTINEL%";
    const expandedName = "expanded-by-cmd";

    await runGitCommand(["init"], { cwd: repo });
    writeFileSync(path.join(repo, literalName), "literal\n");
    writeFileSync(path.join(repo, expandedName), "expanded\n");
    await runGitCommand(["add", literalName, expandedName], { cwd: repo });

    const result = await runGitCommand(["ls-files", "--error-unmatch", literalName], {
      cwd: repo,
      envOverlay: {
        PASEO_GIT_SHELL_SENTINEL: expandedName,
      },
    });

    expect(result.stdout.trim()).toBe(literalName);
  });
});
