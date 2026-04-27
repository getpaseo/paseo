import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runArchiveCommand } from "./archive.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createWorktreeCommand(): Command {
  const worktree = new Command("worktree").description("Manage Hubcode-managed git worktrees");

  addJsonAndDaemonHostOptions(
    worktree.command("ls").description("List Hubcode-managed git worktrees"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    worktree
      .command("archive")
      .description("Archive a worktree (removes worktree and associated branch)")
      .argument("<name>", "Worktree name or branch name"),
  ).action(withOutput(runArchiveCommand));

  return worktree;
}
