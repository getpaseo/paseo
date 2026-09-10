import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderCommandId = "resume";

type ResumeSnapshot = Pick<
  ProviderSnapshotEntry,
  "provider" | "derivedFromProviderId" | "launchSource"
>;

export interface ResolveProviderCommandTemplateInput {
  provider: string;
  id: ProviderCommandId;
  providerSnapshot?: readonly ResumeSnapshot[];
}

export interface BuildProviderCommandInput extends ResolveProviderCommandTemplateInput {
  sessionId: string;
}

export interface ResolveProviderResumeCommandInput {
  provider: string;
  sessionId: string;
  supportsProviderAncestry: boolean;
  getProviderSnapshot: () => Promise<readonly ResumeSnapshot[] | undefined>;
}

/**
 * Thrown when a resume command cannot be generated for the provider because it
 * is overridden, unsupported, or ancestry metadata is unavailable.
 */
export class ProviderResumeCommandUnavailableError extends Error {
  constructor(message = "Resume command not available") {
    super(message);
    this.name = "ProviderResumeCommandUnavailableError";
  }
}

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

function resolveProviderCommandTemplate(
  input: ResolveProviderCommandTemplateInput,
): string | undefined {
  const entry = input.providerSnapshot?.find((candidate) => candidate.provider === input.provider);

  // Built-in providers keep their immediate local template unless the snapshot
  // explicitly says the command has been replaced/extended.
  const providerTemplate = PROVIDER_COMMAND_TEMPLATES[input.provider]?.[input.id];
  if (providerTemplate) {
    return isDefaultLaunch(entry) ? providerTemplate : undefined;
  }

  // Custom providers that extend a built-in can only use the inherited template
  // when the snapshot explicitly identifies the ancestor and the command has
  // not been overridden.
  if (entry?.derivedFromProviderId && entry.launchSource === "default") {
    return PROVIDER_COMMAND_TEMPLATES[entry.derivedFromProviderId]?.[input.id];
  }

  return undefined;
}

export function buildProviderCommand(input: BuildProviderCommandInput): string | null {
  const template = resolveProviderCommandTemplate(input) ?? null;
  if (!template) {
    return null;
  }
  return renderTemplate(template, { sessionId: input.sessionId });
}

/**
 * Resolve the resume command for a provider.
 *
 * Built-in providers resolve from the local `PROVIDER_COMMAND_TEMPLATES` without
 * any snapshot, preserving the pre-existing immediate path. Custom providers
 * that extend a built-in require the daemon's `providerAncestry` capability and
 * the provider snapshot to derive the inherited template. If the command is not
 * available, the returned promise rejects with
 * {@link ProviderResumeCommandUnavailableError}.
 */
export async function resolveProviderResumeCommand(
  input: ResolveProviderResumeCommandInput,
): Promise<string> {
  const direct = buildProviderCommand({
    provider: input.provider,
    id: "resume",
    sessionId: input.sessionId,
  });
  if (direct) {
    return direct;
  }

  if (!input.supportsProviderAncestry) {
    throw new ProviderResumeCommandUnavailableError();
  }

  const providerSnapshot = await input.getProviderSnapshot();
  const command = buildProviderCommand({
    provider: input.provider,
    id: "resume",
    sessionId: input.sessionId,
    providerSnapshot,
  });
  if (!command) {
    throw new ProviderResumeCommandUnavailableError();
  }
  return command;
}
