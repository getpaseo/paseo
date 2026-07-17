export const SESSION_STALE_AFTER_MS = 60_000;

export async function revalidateSessionAfterResume(input: {
  awayMs: number;
  serverId: string;
  bumpHistorySyncGeneration: (serverId: string) => void;
  refreshDirectories: () => Promise<unknown>;
}): Promise<boolean> {
  if (input.awayMs < SESSION_STALE_AFTER_MS) {
    return false;
  }

  input.bumpHistorySyncGeneration(input.serverId);
  await input.refreshDirectories();
  return true;
}
