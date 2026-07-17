export const SESSION_STALE_AFTER_MS = 60_000;

export async function revalidateSessionAfterResume(input: {
  awayMs: number;
  serverId: string;
  bumpHistorySyncGeneration: (serverId: string) => void;
  refreshAgentDirectory: () => Promise<unknown>;
  hydrateWorkspaces: () => Promise<void>;
}): Promise<boolean> {
  if (input.awayMs < SESSION_STALE_AFTER_MS) {
    return false;
  }

  input.bumpHistorySyncGeneration(input.serverId);
  await Promise.all([input.refreshAgentDirectory(), input.hydrateWorkspaces()]);
  return true;
}
