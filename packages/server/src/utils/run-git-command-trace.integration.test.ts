import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushGitCommandTrace } from "./git-command-trace.js";
import { runGitCommand } from "./run-git-command.js";

describe("git command trace", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("writes one asynchronous settlement record for a real git process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-trace-"));
    tempDirectories.push(directory);
    const tracePath = path.join(directory, "git.jsonl");
    vi.stubEnv("PASEO_GIT_TRACE_FILE", tracePath);

    await runGitCommand(["--version"], { cwd: directory });
    await flushGitCommandTrace();

    const events = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "git_command",
      event: "settled",
      args: ["--version"],
      cwd: directory,
      queue: {
        submitted: { active: 0, pending: 0 },
        started: expect.objectContaining({
          active: expect.any(Number),
          pending: expect.any(Number),
        }),
      },
      queueWaitMs: expect.any(Number),
      spawnCallMs: expect.any(Number),
      pid: expect.any(Number),
      outcome: "closed",
      exitCode: 0,
      signal: null,
      durationMs: expect.any(Number),
    });
  });
});
