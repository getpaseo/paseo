import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startConfiguredAutoStartServices } from "./auto-start.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("starts only opted-in configured services after setup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-auto-services-"));
  directories.push(cwd);
  await writeFile(
    join(cwd, "paseo.json"),
    JSON.stringify({
      scripts: {
        dev: { type: "service", command: "npm run dev", autoStart: true },
        docs: { type: "service", command: "npm run docs", autoStart: false },
        test: { command: "npm test", autoStart: true },
      },
    }),
  );
  const launch = vi.fn(async () => undefined);
  await startConfiguredAutoStartServices({
    cwd,
    workspaceId: "workspace-1",
    launch,
    logger: { warn: vi.fn() },
  });
  expect(launch).toHaveBeenCalledExactlyOnceWith("dev");
});
