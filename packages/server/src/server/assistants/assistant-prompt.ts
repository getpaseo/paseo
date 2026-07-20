import type { Assistant } from "@getpaseo/protocol/messages";

function resolveAssistantMemorySummary(assistant: Assistant): string {
  if (!assistant.memoryEnabled) {
    return "";
  }
  const summary = assistant.memorySummary.trim();
  if (summary.length > 0) {
    return summary;
  }
  const legacyMemory = assistant.memory.trim();
  if (legacyMemory.length === 0) {
    return "";
  }
  return [
    "# Assistant memory summary",
    `This assistant has ${legacyMemory.length} characters of legacy memory, but memory detail files are not available in this record. The full memory is intentionally not included in the first prompt.`,
  ].join("\n");
}

export function buildAssistantInitialPrompt(assistant: Assistant, userPrompt: string): string {
  const parts = [assistant.prompt.trim()];
  const memory = resolveAssistantMemorySummary(assistant);
  if (memory.length > 0) {
    parts.push(`## Assistant memory\n\n${memory}`);
  }
  parts.push(userPrompt.trim());
  return parts.filter((part) => part.length > 0).join("\n\n---\n\n");
}
