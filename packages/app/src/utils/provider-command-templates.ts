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

function antigravityConversationId(handle: string, storedPersistence: unknown): string | null {
  let persisted = storedPersistence;
  if (persisted === undefined) {
    if (!handle.startsWith("plugin:")) return null;
    try {
      persisted = JSON.parse(handle.slice("plugin:".length));
    } catch {
      return null;
    }
  }
  const persistence = persisted as {
    version?: unknown;
    data?: { sessionId?: unknown; conversationId?: unknown };
  } | null;
  if (!persistence || persistence.version !== 1) return null;
  // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
  const nativeId = persistence.data?.sessionId ?? persistence.data?.conversationId;
  // The ID is pasted into a shell as a positional argument.
  return typeof nativeId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$(?!\s)/.test(nativeId)
    ? nativeId
    : null;
}

export function buildProviderCommand(input: {
  provider: string;
  id: ProviderCommandId;
  sessionId: string;
  pluginPersistence?: unknown;
}): string | null {
  if (input.provider === "antigravity") {
    const sessionId = antigravityConversationId(input.sessionId, input.pluginPersistence);
    return sessionId === null ? null : `agy --conversation ${sessionId}`;
  }
  const template = PROVIDER_COMMAND_TEMPLATES[input.provider]?.[input.id] ?? null;
  if (!template) {
    return null;
  }
  return renderTemplate(template, { sessionId: input.sessionId });
}
