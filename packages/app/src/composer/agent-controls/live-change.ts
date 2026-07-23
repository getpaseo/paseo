export interface LiveAgentControlChange<Result> {
  apply(): Promise<Result>;
  persist(): Promise<void>;
  onApplied?(result: Result): void;
}

export async function runLiveAgentControlChange<Result>(
  change: LiveAgentControlChange<Result>,
): Promise<void> {
  const result = await change.apply();
  change.onApplied?.(result);
  await change.persist();
}
