import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { AgentTimelineItem } from "../server/agent/agent-sdk-types.js";
import { curateAgentActivity } from "../server/agent/activity-curator.js";
import { getRootLogger } from "../server/logger.js";

const logger = getRootLogger().child({ module: "agent-title-generator" });

let openai: ReturnType<typeof createOpenAI> | null = null;

export function initializeTitleGenerator(apiKey: string): void {
  openai = createOpenAI({ apiKey });
  logger.info("Agent title generator initialized");
}

export function isTitleGeneratorInitialized(): boolean {
  return openai !== null;
}

/**
 * Generate a concise title for an agent based on its activity
 * Returns a 3-5 word title similar to ChatGPT/Claude.ai
 */
export async function generateAgentTitle(
  timeline: AgentTimelineItem[],
  cwd: string
): Promise<string> {
  if (!openai) {
    throw new Error("Title generator not initialized");
  }

  if (timeline.length === 0) {
    return "New Agent";
  }

  const activityContext = curateAgentActivity(timeline);

  if (!activityContext.trim() || activityContext === "No activity to display.") {
    return "New Agent";
  }

  try {
    const { object } = await generateObject({
      model: openai("gpt-5-nano"),
      schema: z.object({
        title: z.string().describe("A concise 3-5 word title describing what the agent is working on"),
      }),
      prompt: `Generate a concise title for this agent session. The title should describe what the user asked the agent to do.

IMPORTANT: Focus primarily on [User] messages to understand the task. User messages contain the actual request - use their words and intent to name the chat. Tool calls and assistant messages are just implementation details and should NOT drive the title.

Be specific but brief (3-5 words). Examples: "Fix Authentication Bug", "Build Dashboard Component", "Refactor API Routes".

Working directory: ${cwd}

Activity:
${activityContext}`,
      temperature: 0.7,
    });

    logger.debug({ title: object.title }, "Generated agent title");

    return object.title;
  } catch (err) {
    logger.error({ err }, "Failed to generate agent title");
    return "New Agent";
  }
}
