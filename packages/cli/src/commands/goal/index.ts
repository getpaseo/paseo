import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runConfigCommand } from "./config.js";
import { runCreateCommand } from "./create.js";
import { runInspectCommand, runInspectUsageCommand, type GoalInspectOptions } from "./inspect.js";
import { runLsCommand } from "./ls.js";
import { runChangesCommand } from "./changes.js";
import { runNotificationsCommand } from "./notifications.js";
import { runDiagnoseCommand, runRecoverCommand } from "./recover.js";
import { runAcceptCommand } from "./accept.js";
import {
  runArchiveCommand,
  runDeleteCommand,
  runPriorityCommand,
  runRenameCommand,
  runUnarchiveCommand,
} from "./manage.js";
import {
  runAckCommand,
  runApproveChangeSetCommand,
  runApproveCommand,
  runCancelCommand,
  runPauseCommand,
  runPlanCommand,
  runApproveRevisionCommand,
  runRejectPlanCommand,
  runRejectRevisionCommand,
  runRequestChangesCommand,
  runReviseCommand,
  runResumeCommand,
  runRetryCommand,
} from "./transition.js";

export function createGoalCommand(): Command {
  const goal = new Command("goal").description("Manage goals");

  addJsonAndDaemonHostOptions(
    goal
      .command("create")
      .description("Create a goal")
      .argument("<title>", "Goal title")
      .option("--objective <text>", "What the goal should achieve")
      .option(
        "--criterion <text>",
        "Acceptance criterion (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option("--cwd <path>", "Repository to plan and work in; makes the Manager run this goal")
      .option(
        "--lead <provider[/model]>",
        "Provider for the Lead agent, optionally with a model (required with --cwd)",
      )
      .option(
        "--provider <provider[/model]>",
        "Default provider for tasks, optionally with a model (required with --cwd)",
      )
      .option("--max-parallel <n>", "Tasks to run at once (1-8, default 2)")
      .option("--max-attempts <n>", "Attempts per task before it fails for good (1-5, default 2)")
      .option("--auto-approve", "Run the Lead's plan without waiting for approval")
      .option("--no-notify-lead", "Do not message the Lead about failures or completion")
      .option(
        "--lead-interventions",
        "Ask the Lead what to do when a task times out, keeps failing or uses its last attempt (default)",
      )
      .option("--no-lead-interventions", "Retry failed tasks without asking the Lead")
      .option(
        "--review-provider <provider[/model]>",
        "Provider, optionally with a model, for the reviewer and verifier (default: the Lead's)",
      )
      .option(
        "--verify-provider <provider[/model]>",
        "Provider, optionally with a model, for the verifier (default: the review provider)",
      )
      .option("--lead-thinking <id>", "Thinking option for the Lead (default: the model's)")
      .option(
        "--worker-thinking <id>",
        "Thinking option for tasks on --provider; a task's own thinking wins (default: the model's)",
      )
      .option("--review-thinking <id>", "Thinking option for the reviewer (default: the model's)")
      .option("--verify-thinking <id>", "Thinking option for the verifier (default: the model's)")
      .option(
        "--branch-prefix <prefix>",
        "Integration branch is <prefix>/<goalId> (default paseo-goal)",
      )
      .option(
        "--test-command <cmd>",
        "Shell command run after each merge; a failure sends the change back",
      )
      .option("--require-approval", "Hold every reviewed change until you approve it")
      .option("--max-rework <n>", "Rework rounds allowed per change (0-5, default 2)")
      .option("--max-tasks <n>", "Tasks allowed in a plan (default 25)")
      .option("--max-runs <n>", "Agent runs allowed over the goal's lifetime (default 60)")
      .option("--run-timeout <minutes>", "Time allowed for any one agent turn (default 60)")
      .option("--goal-timeout <minutes>", "Time allowed for the whole goal (default 1440)")
      .option(
        "--user-wait <minutes>",
        "Longest one request waits for a person's answer, not counted as run or goal time (default 720)",
      )
      .option("--retry-backoff <seconds>", "Pause before a failed task is retried (default 5)")
      .option("--max-tokens <n>", "Fail the goal once providers report this many tokens")
      .option("--max-cost <usd>", "Fail the goal once providers report this much cost in USD")
      .option(
        "--deadline <iso-time>",
        "Time the goal must be finished by, e.g. 2026-11-01T18:00:00Z",
      )
      .option(
        "--on-permission <policy>",
        "When an agent asks for a permission: fail (unattended mode; a run that asks fails), wait (default; the request waits for you in Paseo), or auto (the provider's auto mode, then wait)",
      )
      .option(
        "--allow-provider <provider>",
        "Restrict the goal to this provider (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option(
        "--priority <priority>",
        "low, normal or high: list order, and first claim on a free run slot (default normal)",
      ),
  ).action(withOutput(runCreateCommand));

  const repeatable = (value: string, previous: string[] = []) => [...previous, value];
  addJsonAndDaemonHostOptions(
    goal
      .command("ls")
      .description("List goals, higher priority first; archived goals are hidden")
      .option("--search <text>", "Only goals whose title, objective or ID contains this text")
      .option(
        "--status <status>",
        "Only goals in this status (repeatable): planning, awaiting_plan_approval, executing, completed, failed, cancelled",
        repeatable,
      )
      .option("--priority <priority>", "Only goals with this priority (repeatable)", repeatable)
      .option("--archived <which>", "exclude (default), only, or include archived goals")
      .option("--project <path>", "Only goals working in this repository"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("rename")
      .description("Rename a goal")
      .argument("<id>", "Goal ID")
      .argument("<title>", "New title"),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("priority")
      .description("Set a goal's priority: low, normal or high")
      .argument("<id>", "Goal ID")
      .argument("<priority>", "low, normal or high"),
  ).action(withOutput(runPriorityCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("config")
      .description(
        "Change a goal's settings in any state but archived; a live goal uses them from its next turn or run. `none` clears an optional setting",
      )
      .argument("<id>", "Goal ID")
      .option("--on-permission <policy>", "fail, wait or auto")
      .option("--notify-lead", "Message the Lead about failures and completion")
      .option("--no-notify-lead", "Do not message the Lead")
      .option(
        "--lead-interventions",
        "Ask the Lead what to do when a task times out, keeps failing or uses its last attempt",
      )
      .option("--no-lead-interventions", "Retry failed tasks without asking the Lead")
      .option("--auto-approve", "Run a proposed plan without waiting for approval")
      .option("--no-auto-approve", "Wait for plan approval")
      .option("--require-approval", "Hold every reviewed change until you approve it")
      .option("--no-require-approval", "Merge reviewed changes without waiting for you")
      .option("--test-command <cmd>", "Shell command run after each merge, or none")
      .option("--max-parallel <n>", "Tasks to run at once (1-8)")
      .option("--max-attempts <n>", "Attempts per task (1-5)")
      .option("--max-rework <n>", "Rework rounds per change (0-5), or none for the default")
      .option("--max-tasks <n>", "Tasks allowed in a plan, or none for the default")
      .option("--max-runs <n>", "Agent runs over the goal's lifetime, or none for the default")
      .option("--run-timeout <minutes>", "Time for any one agent turn, or none for the default")
      .option("--goal-timeout <minutes>", "Time for the whole goal, or none for the default")
      .option(
        "--user-wait <minutes>",
        "Longest one request waits for an answer, or none for the default",
      )
      .option("--retry-backoff <seconds>", "Pause before a retry, or none for the default")
      .option("--max-tokens <n>", "Token budget, or none to remove it")
      .option("--max-cost <usd>", "Cost budget in USD, or none to remove it")
      .option("--deadline <iso-time>", "Time the goal must be finished by, or none to remove it"),
  ).action(withOutput(runConfigCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("archive")
      .description("Hide an ended goal from goal ls; cancel a live goal first")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runArchiveCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("unarchive")
      .description("Show an archived goal again")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runUnarchiveCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("delete")
      .description(
        "Delete an ended goal and its history for good, and remove its worktrees; branches are kept",
      )
      .argument("<id>", "Goal ID")
      .option("-y, --yes", "Do not ask for confirmation"),
  ).action(withOutput(runDeleteCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("inspect")
      .description(
        "Show a goal's tasks and plan revisions (full goal and event history with --json)",
      )
      .argument("<id>", "Goal ID")
      .option("--usage", "Show usage per agent and role, with the goal's total, instead of tasks"),
  ).action((id: string, options: GoalInspectOptions, command: Command) =>
    options.usage
      ? withOutput(runInspectUsageCommand)(id, options, command)
      : withOutput(runInspectCommand)(id, options, command),
  );

  addJsonAndDaemonHostOptions(
    goal
      .command("plan")
      .description("Propose a task plan from a JSON file (array of tasks)")
      .argument("<id>", "Goal ID")
      .requiredOption("--file <path>", "JSON file containing the task array"),
  ).action(withOutput(runPlanCommand));

  addJsonAndDaemonHostOptions(
    goal.command("approve").description("Approve the proposed plan").argument("<id>", "Goal ID"),
  ).action(withOutput(runApproveCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("reject-plan")
      .description("Send the proposed plan back to a fresh Lead to plan again")
      .argument("<id>", "Goal ID")
      .option("--message <text>", "What the new plan should change"),
  ).action(withOutput(runRejectPlanCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("revise")
      .description(
        "Change a running goal's plan from a JSON file: an ops array, {ops}, or the desired plan as {tasks, remove}. Sends PASEO_AGENT_ID when set: the goal's Lead's change waits for approval unless the goal auto-approves plans, any other agent is refused (use --as-person). Prints the revision's status; exits 1 when it was rejected",
      )
      .argument("<id>", "Goal ID")
      .requiredOption("--file <path>", "JSON file with the revision")
      .option("--reason <text>", "Why the plan changes (overrides a reason in the file)")
      .option(
        "--as-person",
        "Revise as a person even when PASEO_AGENT_ID is set (it applies at once); for a person working in an agent's shell",
      ),
  ).action(withOutput(runReviseCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("approve-revision")
      .description("Approve a plan revision the Lead proposed")
      .argument("<id>", "Goal ID")
      .option("--revision <revisionId>", "Revision to approve (default: the pending one)"),
  ).action(withOutput(runApproveRevisionCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("reject-revision")
      .description("Reject a plan revision the Lead proposed; the plan stays as it was")
      .argument("<id>", "Goal ID")
      .option("--revision <revisionId>", "Revision to reject (default: the pending one)")
      .option("--message <text>", "Why it was rejected"),
  ).action(withOutput(runRejectRevisionCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("retry")
      .description(
        "Retry failed or cancelled tasks with fresh attempts; reopens a failed goal (retries all of them, merges again change sets whose merge failed, reworks again change sets whose rework failed, or starts a fresh Lead when it failed while planning). A change set rejected by review is not retried",
      )
      .argument("<id>", "Goal ID")
      .option("--task <taskId>", "Retry only this task (a live goal only)")
      .option(
        "--time <mode>",
        "How the time limit restarts: fresh (the full limit from now) or remaining (the limit minus the time the goal ran). Needed once the time limit has passed; asked on a terminal",
      )
      .option(
        "--prompt <text>",
        "Your instruction for every worker of the goal from now on; an empty text clears it. Refused when PASEO_AGENT_ID is set",
      )
      .option(
        "--task-prompt <taskId=text>",
        "Your instruction for one task's worker (repeatable); <taskId>= clears it. Refused when PASEO_AGENT_ID is set",
        repeatable,
      ),
  ).action(withOutput(runRetryCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("diagnose")
      .description(
        "Explain why a failed goal stopped: per-task causes, what blocks it, the limits it needs raised (with the smallest values) and what a person must do",
      )
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runDiagnoseCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("recover")
      .description(
        "Ask a fresh Lead to decide how a failed goal continues where it stopped: retry with advice for the workers, revise the plan, or hand it back to you. Succeeded and merged work stays. Limits are never raised: change them with goal config first (goal diagnose shows the smallest values). Refused when PASEO_AGENT_ID is set",
      )
      .argument("<id>", "Goal ID")
      .option(
        "--prompt <text>",
        "Your instruction for the Lead and every worker; an empty text clears it",
      )
      .option(
        "--task <taskId=text>",
        "Your instruction for one task's worker (repeatable); <taskId>= clears it",
        repeatable,
      )
      .option(
        "--time <mode>",
        "How the time limit restarts when the recovery is applied: fresh or remaining. Needed once the time limit has passed; asked on a terminal",
      )
      .option("--cancel", "Stop the recovery while its Lead decides or while it waits for you")
      .option("--approve", "Apply the Lead's plan change that waits for you")
      .option("--reject", "Turn down the Lead's plan change; the goal stays failed")
      .option("--message <text>", "Why you rejected it (with --reject)"),
  ).action(withOutput(runRecoverCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("accept")
      .description(
        "Accept a failed goal as is: it becomes completed with every criterion still unverified waived. Only when every task succeeded and all work is merged. Cannot be undone. Refused when PASEO_AGENT_ID is set",
      )
      .argument("<id>", "Goal ID")
      .option("--note <text>", "Why you accept it as is (required)")
      .option("-y, --yes", "Do not ask for confirmation"),
  ).action(withOutput(runAcceptCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("pause")
      .description("Start no new worker runs; runs already going finish")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runPauseCommand));

  addJsonAndDaemonHostOptions(
    goal.command("resume").description("Resume a paused goal").argument("<id>", "Goal ID"),
  ).action(withOutput(runResumeCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("changes")
      .description("List a goal's change sets and where each stands")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runChangesCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("notifications")
      .description(
        "List the messages sent to a goal's Lead and originating chat, and their outcome",
      )
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runNotificationsCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("approve-changeset")
      .description("Approve a reviewed change set that is held for human approval")
      .argument("<id>", "Goal ID")
      .argument("<changeset>", "Change set ID"),
  ).action(withOutput(runApproveChangeSetCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("request-changes")
      .description("Send a change set held for approval back to its author")
      .argument("<id>", "Goal ID")
      .argument("<changeset>", "Change set ID")
      .requiredOption("--message <text>", "What must change"),
  ).action(withOutput(runRequestChangesCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("ack")
      .description(
        "Dismiss an ended goal so it stops asking for attention; a failed goal can still be retried",
      )
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runAckCommand));

  addJsonAndDaemonHostOptions(
    goal.command("cancel").description("Cancel a goal").argument("<id>", "Goal ID"),
  ).action(withOutput(runCancelCommand));

  return goal;
}
