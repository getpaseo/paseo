import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("./console-streams.ts", import.meta.url));

type Output = "stdout" | "stderr";

async function writeToConsole(input: { closed?: Output; invalidStdout?: boolean } = {}) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `
        const { protectConsoleStreams } = require(${JSON.stringify(modulePath)});
        protectConsoleStreams();
        process.send("ready");
        process.once("message", () => {
          if (${JSON.stringify(input.invalidStdout)}) require("node:fs").closeSync(1);
          console.info("desktop info");
          console.warn("desktop warning");
          setImmediate(() => { process.send("alive"); process.disconnect(); });
        });
      `,
    ],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "FORCE_COLOR")),
    },
  );
  let stdout = "";
  let stderr = "";
  let alive = false;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  child.on("message", (message) => {
    if (message === "ready") {
      if (input.closed) child[input.closed].destroy();
      child.send("write");
    }
    if (message === "alive") alive = true;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  return { code, stdout, stderr, alive };
}

describe("desktop console streams", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it(`keeps running when the launcher closes ${stream}`, async () => {
      const result = await writeToConsole({ closed: stream });
      expect(result.code, result.stderr).toBe(0);
      expect(result.alive).toBe(true);
      expect(result[stream === "stdout" ? "stderr" : "stdout"]).toBe(
        stream === "stdout" ? "desktop warning\n" : "desktop info\n",
      );
    });
  }

  // Windows stdout uses a native handle rather than the POSIX fd closed here.
  it.skipIf(process.platform === "win32")(
    "does not suppress a console failure other than a closed pipe",
    async () => {
      const result = await writeToConsole({ invalidStdout: true });
      expect(result.code).toBe(1);
      expect(result.alive).toBe(false);
      expect(result.stderr).toContain("EBADF");
    },
  );

  it("preserves logging while the console has readers", async () => {
    expect(await writeToConsole()).toEqual({
      code: 0,
      stdout: "desktop info\n",
      stderr: "desktop warning\n",
      alive: true,
    });
  });
});
