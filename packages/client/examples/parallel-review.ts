import type { PaseoAgentHandle, PaseoClient } from "@getpaseo/client";

export async function reviewInParallel(client: PaseoClient, cwd: string): Promise<string[]> {
  const agents: PaseoAgentHandle[] = [];

  try {
    agents.push(
      ...(await Promise.all([
        client.agents.create({
          config: {
            provider: "codex/gpt-5.5",
          },
          cwd,
          title: "Correctness review",
          prompt: "Review the current diff for correctness and missed edge cases.",
        }),
        client.agents.create({
          config: {
            provider: "claude/claude-sonnet-5",
          },
          cwd,
          title: "Security review",
          prompt: "Review the current diff for security and unsafe input handling.",
        }),
      ])),
    );

    const results = await Promise.all(agents.map((agent) => agent.waitForFinish()));

    return results.map((result) => {
      if (result.status !== "idle") throw new Error(result.error ?? result.status);
      return result.lastMessage ?? "";
    });
  } finally {
    await Promise.allSettled(agents.map((agent) => agent.archive()));
  }
}
