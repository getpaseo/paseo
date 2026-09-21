import type { AgentArtifact } from "@getpaseo/protocol/agent-types";
import type { CompanionEntry } from "@getpaseo/protocol/companion-stream";

export type CompanionFeedItem =
  | { id: string; kind: "artifact"; timestamp: string; artifact: AgentArtifact }
  | { id: string; kind: "entry"; timestamp: string; entry: CompanionEntry };

export function buildCompanionFeed(
  entries: readonly CompanionEntry[],
  artifacts: readonly AgentArtifact[],
): CompanionFeedItem[] {
  return [
    ...entries.map(
      (entry): CompanionFeedItem => ({
        id: entry.id,
        kind: "entry",
        timestamp: entry.timestamp,
        entry,
      }),
    ),
    ...artifacts.map(
      (artifact): CompanionFeedItem => ({
        id: `artifact:${artifact.path}`,
        kind: "artifact",
        timestamp: artifact.updatedAt,
        artifact,
      }),
    ),
  ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}
