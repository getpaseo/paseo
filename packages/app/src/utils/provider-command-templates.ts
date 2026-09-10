import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderCommandId = "resume";

/**
 * Declarative command templates for provider-native CLIs.
 *
 * Note: these are NOT Paseo agent IDs. They take provider-native session IDs.
 * Example placeholders:
 * - {sessionId}
 */
export const PROVIDER_COMMAND_TEMPLATES: Record<
  string,
  Partial<Record<ProviderCommandId, string>>
> = {
  codex: {
    resume: "codex resume {sessionId}",
  },
  claude: {
    resume: "claude --resume {sessionId}",
  },
  hermes: {
    resume: "hermes --resume {sessionId}",
  },
  pi: {
    resume: "pi --session {sessionId}",
  },
  omp: {
    resume: "omp --session {sessionId}",
  },
  opencode: {
    resume: "opencode --session {sessionId}",
  },
};

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? "");
}

function resolveProviderCommandTemplate(input: {
  provider: string;
  id: ProviderCommandId;
  providerSnapshot?: readonly Pick<ProviderSnapshotEntry, "provider" | "derivedFromProviderId">[];
}): string | undefined {
  const providerTemplate = PROVIDER_COMMAND_TEMPLATES[input.provider]?.[input.id];
  if (providerTemplate) {
    return providerTemplate;
  }

  const derivedFromProviderId = input.providerSnapshot?.find(
    (entry) => entry.provider === input.provider,
  )?.derivedFromProviderId;
  if (derivedFromProviderId) {
    return PROVIDER_COMMAND_TEMPLATES[derivedFromProviderId]?.[input.id];
  }

  return undefined;
}

export function buildProviderCommand(input: {
  provider: string;
  id: ProviderCommandId;
  sessionId: string;
  providerSnapshot?: readonly Pick<ProviderSnapshotEntry, "provider" | "derivedFromProviderId">[];
}): string | null {
  const template = resolveProviderCommandTemplate(input) ?? null;
  if (!template) {
    return null;
  }
  return renderTemplate(template, { sessionId: input.sessionId });
}
