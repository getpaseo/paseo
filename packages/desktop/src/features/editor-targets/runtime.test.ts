import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import { createEditorTargetRuntime } from "./runtime.js";
import { zedTarget } from "./targets/zed.js";

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  unrefed: boolean;
}

function recordSpawns(records: SpawnRecord[]) {
  return (command: string, args: string[], options: SpawnOptions) => {
    const record = { command, args, options, unrefed: false };
    records.push(record);
    const child = {
      once(event: "error" | "spawn", handler: (error?: Error) => void) {
        if (event === "spawn") queueMicrotask(() => handler());
        return child;
      },
      unref() {
        record.unrefed = true;
      },
    };
    return child;
  };
}

describe("editor target runtime", () => {
  it("resolves command aliases and safely launches Windows command scripts", async () => {
    const records: SpawnRecord[] = [];
    const runtime = createEditorTargetRuntime({
      platform: "win32",
      env: {
        PATH: "C:/Program Files/Editors & Tools/bin",
        ELECTRON_RUN_AS_NODE: "1",
      },
      pathExists: (targetPath) => targetPath === "C:/Program Files/Editors & Tools/bin/code.cmd",
      spawn: recordSpawns(records),
    });

    const command = runtime.resolveCommand(["missing", "code"]);
    if (!command) throw new Error("Expected the editor command to resolve");
    await runtime.spawnDetached({
      command,
      args: ["C:/repo & workspace", "C:/repo/src/file & calculator.ts"],
    });

    expect(records).toEqual([
      {
        command: '"C:/Program Files/Editors & Tools/bin/code.cmd"',
        args: ['"C:/repo & workspace"', '"C:/repo/src/file & calculator.ts"'],
        options: {
          detached: true,
          env: { PATH: "C:/Program Files/Editors & Tools/bin" },
          shell: true,
          stdio: "ignore",
        },
        unrefed: true,
      },
    ]);
  });

  it.each([
    ["system", "/var/lib/flatpak/exports/bin/dev.zed.Zed"],
    ["user", "/home/dev/.local/share/flatpak/exports/bin/dev.zed.Zed"],
  ])("finds and opens Zed from a %s Flatpak install on Linux", async (_scope, flatpakExport) => {
    const records: SpawnRecord[] = [];
    const existingPaths = new Set([flatpakExport, "/repo", "/repo/src/app.ts"]);
    const runtime = createEditorTargetRuntime({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      homeDirectory: "/home/dev",
      pathExists: (targetPath) => existingPaths.has(targetPath),
      spawn: recordSpawns(records),
      loadIcon: async (fileName) => ({ kind: "image", dataUrl: fileName }),
    });

    const targets = await listAvailableEditorTargets(runtime, [zedTarget]);
    expect(targets.map((target) => target.id)).toEqual(["zed"]);

    await openEditorTarget(
      { editorId: "zed", workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 3 },
      runtime,
      [zedTarget],
    );
    expect(records.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: flatpakExport, args: ["/repo", "/repo/src/app.ts:3"] },
    ]);
  });
});
