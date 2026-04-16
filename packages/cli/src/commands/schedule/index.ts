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

  return schedule;
}
