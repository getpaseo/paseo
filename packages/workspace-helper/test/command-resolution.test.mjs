import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
const workspaceHelper = fileURLToPath(new URL("../src/executable.mjs", import.meta.url));

test.runIf(process.platform === "win32")("Windows command resolution honors PATHEXT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-helper-windows-command-"));
  try {
    const executable = path.join(root, "paseo-pathext-fixture.CMD");
    await writeFile(executable, "@exit /b 0\r\n");
    const result = await run(
      process.execPath,
      [workspaceHelper, "resolve-command", "--name", "paseo-pathext-fixture"],
      {
        cwd: root,
        env: { ...process.env, PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      path: await realpath(executable),
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
