import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearSpawnCommandResolutions,
  resolveSpawnCommand,
  settleSpawnCommandResolutions,
} from "./resolve-spawn-command.js";

let root: string;

function directory(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tool(dir: string): string {
  const file = path.join(dir, "tool");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

async function resolveSettled(
  pathValue: string | undefined,
  options: { platform?: NodeJS.Platform; nowMs?: number } = {},
): Promise<string> {
  const settings = { platform: "darwin" as const, ...options };
  resolveSpawnCommand("tool", pathValue, settings);
  await settleSpawnCommandResolutions();
  return resolveSpawnCommand("tool", pathValue, settings);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "resolve-spawn-command-"));
  clearSpawnCommandResolutions();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveSpawnCommand", () => {
  test("returns the bare name until the PATH search finishes, then the first executable file", async () => {
    const empty = directory("empty");
    const directoryNamedTool = directory("subdir");
    directory("subdir/tool");
    const expected = tool(directory("bin"));
    const later = tool(directory("later"));
    const pathValue = [empty, directoryNamedTool, path.dirname(expected), path.dirname(later)].join(
      path.delimiter,
    );

    expect(resolveSpawnCommand("tool", pathValue, { platform: "darwin" })).toBe("tool");
    await settleSpawnCommandResolutions();
    expect(resolveSpawnCommand("tool", pathValue, { platform: "darwin" })).toBe(expected);
  });

  test("leaves commands it should not resolve unchanged", async () => {
    const bin = directory("bin");
    tool(bin);

    expect(await resolveSettled(bin, { platform: "win32" })).toBe("tool");
    expect(resolveSpawnCommand("./tool", bin, { platform: "darwin" })).toBe("./tool");
    expect(await resolveSettled(undefined)).toBe("tool");
    // An empty or relative entry resolves against the child's cwd, which only the spawn knows.
    expect(await resolveSettled(["", bin].join(path.delimiter))).toBe("tool");
    expect(await resolveSettled(["rel", bin].join(path.delimiter))).toBe("tool");
    expect(await resolveSettled(directory("nothing-here"))).toBe("tool");
  });

  test("searches PATH again once a resolution expires", async () => {
    const early = directory("early");
    const late = tool(directory("late"));
    const pathValue = [early, path.dirname(late)].join(path.delimiter);

    expect(await resolveSettled(pathValue, { nowMs: 0 })).toBe(late);
    const installed = tool(early);
    expect(await resolveSettled(pathValue, { nowMs: 5_000 })).toBe(late);
    // The expired result is still returned while the new search runs.
    expect(resolveSpawnCommand("tool", pathValue, { platform: "darwin", nowMs: 20_000 })).toBe(
      late,
    );
    await settleSpawnCommandResolutions();
    expect(resolveSpawnCommand("tool", pathValue, { platform: "darwin", nowMs: 20_001 })).toBe(
      installed,
    );

    rmSync(installed);
    rmSync(late);
    expect(await resolveSettled(pathValue, { nowMs: 40_000 })).toBe("tool");
  });
});
