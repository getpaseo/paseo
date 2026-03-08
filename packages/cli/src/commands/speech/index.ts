import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { runSpeechModelsCommand } from "./models.js";
import { runSpeechDownloadCommand } from "./download.js";

function collectMultiple(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function createSpeechCommand(): Command {
  const speech = new Command("speech").description("Manage local speech models");

  speech
    .command("models")
    .description("List local speech model download status")
    .option("--json", "Output in JSON format")
    .option("--host <host>", "Daemon host target (default: local socket/pipe, then localhost:6767)")
    .action(withOutput(runSpeechModelsCommand));

  speech
    .command("download")
    .description("Download local speech models")
    .option("--model <id>", "Model ID to download (repeatable)", collectMultiple, [])
    .option("--json", "Output in JSON format")
    .option("--host <host>", "Daemon host target (default: local socket/pipe, then localhost:6767)")
    .action(withOutput(runSpeechDownloadCommand));

  return speech;
}
