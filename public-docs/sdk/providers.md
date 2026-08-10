---
title: Providers with the SDK
description: Select a provider and model, discover available configurations, and configure an agent session.
nav: Providers
order: 54
category: TypeScript SDK
---

# Providers with the SDK

Every agent configuration names both the provider and model:

```ts
config: {
  provider: "codex/gpt-5.5",
}
```

The first `/` separates the provider from the model. Model IDs can contain additional slashes.

## Configure a session

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

| Field              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `provider`         | Required `provider/model` selection.                           |
| `modeId`           | Provider operating or permission mode.                         |
| `thinkingOptionId` | Provider reasoning level.                                      |
| `featureValues`    | Values for features returned by `providers.listFeatures()`.    |
| `options`          | Provider-native settings such as sandbox and permission rules. |
| `systemPrompt`     | Additional system or developer instructions.                   |
| `mcpServers`       | Session-scoped MCP servers.                                    |
| `toolPolicy`       | Exact preapproval rules for MCP tools.                         |

[Provider options](/docs/sdk/provider-options) lists the accepted sandbox and permission settings.

## Discover installed providers and models

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

An entry finishes as `ready`, `unavailable`, or `error`. `snapshot()` returns immediately and can include `loading` entries.

## Select a discovered model

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

## Discover modes, thinking levels, and features

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

Use IDs returned by the daemon. Provider installations and configured models differ between hosts.

## Diagnose an unavailable provider

```ts
const result = await client.providers.diagnostic("codex");
console.error(result.diagnostic);
```

Host-level profiles, binaries, credentials, and custom providers belong in [Custom providers](/docs/custom-providers).
