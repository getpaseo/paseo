import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runInspectCommand } from "./inspect.js";
import { runLogsCommand } from "./logs.js";
import { runPauseCommand } from "./pause.js";
import { runResumeCommand } from "./resume.js";
import { runDeleteCommand } from "./delete.js";
import { runRunOnceCommand } from "./run-once.js";
import { runUpdateCommand } from "./update.js";

export function createScheduleCommand(): Command {
  const schedule = new Command("schedule").description("Manage recurring schedules");

  addJsonAndDaemonHostOptions(
    schedule
      .command("create")
      .description("Create a schedule")
      .argument("<prompt>", "Prompt to run on the schedule")
      .option("--every <duration>", "Fixed interval cadence (for example: 5m, 1h)")
      .option("--cron <expr>", "Cron cadence expression")
      .option("--name <name>", "Optional schedule name")
      .option("--target <self|new-agent|agent-id>", "Run target")
      .option(
        "--provider <provider>",
        "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
      )
      .option(
        "--mode <mode>",
        "Provider-specific mode (e.g. claude bypassPermissions, opencode build)",
      )
      .option("--cwd <path>", "Working directory (default: current; required with --host)")
      .option("--run-now", "Fire one immediate run on creation (only with --cron)")
      .option("--no-run-now", "Wait the full interval before the first run (only with --every)")
      .option("--max-runs <n>", "Maximum number of runs")
      .option("--expires-in <duration>", "Time to live for the schedule"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(schedule.command("ls").description("List schedules")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    schedule.command("inspect").description("Inspect a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("logs")
      .description("Show recent schedule run logs")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runLogsCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("pause").description("Pause a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runPauseCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("resume")
      .description("Resume a paused schedule")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runResumeCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("delete").description("Delete a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runDeleteCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("run-once")
      .description("Manually trigger a single run of a schedule without affecting cadence")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runRunOnceCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("update")
      .description("Update an existing schedule in place")
      .argument("<id>", "Schedule ID")
      .option("--every <duration>", "Switch to fixed interval cadence (for example: 5m, 1h)")
      .option("--cron <expr>", "Switch to cron cadence expression")
      .option("--name <name>", "Rename the schedule (empty string clears the name)")
      .option("--prompt <text>", "Replace the schedule prompt")
      .option(
        "--provider <provider>",
        "New agent provider, or provider/model (only for new-agent target)",
      )
      .option("--model <model>", "New agent model (only for new-agent target)")
      .option("--mode <mode>", "New agent provider mode (only for new-agent target)")
      .option("--cwd <path>", "New working directory (only for new-agent target)")
      .option("--max-runs <n>", "Set or change maximum number of runs")
      .option("--no-max-runs", "Clear the max-runs limit")
      .option("--expires-in <duration>", "Set or change time to live for the schedule")
      .option("--no-expires-in", "Clear the expiration"),
  ).action(withOutput(runUpdateCommand));

  return schedule;
}
