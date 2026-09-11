import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderCommandId = "resume";

type ResumeSnapshot = Pick<
  ProviderSnapshotEntry,
  "provider" | "derivedFromProviderId" | "canUseDefaultResumeCommand"
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

export type ResolveProviderResumeCommandOutcome =
  | { status: "ready"; command: string }
  | { status: "unavailable" }
  | { status: "failed"; error: unknown };

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
  return entry?.canUseDefaultResumeCommand === true;
}

function resolveProviderCommandTemplate(
  input: ResolveProviderCommandTemplateInput,
): string | undefined {
  const entry = input.providerSnapshot?.find((candidate) => candidate.provider === input.provider);

  const providerTemplate = PROVIDER_COMMAND_TEMPLATES[input.provider]?.[input.id];
  if (providerTemplate) {
    return input.providerSnapshot === undefined || isDefaultLaunch(entry)
      ? providerTemplate
      : undefined;
  }

  // Custom providers that extend a built-in can only use the inherited template
  // when the snapshot explicitly identifies the ancestor and reports that the
  // default resume command is safe to use.
  if (entry?.derivedFromProviderId && entry.canUseDefaultResumeCommand === true) {
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
 * Built-in resume templates are existing functionality: without the
 * `providerAncestry` capability, resolve them locally and never issue a
 * snapshot RPC. Only ancestry-based inherited custom-provider resolution is
 * gated on the capability. Daemons advertising `providerAncestry` provide the
 * authoritative safety classification through their snapshot. If the command
 * is not available, the returned promise rejects with
 * {@link ProviderResumeCommandUnavailableError}.
 */
export async function resolveProviderResumeCommand(
  input: ResolveProviderResumeCommandInput,
): Promise<string> {
  if (!input.supportsProviderAncestry) {
    const localCommand = buildProviderCommand({
      provider: input.provider,
      id: "resume",
      sessionId: input.sessionId,
    });
    if (!localCommand) {
      throw new ProviderResumeCommandUnavailableError();
    }
    return localCommand;
  }

  const providerSnapshot = await input.getProviderSnapshot();
  if (!providerSnapshot) {
    throw new ProviderResumeCommandUnavailableError();
  }
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

export async function resolveProviderResumeCommandOutcome(
  input: ResolveProviderResumeCommandInput,
): Promise<ResolveProviderResumeCommandOutcome> {
  try {
    const command = await resolveProviderResumeCommand(input);
    return { status: "ready", command };
  } catch (error) {
    if (error instanceof ProviderResumeCommandUnavailableError) {
      return { status: "unavailable" };
    }
    return { status: "failed", error };
  }
}
