import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runArchiveCommand } from "./archive.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";

export function createWorkspaceCommand(): Command {
  const workspace = new Command("workspace").description("Manage workspaces");

  addJsonAndDaemonHostOptions(
    workspace
      .command("create")
      .description("Create a workspace")
      .requiredOption("--isolation <local|worktree>", "Workspace isolation")
      .option("--path <path>", "Local directory or source checkout (default: current)")
      .option("--project <id>", "Existing project id")
      .option("--title <title>", "Workspace title")
      .option(
        "--mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr (default: branch-off)",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name (--mode branch-off)")
      .option("--base <ref>", "Base ref (--mode branch-off)")
      .option("--branch <name>", "Existing branch (--mode checkout-branch)")
      .option("--pr-number <n>", "Pull request or change request number (--mode checkout-pr)")
      .option("--forge <forge>", "Forge for --mode checkout-pr (default: source checkout)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(workspace.command("ls").description("List active workspaces")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    workspace
      .command("archive")
      .description("Archive a workspace and everything it owns")
      .argument("<workspace-id>", "Workspace id"),
  ).action(withOutput(runArchiveCommand));

  return workspace;
}
