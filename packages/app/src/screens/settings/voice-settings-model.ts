import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableManualVoiceOrchestratorConfig } from "@getpaseo/protocol/messages";

function resolveModeId(input: {
  entry: ProviderSnapshotEntry | undefined;
  current: MutableManualVoiceOrchestratorConfig | undefined;
  provider: AgentProvider;
}): string | null {
  const modes = input.entry?.modes ?? [];
  const selected = modes.find((mode) => mode.id === input.current?.modeId)?.id;
  if (input.current?.provider === input.provider && selected) return selected;
  return input.entry?.defaultModeId ?? modes[0]?.id ?? null;
}

function resolveThinkingOptionId(input: {
  entry: ProviderSnapshotEntry | undefined;
  current: MutableManualVoiceOrchestratorConfig | undefined;
  provider: AgentProvider;
  model: string | null;
}): string | null {
  const definition = input.entry?.models?.find((candidate) => candidate.id === input.model);
  const selected = definition?.thinkingOptions?.find(
    (option) => option.id === input.current?.thinkingOptionId,
  )?.id;
  if (
    input.current?.provider === input.provider &&
    input.current.model === input.model &&
    selected
  ) {
    return selected;
  }
  return (
    definition?.defaultThinkingOptionId ??
    definition?.thinkingOptions?.find((option) => option.isDefault)?.id ??
    null
  );
}

export function resolveVoiceOrchestratorSelection(input: {
  entries: ProviderSnapshotEntry[];
  current: MutableManualVoiceOrchestratorConfig | undefined;
  provider: AgentProvider;
  model: string;
}): MutableManualVoiceOrchestratorConfig | null {
  const entry = input.entries.find((candidate) => candidate.provider === input.provider);
  const modeId = resolveModeId({ entry, current: input.current, provider: input.provider });
  if (!modeId) return null;

  const model = input.model || null;
  const thinkingOptionId = resolveThinkingOptionId({
    entry,
    current: input.current,
    provider: input.provider,
    model,
  });

  return { provider: input.provider, model, modeId, thinkingOptionId };
}
