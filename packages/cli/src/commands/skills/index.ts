import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption, collectMultiple } from "../../utils/command-options.js";
import { runSkillsLsCommand } from "./ls.js";
import { runSkillsAddCommand } from "./add.js";
import { runSkillsRemoveCommand } from "./remove.js";
import { runSkillsNewCommand } from "./new.js";

export function createSkillsCommand(): Command {
  const skills = new Command("skills").description("Manage Skills in your library");

  addJsonOption(
    skills
      .command("ls")
      .description("List skills in your library")
      .option("--scope <scope>", "Filter by scope: user|org|project")
      .option("--scope-id <id>", "Org or project id when filtering"),
  ).action(withOutput(runSkillsLsCommand));

  addJsonOption(
    skills
      .command("add")
      .description("Add a skill to your library")
      .argument("<name>", "Skill name (slug, e.g. `release-notes`)")
      .option("--file <path>", "Path to a SKILL.md file to use as instructions")
      .option("--body <text>", "Inline instructions text")
      .option("--url <url>", "URL pointing to a remote SKILL.md")
      .option("--description <text>", "Short description")
      .option("--example <text>", "Example prompt to surface in the UI")
      .option("--display-name <text>", "Display name")
      .option("--scope <scope>", "user | org | project (default: user)")
      .option("--scope-id <id>", "Org/project id when scope is org|project")
      .option("--visibility <v>", "private | shared (default: private)")
      .option(
        "--target <name>",
        "Sync target: claude-code | codex | opencode (repeatable; default: all)",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runSkillsAddCommand));

  addJsonOption(
    skills
      .command("remove")
      .description("Remove a skill from your library")
      .argument("<id-or-name>", "Entry id (full or prefix) or name"),
  ).action(withOutput(runSkillsRemoveCommand));

  addJsonOption(
    skills
      .command("new")
      .description("Scaffold a SKILL.md template in a local directory")
      .argument("<name>", "Skill name (used as folder + frontmatter name)")
      .option("--dir <path>", "Parent directory (default: cwd)")
      .option("--description <text>", "Frontmatter description")
      .option("--force", "Overwrite if SKILL.md already exists"),
  ).action(withOutput(runSkillsNewCommand));

  return skills;
}
