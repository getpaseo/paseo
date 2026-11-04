import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFile = promisify(execFileCallback);

test("a large ignored-directory listing establishes a working-tree watcher before its deadline", async () => {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "large-ignore-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  try {
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(path.join(repo, ".gitignore"), "probes/\n");
    // An ignored parent containing force-tracked files cannot be excluded as a whole.
    // Keep the observed directory count small enough for Linux's watcher limit.
    for (let parent = 0; parent < 400; parent++) {
      const directory = path.join(repo, "probes", `p${parent}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "notes.md"), "tracked\n");
      await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const ignored = path.join(directory, `out${index}`);
          await mkdir(ignored);
          await writeFile(path.join(ignored, "data.bin"), "ignored\n");
        }),
      );
    }
    execFileSync("git", ["add", ".gitignore"], { cwd: repo });
    execFileSync("git", ["add", "-f", "--", "**/notes.md"], { cwd: repo });
    const listing = execFileSync(
      "git",
      ["ls-files", "-o", "-i", "--directory", "--exclude-standard"],
      { cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    expect(listing.trim().split("\n")).toHaveLength(40_000);

    // Bound the failing baseline in a child: timed-out subscriptions continue their
    // startup scan until it settles, so awaiting disposal would hide the failure.
    const source = `
      import pino from "pino";
      import { WorkspaceGitServiceImpl } from "./src/server/workspace-git-service.ts";
      const service = new WorkspaceGitServiceImpl({
        logger: pino({ enabled: false }), paseoHome: process.argv[2],
      });
      let maxTickMs = 0;
      let previous = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxTickMs = Math.max(maxTickMs, now - previous);
        previous = now;
      }, 10);
      const watch = await service.requestWorkingTreeWatch(process.argv[1], () => {});
      const active = service.getMetrics().fileObserver.activeObservationCount;
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(timer);
      console.log(JSON.stringify({ active, maxTickMs }));
      if (active !== 1) process.exit(0);
      watch.unsubscribe();
      await service.dispose();
    `;
    const { stdout } = await execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, repo, path.join(root, "home")],
      { cwd: path.resolve(import.meta.dirname, "../.."), timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const measurement = JSON.parse(stdout.trim());
    expect(measurement.active).toBe(1);
    expect(measurement.maxTickMs).toBeLessThan(2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
