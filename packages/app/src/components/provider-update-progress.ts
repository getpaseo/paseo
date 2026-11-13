import type {
  ProviderInstallationUpdate,
  ProviderInstallationUpdateOutput,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";

/** Characters of update output the app keeps, matching what the daemon retains. */
export const PROVIDER_UPDATE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Folds a progress message into the update it belongs to; a new operation starts empty. Output
 * beyond `outputLimit` characters drops oldest first and marks the update truncated, so a noisy
 * updater cannot grow the screen's memory while it stays open.
 */
export function applyProviderUpdateProgress(
  current: ProviderInstallationUpdate | null,
  progress: ProviderInstallationUpdateProgress,
  options: { outputLimit: number } = { outputLimit: PROVIDER_UPDATE_OUTPUT_LIMIT },
): ProviderInstallationUpdate {
  const previous = current?.operation.id === progress.operation.id ? current : null;
  const limit = options.outputLimit;
  const output: ProviderInstallationUpdateOutput[] = [
    ...(previous?.output ?? []),
    ...progress.output,
  ];
  let length = output.reduce((total, entry) => total + entry.text.length, 0);
  let truncated = previous?.truncated ?? false;
  while (length > limit && output.length > 1) {
    length -= output.shift()!.text.length;
    truncated = true;
  }
  const last = output.at(-1);
  if (last && last.text.length > limit) {
    output[output.length - 1] = { type: last.type, text: last.text.slice(-limit) };
    truncated = true;
  }
  return { operation: progress.operation, output, ...(truncated ? { truncated: true } : {}) };
}
