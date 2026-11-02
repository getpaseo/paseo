---
title: 浏览器自动化
description: 在 Paseo 中给 Agent 一个真实的浏览器，用来打开页面、点击、输入并验证它们的工作。
nav: 概览
---

# 浏览器自动化 {#browser-automation}

Paseo 中的 Agent 可以操作真实的浏览器标签页，也就是你在 Paseo 桌面应用中看到的那些标签页。Agent 可以打开你的开发服务器、读取页面、点击走完一个流程、填写表单并截图，全程不离开你的机器。

这让前端工作形成了闭环：Agent 不再告诉你“这个改动应该能用”，而是打开页面亲自检查。

典型用途：

- **验证自己的改动。** 修改组件后，Agent 打开开发服务器，对页面做快照，确认新的文字或布局确实出现了。
- **复现和诊断 bug。** 按 bug 报告中的确切步骤点击，然后读取控制台和网络日志。
- **完整走查流程。** 表单、多步向导、悬停菜单、拖放、文件上传。
- **在已登录的会话中工作。** 标签页会保留会话状态。你自己登录一次，Agent 就可以在登录后的页面中工作。

因为你和 Agent 共享浏览器，你可以看着它工作，并随时介入。

## 启用 {#enabling}

浏览器工具默认关闭。按主机开启：

- **在应用中**：打开 **设置 → 你的主机 → Agents**，开启 **Browser tools**。
- **在 `config.json` 中**（`~/.paseo/config.json`）：

```json
{
  "daemon": {
    "browserTools": {
      "enabled": true
    }
  }
}
```

这些工具属于 [Paseo MCP 工具集](/docs/mcp)，因此同一页面上的 **启用 Paseo tools** 也必须开启，Agent 才能获得它们。已有的 Agent 可能需要重新加载才能获得新工具。

> 浏览器工具允许 Agent 访问和控制 Paseo 浏览器标签页，包括已登录的浏览器状态。只为你信任的 Agent 启用。

## 目前仅限桌面端 {#desktop-only-for-now}

浏览器标签页由 Paseo 桌面应用承载。daemon 本身不运行浏览器：它把工具调用路由到已连接的桌面应用，没有已连接的桌面应用时返回错误。通信协议与宿主无关，因此以后其他宿主也可以承载同样的工具。

## Agent 如何看到页面 {#how-an-agent-sees-a-page}

主要工具是 `browser_snapshot`，它以无障碍树的形式返回页面（标题、文本、表单状态和层级结构），而不是原始 HTML：

```yaml
- document "Settings"
  - heading "Workspace" [level=1]
  - text: "Connected as Maya"
  - textbox "Display name" [ref=@e2]
  - button "Save changes" [ref=@e3]
```

可交互元素带有类似 `@e3` 的引用。Agent 把引用传给 `browser_click`、`browser_fill` 和其他操作工具。引用来自该标签页的最新快照，页面变化后会失效；使用过期的引用会返回错误，而不是作用到错误的元素上。

对于无障碍树无法捕获的内容，Agent 会退回到 `browser_screenshot`，`browser_logs` 则提供控制台消息和网络耗时。

## 架构 {#architecture}

```
agent ──MCP──▶ daemon (broker) ──▶ browser host (desktop app) ──▶ webview
```

- **按工作区隔离的标签页。** Agent 只能看到和控制自己工作区中的标签页。新标签页在后台打开，不会抢走你的焦点。
- **标签页到宿主的路由。** daemon 记住每个标签页属于哪个宿主，并把标签页命令路由过去。`browser_list_tabs` 汇总所有已连接的宿主。
- **可信输入。** 点击、按键、悬停和拖动都以真实的浏览器输入事件派发：CSS `:hover` 会触发，页面无法区分 Agent 的点击和用户的点击。每个操作都会先等待目标可见、可用且稳定。
- **对话框永不阻塞。** `alert` 会被接受；`confirm`、`prompt` 和 `beforeunload` 会被取消。每个被处理的对话框都会在工具结果中报告，让 Agent 知道页面流程发生了变化。

## 安全 {#security}

- 导航仅限 `http(s)` URL。
- 文件上传只能引用 Agent 工作区内的文件。
- 标签页共享你在 Paseo 中使用的浏览器配置，包括 cookie 和登录状态。这正是登录后测试能够工作的原因，也是该功能需要按主机手动开启的原因。

完整的工具列表见[工具参考](/docs/browser-tools)。
