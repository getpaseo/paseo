import type { Query } from "@anthropic-ai/claude-agent-sdk";

export async function revertClaudeFiles(input: {
  query: Pick<Query, "rewindFiles">;
  messageId: string;
}): Promise<void> {
  const result = await input.query.rewindFiles(input.messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${input.messageId}`);
  }
}
