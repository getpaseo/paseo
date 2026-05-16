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
        ...client.providers.codex({
          model: "gpt-5.2",
          modeId: "full-auto",
        }),
        cwd,
      },
      initialPrompt: "Inspect this repository and summarize the next useful task.",
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

    const snapshot = await client.providers.snapshot({ cwd });
    const readyProvider = snapshot.entries.find((provider) => provider.status === "ready");
    const providerConfig = readyProvider
      ? client.providers.config(readyProvider.provider)
      : client.providers.claude();

    const agent = await client.agents.create({
      config: {
        ...providerConfig,
        cwd,
      },
      initialPrompt: "Start with a quick repository map.",
    });

    return agent.id;
  } finally {
    await client.close();
  }
}
