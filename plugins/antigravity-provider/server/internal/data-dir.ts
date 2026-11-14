import os from "node:os";
import path from "node:path";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";

export function resolveAntigravityDataDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const relDir = env.ANTIGRAVITY_CONFIG_REL_DIR?.trim() || "antigravity-cli";
  return path.resolve(home, ".gemini", relDir);
}

export function resolveConversationTranscriptPath(dataDir: string, conversationId: string): string {
  return path.join(
    dataDir,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

export function resolveConversationDatabasePath(dataDir: string, conversationId: string): string {
  return path.join(dataDir, "conversations", `${conversationId}.db`);
}

export function accountLocatorKey(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const accountHint = env.AGY_ACCOUNT?.trim();
  return hashAccountKey(accountHint ? `${dataDir}::${accountHint}` : dataDir);
}
