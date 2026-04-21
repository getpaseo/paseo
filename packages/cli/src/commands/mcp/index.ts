import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption, collectMultiple } from "../../utils/command-options.js";
import { runMcpLsCommand } from "./ls.js";
import { runMcpAddCommand } from "./add.js";
import { runMcpRemoveCommand } from "./remove.js";

export function createMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage MCP servers in your library");

  addJsonOption(
    mcp
      .command("ls")
      .description("List MCP servers in your library")
      .option("--scope <scope>", "Filter by scope: user|org|project")
      .option("--scope-id <id>", "Org or project id when filtering"),
  ).action(withOutput(runMcpLsCommand));

  addJsonOption(
    mcp
      .command("add")
      .description("Add an MCP server to your library")
      .argument("<name>", "Server name (slug, e.g. `playwright`)")
      .option("--transport <t>", "stdio | http | sse (default: stdio)")
      .option("--command <cmd>", "Command for stdio transport (e.g. npx)")
      .option("--arg <arg>", "Argument for stdio command (repeatable)", collectMultiple, [])
      .option("--url <url>", "URL for http/sse transport")
      .option("--header <k=v>", "HTTP header (repeatable)", collectMultiple, [])
      .option("--env <k=v>", "Environment variable (repeatable)", collectMultiple, [])
      .option("--description <text>", "Short description")
      .option("--scope <scope>", "user | org | project (default: user)")
      .option("--scope-id <id>", "Org/project id when scope is org|project")
      .option("--visibility <v>", "private | shared (default: private)")
      .option(
        "--target <name>",
        "Sync target: claude-code | codex | opencode (repeatable; default: all)",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runMcpAddCommand));

  addJsonOption(
    mcp
      .command("remove")
      .description("Remove an MCP server from your library")
      .argument("<id-or-name>", "Entry id (full or prefix) or name"),
  ).action(withOutput(runMcpRemoveCommand));

  return mcp;
}
