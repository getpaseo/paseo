import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushGitCommandTrace } from "./git-command-trace.js";
import { runGitCommand, startGitCommandMetrics, stopGitCommandMetrics } from "./run-git-command.js";

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

  it("keeps remote config credentials out of trace and metrics while executing the original URL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-trace-redaction-"));
    tempDirectories.push(directory);
    const tracePath = path.join(directory, "git.jsonl");
    const remoteUrl =
      "https://codeup-user:codeup-secret@forge.example.com/acme/repo.git?X-Amz-Signature=query-secret";
    await runGitCommand(["init"], { cwd: directory });
    vi.stubEnv("PASEO_GIT_TRACE_FILE", tracePath);
    startGitCommandMetrics();

    await runGitCommand(["config", "remote.paseo-pr-7.url", remoteUrl], { cwd: directory });
    const metrics = stopGitCommandMetrics();
    await flushGitCommandTrace();

    const config = await readFile(path.join(directory, ".git", "config"), "utf8");
    const trace = await readFile(tracePath, "utf8");
    expect(config).toContain(remoteUrl);
    expect(trace).toContain("https://[REDACTED]@forge.example.com/acme/repo.git?[REDACTED]");
    expect(JSON.stringify({ metrics, trace })).not.toMatch(
      /codeup-user|codeup-secret|query-secret/,
    );
  });
});
