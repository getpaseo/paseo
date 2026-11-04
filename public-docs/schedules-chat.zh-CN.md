---
title: 在聊天中创建定时任务
description: 在聊天中让 Agent 为你创建和管理定时任务。
nav: 聊天
---

# 在聊天中创建定时任务 {#schedules-from-chat}

你不必填写表单。在任意 Agent 聊天中直接提出要求，Agent 就会通过 [Paseo MCP](/docs/mcp) 为你创建定时任务。

示例提示词：

- “每个工作日早上 9 点，分拣新的 GitHub issue 和 PR，并总结需要关注的内容。”
- “每 5 分钟检查一次发布构建，直到通过为止；如果失败，就修复原因。”
- “继续做这次重构：每 20 分钟唤醒自己一次，从上次停下的地方接着做。”

Agent 会根据你的要求选择 cron 频率、Agent 设置和提示词，创建定时任务并向你汇报。你也可以用同样的方式管理新建 Agent 类的定时任务，比如“暂停分拣任务”“把构建检查改成每 2 分钟运行一次”“现在运行一次”或“删除它”；也可以在[定时任务视图](/docs/schedules)和 [CLI](/docs/schedules-cli) 中管理。

Agent 为自己安排稍后唤醒，称为 **heartbeat**。通过 MCP，Agent 可以创建或删除自己的 heartbeat；要修改 heartbeat，需要先删除再创建一个替代的。这个很小的接口可以防止 heartbeat 悄悄变成另一项工作或另一个 Agent。底层工具见 [Paseo MCP](/docs/mcp)。
