export type LiveVoiceBackgroundCallAction = "toggleMute" | "end";

export function isLiveVoiceBackgroundCallSupported(): boolean {
  return false;
}

export function beginLiveVoiceBackgroundCall(): Promise<void> {
  return Promise.resolve();
}

export function updateLiveVoiceBackgroundCall(_params: { isMuted: boolean }): Promise<void> {
  return Promise.resolve();
}

export function endLiveVoiceBackgroundCall(): Promise<void> {
  return Promise.resolve();
}

export function subscribeLiveVoiceBackgroundCallActions(
  _listener: (action: LiveVoiceBackgroundCallAction) => void,
): () => void {
  return () => undefined;
}
