---
title: SDK recipes
description: Complete patterns for issue integrations, parallel review, resident agents, and safe temporary-agent cleanup.
nav: Recipes
order: 57
category: TypeScript SDK
---

# SDK recipes

Examples use a connected `client` imported from the public package root.

## Turn an issue into visible work

After selecting an issue:

```ts
type Issue = {
  id: string;
  title: string;
  description: string;
  repositoryPath: string;
};

async function startIssue(issue: Issue) {
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
```

Persist the returned IDs in your integration. On the next webhook or page load, recover handles with `workspaces.ref()` and `agents.ref()` instead of creating duplicates.

## Run parallel reviewers

```ts
const prompts = [
  "Review the diff for correctness and missed edge cases.",
  "Review the diff for security and unsafe input handling.",
  "Review the diff for unnecessary complexity.",
];

const reviewers = await Promise.all(
  prompts.map((prompt, index) =>
    client.agents.create({
      config: {
        provider: index === 1 ? "claude/claude-sonnet-5" : "codex/gpt-5.5",
      },
      cwd: process.cwd(),
      title: `Review ${index + 1}`,
      prompt,
    }),
  ),
);

const results = await Promise.all(reviewers.map((reviewer) => reviewer.waitForFinish()));

for (const result of results) {
  console.log(result.status, result.lastMessage);
}
```

## Keep a resident role across process restarts

```ts
async function getPlanner() {
  const listed = await client.agents.list({
    filter: { includeArchived: false },
    page: { limit: 100 },
  });

  const existing = listed.entries.find(({ agent }) => agent.labels["my-app-role"] === "planner");

  if (existing) return client.agents.ref(existing.agent);

  return client.agents.create({
    config: {
      provider: "claude/claude-sonnet-5",
    },
    cwd: process.cwd(),
    title: "Planner",
    labels: { "my-app-role": "planner" },
  });
}

const planner = await getPlanner();
const plan = await planner.run("Plan the next small, shippable improvement.");
```

Labels are application-owned metadata. Namespace keys when several tools may manage agents on the same daemon.

## Clean up temporary agents

```ts
const temporaryAgents = [];

try {
  const agent = await client.agents.create({
    config: {
      provider: "codex/gpt-5.5",
    },
    cwd: process.cwd(),
    title: "Temporary smoke test",
  });
  temporaryAgents.push(agent);

  const result = await agent.run("Reply with READY and nothing else.", {
    timeoutMs: 2 * 60_000,
  });

  if (result.status !== "idle") {
    throw new Error(result.error ?? result.status);
  }
} finally {
  await Promise.allSettled(temporaryAgents.map((agent) => agent.archive()));
}
```

Do not archive agents your integration did not create.
