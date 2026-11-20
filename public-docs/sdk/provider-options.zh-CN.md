---
title: Provider 选项
description: 从 SDK 创建的 Codex、Claude 和 OpenCode Agent 的沙箱、权限和网络规则。
nav: Provider 选项
---

# Provider 选项 {#provider-options}

Provider 选项是传给 Provider 的一个不透明的 `Record<string, unknown>`。如何校验和应用它由 Provider 决定。Claude、Codex 和 OpenCode 使用严格的 schema：未知或拼错的键会使 Agent 创建失败，并在错误信息中指出该键。不处理选项的 Provider 会忽略这个记录。Pi、OMP、ACP 和插件 Provider 会解释它们自己的键。

你可以在两个地方设置选项：

- **Provider 默认值**：`config.json` → `agents.providers.<id>.options`。
- **单个 Agent**：`client.agents.create()` 中的 `config.options`。它在协议中的名称是 `providerOptions`。

在会话启动或恢复时，daemon 会把 Agent 的选项深度合并到 Provider 默认值之上。普通对象递归合并；数组、标量和 `null` 会替换基础值。只有 Agent 自己的选项会被保存。修改 `config.json` 中的默认值会在下次启动或恢复时生效。

例如，先设置一次 Codex 默认值：

```json
{
  "agents": {
    "providers": {
      "codex": {
        "options": {
          "sandbox_mode": "read-only",
          "approval_policy": "never",
          "sandbox_workspace_write": { "network_access": false }
        }
      }
    }
  }
}
```

然后用 `config.options: { sandbox_mode: "workspace-write" }` 创建一个 Agent。它会得到 `workspace-write`，同时保留 `approval_policy: "never"` 和 `sandbox_workspace_write.network_access: false`。没有单独选项的 Agent 会得到上面的默认值。键是 Provider 原生的；各 Provider 接受的选项见下面各节。

Provider 选项不是主机边界。它们约束的是 Agent CLI，而 Agent CLI 以你的用户身份运行在你的机器上。对于不受信任的工作，请在容器或单独的机器上运行 daemon。参见[安全](/docs/security)。

## Codex {#codex}

把写入限制在一个目录内，切断网络访问，并停止审批提示，让运行可以无人值守：

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
    options: {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/Users/me/dev/storefront"],
        network_access: false,
        exclude_slash_tmp: true,
      },
      web_search: "disabled",
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Fix the failing checkout test.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

| 选项                      | 取值                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| `approval_policy`         | `untrusted`、`on-request`、`never` 或 `{ granular: { … } }`                       |
| `sandbox_mode`            | `read-only`、`workspace-write`、`danger-full-access`                              |
| `sandbox_workspace_write` | `writable_roots`、`network_access`、`exclude_slash_tmp`、`exclude_tmpdir_env_var` |
| `web_search`              | `disabled`、`cached`、`indexed`、`live`                                           |
| `features`                | `multi_agent_v2`、`network_proxy`（布尔值，或代理/域名策略对象）                  |

`approval_policy: "never"` 只是去掉了提示。Agent 被允许接触什么由 `sandbox_mode` 决定。设置 `never` 而不设置沙箱模式，会让无人值守的 Agent 拥有完全访问权限。

## Claude {#claude}

开启 Claude 自己的沙箱，把写入限制在项目内，禁止读取凭据目录，并只允许两个域名：

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
    options: {
      disallowedTools: ["WebFetch"],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          allowWrite: ["/Users/me/dev/storefront"],
          denyRead: ["/Users/me/.ssh", "/Users/me/.aws"],
        },
        network: {
          allowedDomains: ["registry.npmjs.org", "github.com"],
          strictAllowlist: true,
        },
      },
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Install dependencies and run the focused test.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

| 选项                    | 取值                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `allowedTools`          | Agent 可以不经询问就使用的工具名称                                                                      |
| `disallowedTools`       | Agent 永远不能使用的工具名称                                                                            |
| `additionalDirectories` | Agent 可以访问的额外目录                                                                                |
| `sandbox`               | `enabled`、`failIfUnavailable`、`allowUnsandboxedCommands`、`excludedCommands`、`filesystem`、`network` |
| `settings`              | `permissions`（`allow`/`ask`/`deny` 规则列表）以及嵌套的 `sandbox`                                      |

`failIfUnavailable: true` 会在无法建立沙箱时让 Agent 启动失败。不设置时，Claude 会在没有沙箱的情况下运行。

`sandbox.filesystem` 接受 `allowWrite`、`denyWrite`、`allowRead` 和 `denyRead`。`sandbox.network` 接受 `allowedDomains`、`deniedDomains`、`strictAllowlist` 以及代理设置。

## OpenCode {#opencode}

允许读取和编辑，禁止任何超出项目范围的访问，并按模式控制 shell 命令：

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: {
    provider: "opencode/opencode/gpt-5.5",
    options: {
      permission: {
        read: "allow",
        edit: "allow",
        webfetch: "deny",
        external_directory: "deny",
        bash: {
          "git status": "allow",
          "git diff*": "allow",
          "git push*": "deny",
          "*": "ask",
        },
      },
    },
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Implement the requested change and show me the diff.",
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);

await client.close();
```

每项权限的取值是 `ask`、`allow` 或 `deny`。带有目标的工具（`read`、`edit`、`glob`、`grep`、`list`、`bash`、`task`、`external_directory`、`repo_clone`、`repo_overview`、`lsp`、`skill`）还接受一个模式映射，其中后面的键作为兜底。没有目标的工具（`todowrite`、`question`、`webfetch`、`websearch`、`codesearch`、`doom_loop`）只接受单个操作值。

把 `permission: "deny"` 写成单个字符串，会一次性应用到所有工具。

`ask` 会在 Paseo 中变成一个权限请求，请求待处理期间 `waitForFinish()` 返回 `permission`。无人值守的运行请使用 `allow` 和 `deny`。如何响应待处理的请求，请参见[事件](/docs/sdk/events)。

## 模式与选项 {#modes-and-options}

`modeId` 从 Provider 公布的列表中选择一个 Paseo 模式，daemon 会在应用中显示这个列表，并通过 [Provider 发现](/docs/sdk/providers)报告它。`options` 是 Provider 自己的配置。两者是独立的控制项，可以同时设置：

```ts
config: {
  provider: "codex/gpt-5.5",
  modeId: "full-access",
  options: {
    approval_policy: "never",
    sandbox_mode: "read-only",
  },
}
```

两者重叠时，以 `options` 为准。上例中，即使 `full-access` 本来会授予更多权限，Codex 仍以只读方式运行。
