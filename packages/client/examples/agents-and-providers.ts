import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

export function createClient(url: string): PaseoClient {
  return createPaseoClient({
    url,
  });
}

export async function createCodexAgent(url: string, cwd: string): Promise<string> {
  const client = createClient(url);

  try {
    await client.connect();

    const agent = await client.agents.create({
      config: {
        provider: "codex/gpt-5.5",
        modeId: "full-access",
      },
      cwd,
      prompt: "Inspect this repository and summarize the next useful task.",
    });

    return agent.id;
  } finally {
    await client.close();
  }
}

export async function chooseProviderFromSnapshot(url: string, cwd: string): Promise<string> {
  const client = createClient(url);

  try {
    await client.connect();

    const snapshot = await client.providers.waitForReady({ cwd });
    const readyProvider = snapshot.entries.find((provider) => provider.status === "ready");
    const model =
      readyProvider?.models?.find((candidate) => candidate.isDefault) ?? readyProvider?.models?.[0];
    if (!readyProvider || !model) throw new Error("No provider model is ready");

    const agent = await client.agents.create({
      config: {
        provider: `${readyProvider.provider}/${model.id}`,
      },
      cwd,
      prompt: "Start with a quick repository map.",
    });

    return agent.id;
  } finally {
    await client.close();
  }
}

export async function runFollowUp(url: string, agentId: string): Promise<string | null> {
  const client = createClient(url);

  try {
    await client.connect();
    const result = await client.agents.ref(agentId).run("Summarize your progress and next step.");
    if (result.status !== "idle") throw new Error(result.error ?? result.status);
    return result.lastMessage;
  } finally {
    await client.close();
  }
}
