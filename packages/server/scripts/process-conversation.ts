import { readFileSync } from "fs";
import { inspect } from "util";
import { standardizePrompt } from "ai/internal";

async function processConversation() {
  try {
    const conversationPath =
      ".debug.conversations/ce44c79a-0689-4210-8e00-72c0a627406d-2.json";

    process.stdout.write(`Loading conversation from: ${conversationPath}\n`);

    const conversationData: any = JSON.parse(
      readFileSync(conversationPath, "utf-8")
    );

    process.stdout.write(
      `\nLoaded conversation ${conversationData.conversationId} with ${conversationData.messages.length} messages\n\n`
    );

    const result = await standardizePrompt({
      prompt: conversationData.messages,
    });

    process.stdout.write("Standardized prompt result:\n");
    process.stdout.write(inspect(result, { depth: null, colors: true }) + "\n");
  } catch (error) {
    process.stderr.write(`Error processing conversation: ${error}\n`);
    process.exit(1);
  }
}

processConversation();
