import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { runLibrarySyncCommand } from "./sync.js";

export function createLibraryCommand(): Command {
  const library = new Command("library").description(
    "Library-wide operations (cross-cutting MCP + Skills)",
  );

  addJsonOption(
    library
      .command("sync")
      .description(
        "Apply your activated library entries to local CLI configs (~/.claude.json, ~/.codex/config.toml, OpenCode, ~/.agentskills)",
      )
      .option("--home <path>", "Hubcode home directory (default: ~/.hubcode)")
      .option("--dry-run", "Print what would be written without touching disk"),
  ).action(withOutput(runLibrarySyncCommand));

  return library;
}
