import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { runPluginBuild } from "./preparation.js";

describe("runPluginBuild", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("executes build commands in the target directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();

    await runPluginBuild(
      directory,
      [
        [process.execPath, "-e", 'require("node:fs").writeFileSync("step1.txt", process.cwd());'],
        [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync("step2.txt", process.argv[1]);',
          "step2-arg",
        ],
      ],
      logger,
    );

    const step1 = await readFile(path.join(directory, "step1.txt"), "utf8");
    const step2 = await readFile(path.join(directory, "step2.txt"), "utf8");

    expect(await realpath(step1)).toBe(await realpath(directory));
    expect(step2).toBe("step2-arg");
  });

  it.runIf(process.platform === "win32")("executes Windows command scripts (.cmd)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();
    const scriptPath = path.join(directory, "build.cmd");
    await writeFile(scriptPath, "@echo off\r\necho %1> result.txt\r\n");

    await runPluginBuild(directory, [[scriptPath, "windows-build-ok"]], logger);

    const result = await readFile(path.join(directory, "result.txt"), "utf8");
    expect(result.trim()).toBe("windows-build-ok");
  });

  it.runIf(process.platform === "win32")(
    "executes bare Windows command scripts resolved through PATH",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
      directories.push(directory);
      const logger = createTestLogger();

      await runPluginBuild(directory, [["npm", "init", "-y"]], logger);

      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      expect(manifest.name).toBe(path.basename(directory).toLowerCase());
    },
  );

  it("passes arguments unchanged to a native executable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();

    await runPluginBuild(
      directory,
      [
        [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync("args.txt", process.argv[1]);',
          "a & b (c) !",
        ],
      ],
      logger,
    );

    const args = await readFile(path.join(directory, "args.txt"), "utf8");
    expect(args).toBe("a & b (c) !");
  });

  it.runIf(process.platform !== "win32")("executes POSIX shell scripts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();
    const scriptPath = path.join(directory, "build.sh");
    await writeFile(scriptPath, '#!/bin/sh\necho "$1" > result.txt\n');
    await chmod(scriptPath, 0o755);

    await runPluginBuild(directory, [[scriptPath, "posix-build-ok"]], logger);

    const result = await readFile(path.join(directory, "result.txt"), "utf8");
    expect(result.trim()).toBe("posix-build-ok");
  });

  it("throws when a build command exits with a non-zero code", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();

    await expect(
      runPluginBuild(
        directory,
        [[process.execPath, "-e", "console.error('build failed'); process.exit(2);"]],
        logger,
      ),
    ).rejects.toThrow(/Plugin build command failed \(exit 2\)/);
  });

  it("handles empty or undefined build commands gracefully", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
    directories.push(directory);
    const logger = createTestLogger();

    await expect(runPluginBuild(directory, undefined, logger)).resolves.toBeUndefined();
    await expect(runPluginBuild(directory, [], logger)).resolves.toBeUndefined();
  });
});
