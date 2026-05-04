import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runArchiveCommand } from "./archive.js";
import { runCreateCommand } from "./create.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createWorktreeCommand(): Command {
  const worktree = new Command("worktree").description("Manage Paseo-managed git worktrees");

  addJsonAndDaemonHostOptions(
    worktree.command("ls").description("List Paseo-managed git worktrees"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    worktree
      .command("create")
      .description("Create a Paseo-managed git worktree")
      .option("--mode <mode>", "Creation mode: branch-off, checkout-branch, or checkout-pr")
      .option("--new-branch <name>", "New branch name (--mode branch-off)")
      .option(
        "--base <ref>",
        "Base ref for new branch (--mode branch-off, defaults to repo default)",
      )
      .option("--branch <name>", "Existing branch to check out (--mode checkout-branch)")
      .option("--pr-number <n>", "Pull request number (--mode checkout-pr)")
      .option("--cwd <path>", "Repository directory (default: current)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    worktree
      .command("archive")
      .description("Archive a worktree (removes worktree and associated branch)")
      .argument("<name>", "Worktree name or branch name"),
  ).action(withOutput(runArchiveCommand));

  return worktree;
}
