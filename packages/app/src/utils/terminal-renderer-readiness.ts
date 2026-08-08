export interface TerminalRendererReadyChange {
  streamKey: string;
  isReady: boolean;
}

export function applyTerminalRendererReadyChange(
  currentReadyStreamKey: string | null,
  change: TerminalRendererReadyChange,
): string | null {
  if (change.isReady) {
    return change.streamKey;
  }

  return currentReadyStreamKey === change.streamKey ? null : currentReadyStreamKey;
}

export function shouldReplayTerminalSnapshotForRenderer(input: {
  change: TerminalRendererReadyChange;
  terminalStreamKey: string;
}): boolean {
  return input.change.isReady && input.change.streamKey === input.terminalStreamKey;
}

export function resolveTerminalStreamTarget(input: {
  terminalId: string;
  terminalStreamKey: string;
  rendererReadyStreamKey: string | null;
  isWorkspaceFocused: boolean;
}): string | null {
  return input.isWorkspaceFocused && input.rendererReadyStreamKey === input.terminalStreamKey
    ? input.terminalId
    : null;
}

export function shouldShowTerminalLoadingOverlay(input: {
  isWorkspaceFocused: boolean;
  hasStreamError: boolean;
  isAttaching: boolean;
  rendererReadyStreamKey: string | null;
  terminalStreamKey: string;
}): boolean {
  return (
    input.isWorkspaceFocused &&
    !input.hasStreamError &&
    (input.isAttaching || input.rendererReadyStreamKey !== input.terminalStreamKey)
  );
}
