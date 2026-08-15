import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

interface Issue {
  id: string;
  title: string;
  description: string;
  repositoryPath: string;
}

export async function startIssue(client: PaseoClient, issue: Issue) {
  const workspace = await client.workspaces.open(issue.repositoryPath);
  const agent = await workspace.agents.create({
    config: {
      provider: "codex/gpt-5.5",
    },
    title: issue.title,
    labels: {
      "issue-provider": "my-tracker",
      "issue-id": issue.id,
    },
    prompt: [
      `Implement issue ${issue.id}: ${issue.title}`,
      "",
      issue.description,
      "",
      "Run focused tests and summarize the result.",
    ].join("\n"),
  });

  return { workspaceId: workspace.id, agentId: agent.id };
}

export function createClient(url: string): PaseoClient {
  return createPaseoClient({ url });
}
