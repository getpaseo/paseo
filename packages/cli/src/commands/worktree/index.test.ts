import { describe, expect, test } from "vitest";
import { createWorktreeCommand } from "./index.js";

describe("createWorktreeCommand", () => {
  test("parses the deprecated create --cwd repository-root alias", () => {
    const worktree = createWorktreeCommand();
    const create = worktree.commands.find((command) => command.name() === "create");
    if (!create) throw new Error("create command was not registered");

    create.parseOptions(["--cwd", "/srv/repo", "--mode", "branch-off", "--new-branch", "feature"]);

    expect(create.opts()).toMatchObject({
      cwd: "/srv/repo",
      mode: "branch-off",
      newBranch: "feature",
    });
  });
});
