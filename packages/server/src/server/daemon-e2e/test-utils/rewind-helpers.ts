import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { DaemonClient } from "../../test-utils/daemon-client.js";

export interface RewindSessionBase {
  agentId: string;
  cwd: string;
  scratchPath?: string;
}

export function tmpRewindCwd(prefix: string, options?: { realpath?: boolean }): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return options?.realpath ? realpathSync(dir) : dir;
}

export function closeRewindSession(session: RewindSessionBase): void {
  rmSync(session.cwd, { recursive: true, force: true });
}

export function timelineItems(
  timeline: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
): AgentTimelineItem[] {
  return timeline.entries.map((entry) => entry.item);
}

export function textByRole(
  items: AgentTimelineItem[],
  role: "user_message" | "assistant_message",
): string {
  return items
    .filter((item) => item.type === role)
    .map((item) => item.text)
    .join("\n");
}

export function userMessageIdForToken(items: AgentTimelineItem[], token: string): string {
  const item = items.find(
    (candidate) => candidate.type === "user_message" && candidate.text.includes(token),
  );
  if (!item?.messageId) {
    throw new Error(`Timeline did not contain a user message id for ${token}`);
  }
  return item.messageId;
}

export async function fetchTimelineItems(
  client: DaemonClient,
  agentId: string,
): Promise<AgentTimelineItem[]> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return timelineItems(timeline);
}

export async function readScratchFile(session: { scratchPath: string }): Promise<string> {
  return await readFile(session.scratchPath, "utf8");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForTimelineItems(
  client: DaemonClient,
  agentId: string,
  predicate: (items: AgentTimelineItem[]) => boolean,
): Promise<AgentTimelineItem[]> {
  const existingItems = await fetchTimelineItems(client, agentId);
  if (predicate(existingItems)) {
    return existingItems;
  }

  return await new Promise<AgentTimelineItem[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for timeline items for ${agentId}`));
    }, 60_000);
    const unsubscribe = client.on("agent_update", (message) => {
      if (message.payload.kind !== "upsert" || message.payload.agent.id !== agentId) {
        return;
      }
      void (async () => {
        try {
          const items = await fetchTimelineItems(client, agentId);
          if (!predicate(items)) {
            return;
          }
          clearTimeout(timeout);
          unsubscribe();
          resolve(items);
        } catch (error) {
          clearTimeout(timeout);
          unsubscribe();
          reject(error);
        }
      })();
    });
  });
}
