import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import { createEditorTargetRuntime } from "./runtime.js";

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  unrefed: boolean;
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
      spawn: (command, args, options) => {
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
      },
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

  it("passes remote URIs to a Windows command script without extra quoting", async () => {
    const records: SpawnRecord[] = [];
    const runtime = createEditorTargetRuntime({
      platform: "win32",
      env: { PATH: "C:/Editors/bin" },
      pathExists: (targetPath) => targetPath === "C:/Editors/bin/code.cmd",
      spawn: (command, args, options) => {
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
      },
    });

    const command = runtime.resolveCommand(["code"]);
    if (!command) throw new Error("Expected the editor command to resolve");
    // Percent-encoding happens before the shell sees the argument, so the characters the
    // cmd escaper reacts to never reach it.
    await runtime.spawnDetached({
      command,
      args: [
        "--folder-uri",
        "vscode-remote://ssh-remote+dev/home/me/repo%20%26%20tools",
        "--goto",
        "--file-uri",
        "vscode-remote://ssh-remote+dev/home/me/repo%20%26%20tools/app.ts:12",
      ],
    });

    expect(records[0]?.args).toEqual([
      "--folder-uri",
      "vscode-remote://ssh-remote+dev/home/me/repo%20%26%20tools",
      "--goto",
      "--file-uri",
      "vscode-remote://ssh-remote+dev/home/me/repo%20%26%20tools/app.ts:12",
    ]);
  });
});
