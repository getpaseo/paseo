import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runInspectCommand } from "./inspect.js";
import { runDeleteCommand } from "./delete.js";
import { runPostCommand } from "./post.js";
import { runReadCommand } from "./read.js";
import { runWaitCommand } from "./wait.js";

export function createChatCommand(): Command {
  const chat = new Command("chat").description("Manage chat rooms for agent coordination");

  addJsonAndDaemonHostOptions(
    chat
      .command("create")
      .description("Create a chat room")
      .argument("<name>", "Room name (must be unique)")
      .option("--purpose <text>", "Room purpose/description"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    chat.command("ls").description("List chat rooms"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("inspect")
      .description("Inspect a chat room")
      .argument("<name-or-id>", "Room name or ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("delete")
      .description("Delete a chat room")
      .argument("<name-or-id>", "Room name or ID"),
  ).action(withOutput(runDeleteCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("post")
      .description("Post a chat message")
      .argument("<name-or-id>", "Room name or ID")
      .argument("<message>", "Message body")
      .option("--reply-to <msg-id>", "Reply to a specific message ID")
      .option(
        "--mention <agent-id>",
        "Mention an agent ID (repeatable)",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runPostCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("read")
      .description("Read chat messages")
      .argument("<name-or-id>", "Room name or ID")
      .option("--limit <n>", "Maximum number of messages to return")
      .option("--since <duration-or-timestamp>", "Filter by relative duration or ISO timestamp")
      .option("--agent <agent-id>", "Filter by author agent ID"),
  ).action(withOutput(runReadCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("wait")
      .description("Wait for new chat messages")
      .argument("<name-or-id>", "Room name or ID")
      .option("--timeout <duration>", "Maximum wait time"),
  ).action(withOutput(runWaitCommand));

  return chat;
}
