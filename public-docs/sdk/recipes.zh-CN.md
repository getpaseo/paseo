---
title: SDK 示例
description: issue 集成、并行审查、常驻 Agent 以及安全清理临时 Agent 的完整模式。
nav: 示例
---

# SDK 示例 {#sdk-recipes}

示例中使用的是一个已连接的 `client`，从公开包的根入口导入。

## 把 issue 变成可见的工作 {#turn-an-issue-into-visible-work}

选定一个 issue 之后：

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

在你的集成中保存返回的 ID。在下一次 webhook 或页面加载时，用 `workspaces.ref()` 和 `agents.ref()` 找回句柄，而不是重复创建。

## 运行并行审查者 {#run-parallel-reviewers}

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

## 在进程重启之间保留常驻角色 {#keep-a-resident-role-across-process-restarts}

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

标签是由应用自己管理的元数据。当多个工具可能在同一个 daemon 上管理 Agent 时，请为键加上命名空间。

## 清理临时 Agent {#clean-up-temporary-agents}

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

不要归档不是由你的集成创建的 Agent。
