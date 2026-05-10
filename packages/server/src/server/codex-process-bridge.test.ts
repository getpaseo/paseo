import { describe, expect, it } from "vitest";

import {
  discoverCodexProcessDescriptors,
  parseUnixProcessTableWithTty,
  readCodexProcessLogPath,
  sanitizeCodexProcessCapture,
} from "./codex-process-bridge.js";

describe("codex process bridge discovery", () => {
  it("does not mistake codex retry helper commands for codex sessions", async () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "723659 723648 pts/18 rg -qi usage limit for /tmp/codex-429-retry.cS8GBi.log",
        "1831372 621663 pts/14 node /usr/local/bin/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
        "1831379 1831372 pts/14 /opt/codex/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
      ].join("\n"),
    );

    const descriptors = await discoverCodexProcessDescriptors({
      processes,
      resolveCwd: async () => "/workspace/repo-b",
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      tty: "/dev/pts/14",
      sessionId: "019d6145-173e-74a0-88bc-e34f12bd3941",
    });
  });

  it("extracts wrapper log path from script ancestor", () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "1827132 668950 pts/18 script -qefc /usr/local/bin/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68 /tmp/codex-429-retry.cS8GBi.log",
        "1827133 1827132 pts/2 node /usr/local/bin/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68",
        "1827143 1827133 pts/2 /opt/codex/codex resume 019d7f5b-1d2c-76c2-96e9-0a6496559b68",
      ].join("\n"),
    );

    const logPath = readCodexProcessLogPath({
      process: processes[2]!,
      processByPid: new Map(processes.map((process) => [process.pid, process])),
    });

    expect(logPath).toBe("/tmp/codex-429-retry.cS8GBi.log");
  });

  it("keeps pseudo-tty codex children even when the wrapper tty differs", async () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "282241 1007934 pts/15 bash /usr/local/bin/codex-root-wrapper",
        "282246 282241 pts/15 script -qefc /usr/local/bin/codex --no-alt-screen /tmp/codex-429-retry.glX6HS.log",
        "282247 282246 pts/23 node /usr/local/bin/codex --no-alt-screen",
        "282262 282247 pts/23 /opt/codex/codex --no-alt-screen",
      ].join("\n"),
    );

    const descriptors = await discoverCodexProcessDescriptors({
      processes,
      resolveCwd: async () => "/workspace/project",
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      tty: "/dev/pts/23",
      logPath: "/tmp/codex-429-retry.glX6HS.log",
      cwd: "/workspace/project",
    });
  });

  it("discovers codex sessions by tty", async () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "1831372 621663 pts/14 node /usr/local/bin/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
        "1831379 1831372 pts/14 /opt/codex/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
        "1832000 621663 pts/27 /opt/codex/codex",
      ].join("\n"),
    );

    const descriptors = await discoverCodexProcessDescriptors({
      processes,
      resolveCwd: async (pid) => (pid === 1832000 ? "/workspace/repo-c" : "/workspace/repo-b"),
    });

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toMatchObject({
      tty: "/dev/pts/14",
      sessionId: "019d6145-173e-74a0-88bc-e34f12bd3941",
      logPath: null,
      cwd: "/workspace/repo-b",
    });
    expect(descriptors[1]).toMatchObject({
      tty: "/dev/pts/27",
      sessionId: null,
      logPath: null,
      cwd: "/workspace/repo-c",
    });
  });

  it("skips codex processes whose cwd has been deleted", async () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "2951059 2951058 pts/36 node /usr/local/bin/codex --no-alt-screen",
        "2951072 2951059 pts/36 /opt/codex/codex --no-alt-screen",
      ].join("\n"),
    );

    const descriptors = await discoverCodexProcessDescriptors({
      processes,
      resolveCwd: async () => "/tmp/paseo-title-e2e.NFS68a (deleted)",
    });

    expect(descriptors).toHaveLength(0);
  });

  it("skips a broken cwd lookup without dropping other codex descriptors", async () => {
    const processes = parseUnixProcessTableWithTty(
      [
        "1831372 621663 pts/14 node /usr/local/bin/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
        "1831379 1831372 pts/14 /opt/codex/codex resume 019d6145-173e-74a0-88bc-e34f12bd3941",
        "2951072 2951059 pts/36 /opt/codex/codex --no-alt-screen",
      ].join("\n"),
    );

    const descriptors = await discoverCodexProcessDescriptors({
      processes,
      resolveCwd: async (pid) => {
        if (pid === 2951072) {
          const error = new Error("cwd disappeared") as Error & { code?: string };
          error.code = "ENOENT";
          throw error;
        }
        return "/workspace/repo-b";
      },
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      tty: "/dev/pts/14",
      cwd: "/workspace/repo-b",
    });
  });

  it("strips ansi escapes from captured codex output", async () => {
    const raw = "\u001b[19;27H\u001b[0mhello\r\n\u001b[31mworld\u001b[0m";
    await expect(sanitizeCodexProcessCapture(raw)).resolves.toBe("hello\nworld");
  });

  it("renders full-screen codex capture into readable lines", async () => {
    const raw = [
      "\u001b[24;1H\u001b[1mWorking\u001b[0m",
      "\u001b[0 q",
      "\u001b]0;spinner /\u0007",
      "\u001b[24;10H\u001b[2m8\u001b[0m",
    ].join("");

    const sanitized = await sanitizeCodexProcessCapture(raw);
    expect(sanitized).toContain("Working");
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain(" q ");
  });
});
