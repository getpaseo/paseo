import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { seedWorkspace, type SeedDaemonClient } from "./seed-client";
import { getServerId } from "./server-id";

export interface MockAgentWorkspace {
  agentId: string;
  workspaceId: string;
  cwd: string;
  client: SeedDaemonClient;
  cleanup(): Promise<void>;
}

export interface MockAgentOptions {
  repoPrefix: string;
  title: string;
  initialPrompt?: string;
  model?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
}

/**
 * Seeds a temp git repo, opens it as a project, and creates a ready mock-provider
 * agent in it via the daemon. Returns the agent id plus a cleanup that closes the
 * client and removes the repo. Pair with {@link openAgentRoute} to drive the UI.
 */
export async function seedMockAgentWorkspace(
  options: MockAgentOptions,
): Promise<MockAgentWorkspace> {
  const workspace = await seedWorkspace({ repoPrefix: options.repoPrefix });
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: options.title,
      modeId: options.modeId ?? "load-test",
      model: options.model ?? "ten-second-stream",
      initialPrompt: options.initialPrompt,
      featureValues: options.featureValues,
    });
    return {
      agentId: agent.id,
      workspaceId: workspace.workspaceId,
      cwd: workspace.repoPath,
      client: workspace.client,
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

export function buildAgentRoute(workspaceId: string, agentId: string): string {
  return `${buildHostWorkspaceRoute(getServerId(), workspaceId)}?open=${encodeURIComponent(
    `agent:${agentId}`,
  )}`;
}

/** Boots the app directly at the agent's workspace route and waits for the open intent to settle. */
export async function openAgentRoute(
  page: Page,
  input: { workspaceId: string; agentId: string },
): Promise<void> {
  await page.goto(buildAgentRoute(input.workspaceId, input.agentId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
}
