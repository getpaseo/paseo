import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

export function createClient(url: string): PaseoClient {
  return createPaseoClient({
    url,
  });
}

export async function subscribeToEvents(
  url: string,
  agentId: string,
  workspaceId: string,
): Promise<() => void> {
  const client = createClient(url);
  await client.connect();

  await client.workspaces.list({
    subscribe: { subscriptionId: `workspace-${workspaceId}` },
  });

  const unsubscribeAgentUpdates = client.agents.subscribe((update) => {
    if (update.kind === "upsert" && update.agent.id === agentId) {
      void update.agent.status;
    }
  });

  const unsubscribeWorkspaceUpdates = client.workspaces.subscribe((update) => {
    if (update.kind === "upsert" && update.workspace.id === workspaceId) {
      void update.workspace.workspaceDirectory;
    }
  });

  const unsubscribeTimeline = client.agents.ref(agentId).timeline.subscribe((event) => {
    void event.event;
  });

  return () => {
    unsubscribeTimeline();
    unsubscribeWorkspaceUpdates();
    unsubscribeAgentUpdates();
    void client.close();
  };
}

export async function refetchTimeline(url: string, agentId: string): Promise<number> {
  const client = createClient(url);

  try {
    await client.connect();

    const timeline = await client.agents.ref(agentId).timeline.refetch({
      direction: "before",
      limit: 50,
      projection: "projected",
    });

    return timeline.entries.length;
  } finally {
    await client.close();
  }
}
