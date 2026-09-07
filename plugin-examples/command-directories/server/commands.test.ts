import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listCommands, resolveCommand } from "./commands";
import type { CommandDirectory } from "../shared/commands";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-command-directories-"));
  roots.push(root);
  return root;
}

async function writeCommand(directory: string, name: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.md`), contents);
}

describe("command directory example", () => {
  it("merges arbitrary workspace, project, and absolute directories in configured order", async () => {
    const root = await createRoot();
    const workspaceDirectory = path.join(root, "worktree");
    const projectRootPath = path.join(root, "source");
    const sharedDirectory = path.join(root, "shared");
    await writeCommand(
      path.join(workspaceDirectory, ".commands"),
      "review",
      "---\ndescription: Review this worktree\nargument-hint: [scope]\n---\nReview $ARGUMENTS",
    );
    await writeCommand(
      path.join(projectRootPath, "team-commands"),
      "review",
      "---\ndescription: Review the source checkout\n---\nSource review",
    );
    await writeCommand(sharedDirectory, "release", "Prepare release $1 for $TARGET");

    const directories: CommandDirectory[] = [
      { relativeTo: "workspace", path: ".commands" },
      { relativeTo: "project", path: "team-commands" },
      { relativeTo: "absolute", path: sharedDirectory },
    ];
    const context = { workspaceDirectory, projectRootPath, directories };

    await expect(listCommands(context)).resolves.toEqual({
      commands: [
        { name: "release", description: "Custom command", argumentHint: "" },
        { name: "review", description: "Review this worktree", argumentHint: "[scope]" },
      ],
    });
    await expect(resolveCommand({ ...context, name: "review", args: "src" })).resolves.toEqual({
      prompt: "Review src",
    });
    await expect(
      resolveCommand({ ...context, name: "release", args: '"1.2 beta" TARGET=production' }),
    ).resolves.toEqual({ prompt: "Prepare release 1.2 beta for production" });
  });

  it("fails when a selected command disappears", async () => {
    const root = await createRoot();
    const context = {
      workspaceDirectory: root,
      projectRootPath: root,
      directories: [{ relativeTo: "workspace", path: ".commands" }] satisfies CommandDirectory[],
    };

    await expect(resolveCommand({ ...context, name: "missing", args: "" })).rejects.toThrow(
      "Command is unavailable in this workspace: missing",
    );
  });
});
