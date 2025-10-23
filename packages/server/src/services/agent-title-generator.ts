import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { AgentUpdate } from "../server/acp/types.js";

let openai: ReturnType<typeof createOpenAI> | null = null;

export function initializeTitleGenerator(apiKey: string): void {
  openai = createOpenAI({ apiKey });
  console.log("✓ Agent title generator initialized");
}

export function isTitleGeneratorInitialized(): boolean {
  return openai !== null;
}

/**
 * Extract text context from agent updates for title generation
 */
function extractActivityContext(updates: AgentUpdate[]): string {
  const lines: string[] = [];

  for (const update of updates.slice(0, 10)) { // Only use first 10 updates for context
    const notification = update.notification as any;

    if (notification?.update?.sessionUpdate) {
      const sessionUpdate = notification.update.sessionUpdate;

      // Extract user messages
      if (sessionUpdate.userMessage?.text) {
        lines.push(`User: ${sessionUpdate.userMessage.text}`);
      }

      // Extract assistant messages
      if (sessionUpdate.assistantMessage?.text) {
        lines.push(`Assistant: ${sessionUpdate.assistantMessage.text}`);
      }

      // Extract tool calls (showing what actions were taken)
      if (sessionUpdate.toolCall) {
        const toolCall = sessionUpdate.toolCall;
        lines.push(`Tool: ${toolCall.toolName || 'unknown'}`);
      }

      // Extract plan entries
      if (sessionUpdate.plan?.entries) {
        for (const entry of sessionUpdate.plan.entries.slice(0, 3)) {
          if (entry.content) {
            lines.push(`Plan: ${entry.content}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate a concise title for an agent based on its activity
 * Returns a 3-5 word title similar to ChatGPT/Claude.ai
 */
export async function generateAgentTitle(
  agentUpdates: AgentUpdate[],
  cwd: string
): Promise<string> {
  if (!openai) {
    throw new Error("Title generator not initialized");
  }

  if (agentUpdates.length === 0) {
    return "New Agent";
  }

  const activityContext = extractActivityContext(agentUpdates);

  if (!activityContext.trim()) {
    return "New Agent";
  }

  try {
    const { object } = await generateObject({
      model: openai("gpt-5-nano"),
      schema: z.object({
        title: z.string().describe("A concise 3-5 word title describing what the agent is working on"),
      }),
      prompt: `Generate a concise title for this agent session based on the activity. The title should describe what the agent is working on. Be specific but brief. Examples: "Fix Authentication Bug", "Build Dashboard Component", "Refactor API Routes".

Working directory: ${cwd}

Activity:
${activityContext}`,
      temperature: 0.7,
    });

    console.log(`[TitleGenerator] Generated title: "${object.title}"`);

    return object.title;
  } catch (error: any) {
    console.error("[TitleGenerator] Failed to generate title:", error);
    return "New Agent";
  }
}
