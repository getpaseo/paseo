import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const MAX_INITIAL_AGENT_TITLE_CHARS = Math.min(60, MAX_EXPLICIT_AGENT_TITLE_CHARS);

export function isGreetingPrompt(prompt: string): boolean {
  return /^(?:hi|hallo|hello|hey|moin|servus|guten (?:morgen|tag|abend)|good (?:morning|evening))[!.,?\s]*$/i.test(
    prompt.trim(),
  );
}

export function isSetupPrompt(prompt: string): boolean {
  return (
    isGreetingPrompt(prompt) ||
    /^(?:ok|okay|yes|ja|danke|thanks|thank you|verstanden)[!.,?\s]*$/i.test(prompt.trim()) ||
    /^(?:welche|was für|what|which).{0,30}(?:skills|fähigkeiten|capabilities|tools|werkzeuge).{0,40}$/i.test(
      prompt.trim(),
    )
  );
}

export function resolveLegacyPromptTitle(prompt: string): string | null {
  return deriveInitialAgentTitle(prompt, true);
}

function deriveInitialAgentTitle(prompt: string, includeGreeting = false): string | null {
  if (!includeGreeting && isGreetingPrompt(prompt)) return null;
  const firstContentLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) {
    return null;
  }
  const normalized = firstContentLine.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const clamped = normalized.slice(0, MAX_INITIAL_AGENT_TITLE_CHARS).trim();
  return clamped.length > 0 ? clamped : null;
}

export function resolveCreateAgentTitles(options: {
  configTitle?: string | null;
  initialPrompt?: string | null;
}): { explicitTitle: string | null; provisionalTitle: string | null } {
  const explicitTitle =
    typeof options.configTitle === "string" && options.configTitle.trim().length > 0
      ? options.configTitle.trim()
      : null;
  const trimmedPrompt = options.initialPrompt?.trim();
  const provisionalTitle =
    explicitTitle ?? (trimmedPrompt ? deriveInitialAgentTitle(trimmedPrompt) : null);

  return {
    explicitTitle,
    provisionalTitle,
  };
}

export function resolveFirstAgentPromptTitle(firstAgentContext?: FirstAgentContext): string | null {
  return (
    resolveCreateAgentTitles({
      initialPrompt: firstAgentContext?.prompt,
    }).provisionalTitle ?? null
  );
}
