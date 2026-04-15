import type { AgentSlashCommand } from "@/hooks/use-agent-commands-query";

export function parseSlashCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) {
    return null;
  }

  const withoutPrefix = trimmed.slice(1);
  const firstWhitespaceIndex = withoutPrefix.search(/\s/);
  const commandName =
    firstWhitespaceIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIndex);

  if (!commandName || commandName.includes("/")) {
    return null;
  }

  return commandName;
}

export function rankSlashCommandsByUsage(
  commands: readonly AgentSlashCommand[],
  usageCounts: Readonly<Record<string, number>>,
): AgentSlashCommand[] {
  return [...commands].sort((left, right) => {
    const usageDelta = (usageCounts[right.name] ?? 0) - (usageCounts[left.name] ?? 0);
    if (usageDelta !== 0) {
      return usageDelta;
    }

    return left.name.localeCompare(right.name);
  });
}
