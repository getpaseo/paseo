import { readFileSync } from "fs";
import { inspect } from "util";
import { standardizePrompt } from "ai/internal";

async function processConversation() {
  try {
    const conversationPath =
      ".debug.conversations/ce44c79a-0689-4210-8e00-72c0a627406d-2.json";

    console.log("Loading conversation from:", conversationPath);

    const conversationData: any = JSON.parse(
      readFileSync(conversationPath, "utf-8")
    );

    console.log(
      `\nLoaded conversation ${conversationData.conversationId} with ${conversationData.messages.length} messages\n`
    );

    const result = await standardizePrompt({
      prompt: conversationData.messages,
    });

    console.log("Standardized prompt result:");
    console.log(inspect(result, { depth: null, colors: true }));
  } catch (error) {
    console.error("Error processing conversation:", error);
    process.exit(1);
  }
}

processConversation();
