---
title: Hub workflow
description: 用提示词、路由、输出和 Provider 权限构建有序的 Hub workflow。
nav: Workflow
---

# Hub workflow {#hub-workflows}

一个 workflow 文件包含一个触发器，以及它启动的有序 step。文件从 `.paseo/workflows/*.yml` 中发现。

## 你的第一个 workflow {#your-first-workflow}

假设 `.paseo/hub.yml` 定义了一个名为 `dev` 的环境和一个名为 `codex` 的 Agent。添加 `.paseo/workflows/slack-help.yml`：

```yaml
name: slack-help
on: slack.mention
max_runtime: 1h
filters:
  workspace: T01234567
  channels: [C01234567]
  from_users: [U01234567]
steps:
  - id: answer
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Answer the request. Call hub.reply once, then call hub.finish_execution.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
    allow_outputs:
      - { type: slack.reply, max: 1, required: true }
```

Hub 会先去掉提及和已声明的输入头部，再把剩余文本作为 `${{ paseo.prompt }}` 提供。回复能力在 Slack 触发器旁边显式声明。Discord 使用 `discord.reply`；GitHub 使用 step 级的 [`github` 块](/docs/hub/github)，而不是 `hub.reply`。

## 选择 step 在哪里运行 {#choose-where-a-step-runs}

字面值选择一个命名环境：

```yaml
environment: dev
```

有限取值的输入可以在多个完整的命名环境中选择：

```yaml
name: route-repository
on: manual.run
max_runtime: 1h
filters:
  from_users: [automation]
inputs:
  repo:
    type: string
    required: true
    choices: [paseo, hub]
steps:
  - id: work
    environment: ${{ paseo.inputs.repo }}
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: ${{ paseo.prompt }}
```

激活时会检查每一个 `choices` 结果。环境对象永远不会被 workflow 合并或覆盖。

## 选择 Agent {#choose-an-agent}

step 可以选择一个命名 Agent：

```yaml
agent: codex-safe
```

也可以提供一份完整的静态内联配置：

```yaml
agent:
  provider: claude
  mode: full-access
```

对于动态路由，用一个有限取值的表达式在多个完整的命名 Agent 中选择：

```yaml
name: route-agent
on: manual.run
max_runtime: 1h
filters:
  from_users: [automation]
inputs:
  agent:
    type: string
    required: true
    choices: [codex-safe, claude]
steps:
  - id: work
    environment: paseo
    max_runtime: 30m
    idle_timeout: 5m
    agent: ${{ paseo.inputs.agent }}
    prompt:
      - text: ${{ paseo.prompt }}
```

如果 `codex-safe` 在 `hub.yml` 中包含结构化的沙箱选项，选择它时会原样带上这些选项。像 `provider: ${{ paseo.inputs.agent }}` 这样的动态内联对象会被拒绝。

## 由分类器路由 {#route-from-a-classifier}

前面的 step 可以返回有限取值的结构化输出。之后的权限必须由该输出 schema 中的 `enum` 或 `const` 加以限定。

```yaml
name: classify-request
on: discord.mention
max_runtime: 2h
filters:
  guild: "123456789012345678"
  from_users: ["345678901234567890"]
values:
  selected_environment: ${{ steps.classify.outputs.environment }}
  selected_agent: ${{ steps.classify.outputs.agent }}
steps:
  - id: classify
    environment: hub
    max_runtime: 5m
    idle_timeout: 1m
    agent: claude
    prompt:
      - include: partials/classify.md
      - text: ${{ paseo.prompt }}
    output:
      schema:
        type: object
        required: [environment, agent]
        properties:
          environment: { enum: [paseo, hub] }
          agent: { enum: [codex-safe, claude] }
        additionalProperties: false
  - id: work
    environment: ${{ values.selected_environment }}
    max_runtime: 1h
    idle_timeout: 10m
    agent: ${{ values.selected_agent }}
    prompt:
      - text: |
          Complete the request. Call hub.reply once, then call hub.finish_execution.
      - text: ${{ paseo.prompt }}
    allow_outputs:
      - { type: discord.reply, max: 1, required: true }
```

`.paseo/workflows/partials/classify.md`：

```text
Choose one configured repository environment and one complete named agent configuration.
```

这个 workflow 保留了一个分类器分支和一个执行者分支，不需要为每个环境/Provider 组合重复编写执行者 step。

## 提示词与上下文 {#prompt-and-context}

提示词块保持有序。include 的内容是文件的字面内容；Hub 不会递归扫描片段文本。

```yaml
prompt:
  - include: partials/instructions.md
  - text: |
      Provider evidence:
      ${{ paseo.context }}

      <user-prompt>
      ${{ paseo.prompt }}
      </user-prompt>
```

- `${{ paseo.prompt }}` 是规范化后的请求文本。它始终在编写的提示词中显式出现。
- `${{ paseo.context }}` 让该 step 选择加入 Provider 上下文的物化，并插入 JSON。没有这个表达式时，Hub 不会获取或注入环境上下文。

把不受信任的请求文本放在界限清晰的块中。片段是指令文本，而不是隐藏的权限。

## 条件与有序输出 {#conditions-and-ordered-output}

step 按文件顺序运行。`if` 可以读取输入、值和之前 step 的输出：

```yaml
name: conditional-review
on: manual.run
max_runtime: 1h
filters:
  from_users: [automation]
steps:
  - id: inspect
    environment: paseo
    max_runtime: 10m
    idle_timeout: 2m
    agent: codex-safe
    prompt:
      - text: ${{ paseo.prompt }}
    output:
      schema:
        type: object
        required: [needs_review]
        properties:
          needs_review: { type: boolean }
        additionalProperties: false
  - id: review
    if: ${{ steps.inspect.outputs.needs_review == true }}
    environment: paseo
    max_runtime: 30m
    idle_timeout: 5m
    agent: claude
    prompt:
      - text: Review the prior result and call hub.finish_execution.
```

step 不能读取之后的 step。step ID 在 workflow 内唯一。

## 告诉 Agent 调用哪个工具 {#tell-the-agent-which-tool-to-call}

`allow_outputs` 授予一项能力；它不会改写提示词。请写明需要执行的操作：

```yaml
prompt:
  - text: |
      Send the final answer with hub.reply.
      Then call hub.finish_execution.
allow_outputs:
  - type: slack.reply
    max: 1
    required: true
```

`max` 默认为 `1`。`required: true` 会阻止成功完成，直到该能力被使用过。请把 Slack 和 Discord 的回复类型分别放在各自 Provider 的 workflow 文件中。

## 时限 {#deadlines}

workflow 的 `max_runtime` 限制整次运行。每个 step 都有自己的 `max_runtime` 和 `idle_timeout`；workflow 的剩余时间同时为两者封顶。超时会让运行失败，并停止之后的 step。

[配置参考](/docs/hub/configuration/hub-yml)列出了所有字段。Provider 过滤器和调用文本见[触发器](/docs/hub/triggers)。
