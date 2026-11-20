---
title: 在 SDK 中使用 Provider
description: 选择 Provider 和模型，发现可用的配置，并配置 Agent 会话。
nav: Provider
---

# 在 SDK 中使用 Provider {#providers-with-the-sdk}

每个 Agent 配置都同时指定 Provider 和模型：

```ts
config: {
  provider: "codex/gpt-5.5",
}
```

第一个 `/` 把 Provider 和模型分开。模型 ID 中可以包含更多斜杠。

## 配置会话 {#configure-a-session}

```ts
const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: {
      web_search: false,
    },
  },
  cwd: process.cwd(),
  prompt: "Implement the accepted plan and run focused tests.",
});
```

| 字段               | 含义                                          |
| ------------------ | --------------------------------------------- |
| `provider`         | 必填，`provider/model` 选择。                 |
| `modeId`           | Provider 的运行模式或权限模式。               |
| `thinkingOptionId` | Provider 的推理级别。                         |
| `featureValues`    | `providers.listFeatures()` 返回的功能的取值。 |
| `options`          | Provider 原生设置，例如沙箱和权限规则。       |
| `systemPrompt`     | 额外的系统或开发者指令。                      |
| `mcpServers`       | 会话级的 MCP 服务器。                         |
| `toolPolicy`       | MCP 工具的精确预批准规则。                    |

[Provider 选项](/docs/sdk/provider-options)列出了可接受的沙箱和权限设置。

## 发现已安装的 Provider 和模型 {#discover-installed-providers-and-models}

```ts
const snapshot = await client.providers.waitForReady({
  cwd: process.cwd(),
  timeoutMs: 60_000,
});

for (const entry of snapshot.entries) {
  if (entry.status !== "ready") continue;

  for (const model of entry.models ?? []) {
    console.log(`${entry.provider}/${model.id}`);
  }
}
```

每个条目最终的状态是 `ready`、`unavailable` 或 `error`。`snapshot()` 会立即返回，可能包含 `loading` 状态的条目。

## 选择发现的模型 {#select-a-discovered-model}

```ts
const snapshot = await client.providers.waitForReady({ cwd: process.cwd() });
const entry = snapshot.entries.find((candidate) => candidate.status === "ready");
const model = entry?.models?.find((candidate) => candidate.isDefault) ?? entry?.models?.[0];

if (!entry || !model) throw new Error("No provider model is ready");

const agent = await client.agents.create({
  config: {
    provider: `${entry.provider}/${model.id}`,
  },
  cwd: process.cwd(),
  prompt: "Summarize this repository.",
});
```

## 发现模式、思考级别和功能 {#discover-modes-thinking-levels-and-features}

```ts
const models = await client.providers.listModels("codex", { cwd: process.cwd() });
const modes = await client.providers.listModes("codex", { cwd: process.cwd() });

const selectedModel = models.models[0]?.id;
const selectedMode = modes.modes[0]?.id;
if (!selectedModel) throw new Error("No Codex model is available");

const features = await client.providers.listFeatures({
  provider: `codex/${selectedModel}`,
  cwd: process.cwd(),
  modeId: selectedMode,
});
```

请使用 daemon 返回的 ID。不同主机上安装的 Provider 和配置的模型各不相同。

## 诊断不可用的 Provider {#diagnose-an-unavailable-provider}

```ts
const result = await client.providers.diagnostic("codex");
console.error(result.diagnostic);
```

主机级的配置、二进制文件、凭据和自定义 Provider 属于[自定义 Provider](/docs/custom-providers)的内容。
