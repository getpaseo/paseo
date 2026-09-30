import { Command } from "commander";
import { migrateLegacyHome, type HomeMigrationResult } from "@getpaseo/server/daemon-control";
import { withOutput, type CommandOptions, type OutputSchema } from "../output/index.js";
import { addJsonOption } from "../utils/command-options.js";

export const homeMigrationSchema: OutputSchema<HomeMigrationResult> = {
  idField: "action",
  columns: [],
  renderHuman: (result) => {
    const data = result.data as HomeMigrationResult;
    switch (data.action) {
      case "migrated":
        return `Moved ${data.legacyHome} to ${data.home} and linked ${data.legacyHome} -> ${data.home}.`;
      case "would_migrate":
        return `Dry run: would move ${data.legacyHome} to ${data.home} and link ${data.legacyHome} -> ${data.home}.`;
      case "already_migrated":
        return `Already migrated: ${data.legacyHome} links to ${data.home}.`;
      case "nothing_to_migrate":
        return `Nothing to migrate: ${data.legacyHome} does not exist.`;
    }
  },
};

export function createHomeCommand(): Command {
  const home = new Command("home").description("Manage the PandaOS data directory");
  addJsonOption(
    home
      .command("migrate")
      .description("Move ~/.paseo to ~/.pandaos and leave a symlink behind (stop the daemon first)")
      .option("--dry-run", "Check and report without changing anything"),
  ).action(withOutput(runHomeMigrateCommand));
  return home;
}

export async function runHomeMigrateCommand(options: CommandOptions, _command: Command) {
  const data = await migrateLegacyHome({ dryRun: options.dryRun === true });
  return { type: "single" as const, data, schema: homeMigrationSchema };
}
