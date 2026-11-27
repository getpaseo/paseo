---
title: 浏览器工具
description: Agent 用来操作 Paseo 浏览器标签页的 browser_* MCP 工具。
nav: 工具参考
---

# 浏览器工具 {#browser-tools}

启用[浏览器自动化](/docs/browser)后，`browser_*` 工具会和其他 [Paseo MCP 工具](/docs/mcp)一起注入到 Agent 中。

通用概念：

- **`browserId`** 标识一个标签页。它来自 `browser_new_tab` 或 `browser_list_tabs`，所有针对标签页的工具都需要它。
- **`ref`** 标识一个元素，例如 `@e3`。引用来自同一标签页最新的 `browser_snapshot`，页面变化后会失效；过期的引用会返回错误，而不是作用到错误的元素上。
- 每个结果都会报告命令执行期间页面打开的**对话框**（alert 会被接受；confirm/prompt/beforeunload 会被取消）。

标记为 `?` 的参数是可选的。

## 标签页 {#tabs}

| 工具                 | 参数                       | 用途                                                           |
| -------------------- | -------------------------- | -------------------------------------------------------------- |
| `browser_list_hosts` | —                          | 按名称和 ID 列出已连接的浏览器宿主，包括尚未打开标签页的宿主。 |
| `browser_list_tabs`  | —                          | 列出工作区中的标签页及其浏览器宿主。                           |
| `browser_new_tab`    | `url?, browserHostId?`     | 在后台打开标签页，并返回它的 `browserId` 和浏览器宿主。        |
| `browser_close_tab`  | `browserId`                | 关闭标签页并清理它的 webview。                                 |
| `browser_resize`     | `browserId, width, height` | 调整标签页视口大小，用手机或平板的尺寸检查布局。               |

如果只有一个宿主支持打开标签页，可以省略 `browserHostId`。如果有多个，请传入 `browser_list_hosts` 返回的 ID。在 Paseo Desktop 的命令中心搜索 **复制浏览器宿主名称**。结果会显示 Agent 看到的名称，选择该结果即可复制名称。如果选定的宿主不可用，请重新列出宿主。

## 读取页面 {#reading-the-page}

| 工具                 | 参数                                   | 用途                                                                |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `browser_snapshot`   | `browserId`                            | 以带元素引用的无障碍树形式返回页面。                                |
| `browser_screenshot` | `browserId, fullPage?`                 | 截取视口的 PNG；传入 `fullPage` 时截取整个页面。                    |
| `browser_logs`       | `browserId, maxEntries?`               | 读取最近的控制台消息和网络条目：URL、耗时、大小和 HTTP 状态码。     |
| `browser_wait`       | `browserId, text? \| url?, timeoutMs?` | 等待页面包含某段文本或到达某个 URL 片段（两者必须且只能提供一个）。 |

## 交互 {#interacting}

| 工具               | 参数                                                | 用途                                                                 |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------- |
| `browser_click`    | `browserId, ref, button?, doubleClick?, modifiers?` | 点击元素：左键/右键/中键、双击、键盘修饰键。                         |
| `browser_fill`     | `browserId, ref, value`                             | 设置输入类元素的值。                                                 |
| `browser_type`     | `browserId, text, ref?`                             | 向元素输入文本；省略 `ref` 时输入到当前获得焦点的元素。              |
| `browser_keypress` | `browserId, key, ref?`                              | 在元素或当前焦点元素上按键（`Enter`、`Escape`、`Tab`、`Space` 等）。 |
| `browser_hover`    | `browserId, ref`                                    | 悬停在元素上，会触发真实的 CSS `:hover`。                            |
| `browser_select`   | `browserId, ref, value`                             | 在 `<select>` 中选择一个选项。                                       |
| `browser_drag`     | `browserId, sourceRef, targetRef`                   | 把一个元素拖到另一个元素上。                                         |
| `browser_upload`   | `browserId, ref, filePaths`                         | 为文件输入框设置文件。路径必须位于 Agent 的工作区内。                |
| `browser_scroll`   | `browserId, deltaX, deltaY, ref?`                   | 滚动页面；传入 `ref` 时把滚轮输入定位到该元素中心。                  |

## 导航 {#navigation}

| 工具               | 参数             | 用途                               |
| ------------------ | ---------------- | ---------------------------------- |
| `browser_navigate` | `browserId, url` | 跳转到一个 `http(s)` URL。         |
| `browser_back`     | `browserId`      | 后退；没有可后退的历史记录时报错。 |
| `browser_forward`  | `browserId`      | 前进；没有可前进的条目时报错。     |
| `browser_reload`   | `browserId`      | 重新加载页面。                     |

## 脚本 {#scripting}

| 工具               | 参数                        | 用途                                                                                                            |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `browser_evaluate` | `browserId, function, ref?` | 在页面中运行一个 JavaScript 函数。传入 `ref` 时，解析出的元素作为第一个参数传入。结果以有大小限制的 JSON 返回。 |

## 错误 {#errors}

工具会返回结构化的错误，而不是静默失败。Agent 最常遇到的错误：

| 错误码                   | 含义                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `browser_disabled`       | 该主机上的浏览器工具已关闭。                                                   |
| `browser_no_host`        | 没有已连接的浏览器宿主，或选定的宿主已断开连接。                               |
| `browser_host_ambiguous` | 多个宿主支持打开标签页。请从错误返回的列表中选择一个宿主，并使用它的 ID 重试。 |
| `browser_stale_ref`      | 引用与页面不再匹配，请重新获取快照。                                           |
| `browser_timeout`        | 元素始终无法操作，或等待条件始终未满足。                                       |
| `browser_denied`         | 不允许该操作，例如非 `http(s)` 的 URL，或没有可导航的历史记录。                |
