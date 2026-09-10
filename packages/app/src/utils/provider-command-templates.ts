import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderCommandId = "resume";

type ResumeSnapshot = Pick<
  ProviderSnapshotEntry,
  "provider" | "derivedFromProviderId" | "launchSource"
>;

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

function isDefaultLaunch(entry: ResumeSnapshot | undefined): boolean {
  // launchSource is absent on old-daemons and pre-v3 caches; treat unknown as
  // default so the feature degrades to the previous behavior rather than
  // refusing a command for already-cached snapshots after this code ships.
  return entry == null || entry.launchSource == null || entry.launchSource === "default";
}

function resolveProviderCommandTemplate(input: {
  provider: string;
  id: ProviderCommandId;
  providerSnapshot?: readonly ResumeSnapshot[];
}): string | undefined {
  const entry = input.providerSnapshot?.find((candidate) => candidate.provider === input.provider);

  // Built-in providers keep their immediate local template unless the snapshot
  // explicitly says the command has been replaced/extended.
  const providerTemplate = PROVIDER_COMMAND_TEMPLATES[input.provider]?.[input.id];
  if (providerTemplate) {
    return isDefaultLaunch(entry) ? providerTemplate : undefined;
  }

  // Custom providers that extend a built-in can only use the inherited template
  // when the snapshot is available and the command has not been overridden.
  if (isDefaultLaunch(entry) && entry?.derivedFromProviderId) {
    return PROVIDER_COMMAND_TEMPLATES[entry.derivedFromProviderId]?.[input.id];
  }

  return undefined;
}

export function buildProviderCommand(input: {
  provider: string;
  id: ProviderCommandId;
  sessionId: string;
  providerSnapshot?: readonly ResumeSnapshot[];
}): string | null {
  const template = resolveProviderCommandTemplate(input) ?? null;
  if (!template) {
    return null;
  }
  return renderTemplate(template, { sessionId: input.sessionId });
}

/**
 * Resolve the resume command for a provider.
 *
 * Built-in providers resolve from the local `PROVIDER_COMMAND_TEMPLATES`, but
 * the cached provider snapshot is consulted first to detect command overrides.
 * Custom providers that extend a built-in require the daemon's
 * `providerAncestry` capability and a provider snapshot to derive the inherited
 * template. If the command is not available, the returned promise rejects.
 */
export async function resolveProviderResumeCommand(input: {
  provider: string;
  sessionId: string;
  supportsProviderAncestry: boolean;
  cachedProviderSnapshot?: readonly ResumeSnapshot[];
  getProviderSnapshot: () => Promise<readonly ResumeSnapshot[] | undefined>;
}): Promise<string> {
  const direct = buildProviderCommand({
    provider: input.provider,
    id: "resume",
    sessionId: input.sessionId,
    providerSnapshot: input.cachedProviderSnapshot,
  });
  if (direct) {
    return direct;
  }

  // A built-in provider is in the cached snapshot with a non-default launch
  // source, so the stock resume command is not safe to copy.
  if (PROVIDER_COMMAND_TEMPLATES[input.provider]?.resume) {
    throw new Error("Resume command not available");
  }

  if (!input.supportsProviderAncestry) {
    throw new Error("Resume command not available");
  }

  const providerSnapshot = await input.getProviderSnapshot();
  const command = buildProviderCommand({
    provider: input.provider,
    id: "resume",
    sessionId: input.sessionId,
    providerSnapshot,
  });
  if (!command) {
    throw new Error("Resume command not available");
  }
  return command;
}
