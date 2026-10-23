// Headless driver for the conversation agent: one text turn in, chunked reply events out.
//   tsx scripts/pyrgos-conversation-turn.ts "what is the status of the tickets" [--model haiku|sonnet|opus] [--fake]
// Env: ALCHEMIST_HARNESS and ALCHEMIST_WORKSHOP (optional roots for the read-only tools),
// PYRGOS_CONVERSATION_MODEL (default model). Uses the Claude subscription login; --fake needs none.
import {
  ConversationAgent,
  SdkBrain,
  buildContext,
  createHarnessTools,
  parseModelFlag,
  type Brain,
  type BrainEvent,
  type ConversationEvent,
} from "../src/server/pyrgos/conversation-agent/index.js";

const args = process.argv.slice(2);
const flagValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fake = args.includes("--fake");
const model = parseModelFlag(flagValue("--model") ?? process.env.PYRGOS_CONVERSATION_MODEL);
const text = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model").join(" ");
if (!text) {
  console.error("usage: pyrgos-conversation-turn.ts <text> [--model haiku|sonnet|opus] [--fake]");
  process.exit(2);
}

function fakeBrain(): Brain {
  return {
    async *runTurn(): AsyncGenerator<BrainEvent> {
      yield { type: "tool_use", name: "mcp__harness__status" };
      yield { type: "tool_result" };
      yield { type: "text", text: "Two agents are running and one is idle. " };
      yield { type: "text", text: "Nothing needs you right now." };
    },
    async interrupt() {},
    async close() {},
  };
}

async function main() {
  const harnessRoot = process.env.ALCHEMIST_HARNESS;
  const brain = fake
    ? fakeBrain()
    : new SdkBrain({
        model,
        tools: createHarnessTools({ harnessRoot, workshopRoot: process.env.ALCHEMIST_WORKSHOP }),
        context: await buildContext(harnessRoot),
      });
  const started = Date.now();
  let firstSpeech: number | null = null;
  const agent = new ConversationAgent({
    brain,
    model,
    onEvent: (event: ConversationEvent) => {
      if (event.type === "speak" && firstSpeech === null) firstSpeech = Date.now() - started;
      console.log(JSON.stringify({ ms: Date.now() - started, ...event }));
    },
  });
  await agent.handleTranscript(text);
  console.log(
    JSON.stringify({ model, fake, firstSpeechMs: firstSpeech, totalMs: Date.now() - started }),
  );
  await agent.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
