import { seedIssueContext } from "@/lib/seed-issue-context";
import type { TaskMetadata } from "@/types/integrations";

export function buildTaskAgentPrompt(input: {
  prompt?: string | null;
  metadata?: TaskMetadata | null;
}): string | undefined {
  const manualPrompt = input.prompt?.trim() ?? "";
  const issueContext = seedIssueContext(input.metadata ?? undefined)?.trim() ?? "";

  if (issueContext && manualPrompt) {
    return `${issueContext}\n\nTask instructions:\n${manualPrompt}`;
  }

  const combined = issueContext || manualPrompt;
  return combined || undefined;
}
