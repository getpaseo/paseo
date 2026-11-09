---
title: 何时使用 Paseo 浏览器
description: 什么时候该用 Paseo 内置浏览器，而不是 Playwright 或 agent-browser。
nav: 何时使用
---

# 何时使用 {#when-to-use}

Paseo 为 Agent 提供了一个[运行在 Paseo 内部的真实浏览器](/docs/browser)。Playwright 或 agent-browser 这类独立工具会在单独的进程中给 Agent 一个自己的浏览器。两者有重叠，该选哪个？

以下情况使用 Paseo 浏览器：

- **你在远程运行 Agent，并且想看着它工作。** 你在 Paseo 桌面端实时看到的就是 Agent 正在操作的那个浏览器，而不是某台你看不到的机器上的无头浏览器。
- **你希望浏览器就在 Paseo 里。** 它是同一个会话中的一个标签页，不是另一个需要管理的 Agent 窗口。
- **你不想额外配置工具。** 它是内置的，无需另外安装和接入 MCP 服务器或 CLI。

如果浏览器工作是独立的，比如在 CI 中无头运行、已有的测试套件，或与 Paseo 中的 Agent 会话无关的自动化，就使用 Playwright 或 agent-browser。

Paseo 浏览器[目前仅支持桌面端](/docs/browser)。
