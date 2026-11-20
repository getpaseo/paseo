import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import { createEditorTargetRuntime } from "./runtime.js";
import { xcodeTarget } from "./targets/xcode.js";

// The macOS runtime interprets real fixture paths as POSIX paths.
const it = test.runIf(process.platform !== "win32");

describe("editor target POSIX filesystem", () => {
  it("discovers and opens Xcode documents from the real filesystem", async () => {
    const workspacePath = mkdtempSync(path.join(os.tmpdir(), "paseo-xcode-"));
    const commands: Array<{ command: string; args: string[] }> = [];
    const runtime = createEditorTargetRuntime({
      platform: "darwin",
      env: {},
      pathExists: (targetPath) =>
        targetPath === "/Applications/Xcode.app" || existsSync(targetPath),
      loadIcon: async () => ({ kind: "symbol", name: "terminal" }),
      spawn: (command, args) => {
        commands.push({ command, args });
        const child = {
          once(event: "error" | "spawn", handler: (error?: Error) => void) {
            if (event === "spawn") queueMicrotask(() => handler());
            return child;
          },
          unref() {},
        };
        return child;
      },
    });
    try {
      writeFileSync(path.join(workspacePath, "Notes.xcodeproj"), "not a project directory");
      mkdirSync(path.join(workspacePath, "Package.swift"));
      expect(await listAvailableEditorTargets(runtime, [xcodeTarget], { workspacePath })).toEqual(
        [],
      );

      const documentPath = path.join(workspacePath, "App.xcworkspace");
      mkdirSync(documentPath);
      const targets = await listAvailableEditorTargets(runtime, [xcodeTarget], { workspacePath });
      expect(targets.map((target) => target.id)).toEqual(["xcode"]);
      await openEditorTarget({ editorId: "xcode", workspacePath }, runtime);

      expect(commands).toEqual([
        { command: "/usr/bin/open", args: ["-a", "/Applications/Xcode.app", documentPath] },
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
