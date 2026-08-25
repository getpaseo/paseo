# HarmonyOS MVP 实施计划 — 第一阶段

## 概述

Paseo 移动端应用的 ArkUI (ArkTS) 原生重写，面向 HarmonyOS。核心 SDK 包
（`@getpaseo/client`、`@getpaseo/protocol`、`@getpaseo/highlight`）作为 npm
依赖复用。UI 层使用 ArkUI 声明式框架从头构建，平台能力由原生 `@ohos.*` API 提供。

**第一阶段范围：** 连接守护进程 → 查看 Agent 流 → 发送提示词 → 终端。
一个可工作的移动客户端，能够监控并与单个 Agent 会话交互。

**预估总量：** 约 8,000 行 ArkTS，3–4 周（1 名开发者）。

---

## 仓库结构

```
packages/harmony/                  # 新增顶级包
├── oh-package.json5               # HarmonyOS 包清单（引用 npm 依赖）
├── build-profile.json5
├── hvigorfile.ts
├── entry/                         # 主模块
│   └── src/main/
│       ├── ets/
│       │   ├── entryability/
│       │   │   └── EntryAbility.ets
│       │   ├── transport/         # WebSocket → DaemonTransport 适配器
│       │   │   └── harmony-transport.ets          (~100 行)
│       │   ├── client/            # @getpaseo/client 的薄封装层
│       │   │   ├── paseo-client-context.ets        (~150 行)
│       │   │   └── client-lifecycle.ets            (~120 行)
│       │   ├── models/            # ArkTS 风格的状态模型
│       │   │   ├── agent-model.ets                 (~200 行)
│       │   │   ├── stream-model.ets                (~400 行)
│       │   │   ├── timeline-store.ets              (~350 行)
│       │   │   └── connection-model.ets            (~150 行)
│       │   ├── pages/             # 路由级页面
│       │   │   ├── connect-page.ets                (~250 行)
│       │   │   ├── agent-page.ets                  (~120 行)
│       │   │   └── terminal-page.ets               (~80 行)
│       │   ├── components/        # UI 组件
│       │   │   ├── message-list.ets                (~500 行)
│       │   │   ├── message-item.ets                (~350 行)
│       │   │   ├── markdown-block.ets              (~500 行)
│       │   │   ├── code-block.ets                  (~200 行)
│       │   │   ├── tool-call-card.ets              (~300 行)
│       │   │   ├── agent-header.ets                (~200 行)
│       │   │   ├── composer-bar.ets                (~400 行)
│       │   │   ├── terminal-canvas.ets             (~800 行)
│       │   │   ├── terminal-toolbar.ets            (~120 行)
│       │   │   └── connection-indicator.ets        (~100 行)
│       │   ├── terminal/          # 终端仿真
│       │   │   ├── terminal-buffer.ets             (~450 行)
│       │   │   ├── terminal-parser.ets             (~350 行)
│       │   │   ├── terminal-renderer.ets           (~400 行)
│       │   │   └── terminal-colors.ets             (~80 行)
│       │   └── common/            # 共享工具
│       │       ├── theme.ets                       (~150 行)
│       │       ├── icons.ets                       (~80 行)
│       │       └── constants.ets                   (~60 行)
│       └── resources/
│           ├── base/element/
│           ├── dark/element/
│           └── rawfile/
├── harness/                       # 测试工具
│   └── test/
│       └── ets/
│           └── transport/
│               └── harmony-transport.test.ets
└── README.md
```

---

## 任务分解

### T1 — 项目脚手架与构建链（第 1 天）

初始化一个标准的 HarmonyOS 应用项目。配置 npm 解析，使
`@getpaseo/protocol` 和 `@getpaseo/client`（均为纯 ESM）可在 ArkTS 中使用。
ArkTS 是 TypeScript 的超集，可以直接导入 `.js` 和 `.d.ts` 文件，但
在 `oh-package.json5` 下的 npm 包解析需要显式映射。

**交付物：**
- `npm run dev:harmony` 启动 DevEco Studio 或 `hdc` 可部署产物
- `import { DaemonClient } from '@getpaseo/client'` 可在 ArkTS 中编译
- `import { SessionInboundMessageSchema } from '@getpaseo/protocol/messages'` 可正常工作

**关键决策：**
- 验证 `zod`（`@getpaseo/client` 和 `@getpaseo/protocol` 的依赖）是否能在
  ArkTS 运行时中正常工作。Zod v4 仅面向 ESM/TC39——不依赖 DOM 或 Node——因此
  应该没问题，但这是首要验证的事项。
- 如果 `zod` 不工作，则回退方案是将协议类型打包为预生成的 TS
  接口，并进行手动验证（协议包已经生成 `.d.ts` 文件）。

---

### T2 — WebSocket 传输适配器（第 1–2 天）

```typescript
// transport/harmony-transport.ets
// 将 @ohos.net.webSocket 适配为 DaemonTransport 接口

import webSocket from '@ohos.net.webSocket';
import type { DaemonTransport } from '@getpaseo/client/internal/daemon-client-transport-types';

export function createHarmonyTransport(url: string): DaemonTransport {
  const ws = webSocket.createWebSocket();

  return {
    send(data: string | Uint8Array | ArrayBuffer): void {
      // 二进制帧（终端）→ ArrayBuffer
      // JSON 帧（会话消息）→ string
      ws.send(data);
    },
    close(code?: number, reason?: string): void {
      ws.close({ code: code ?? 1000, reason: reason ?? '' });
    },
    onMessage(handler: (data: unknown) => void): () => void {
      ws.on('message', (_err: Error | null, value: string | ArrayBuffer) => {
        handler(value);
      });
      return () => ws.off('message');
    },
    onOpen(handler: () => void): () => void {
      ws.on('open', handler);
      return () => ws.off('open');
    },
    onClose(handler: (event?: unknown) => void): () => void {
      ws.on('close', (_err: Error | null, value: unknown) => handler(value));
      return () => ws.off('close');
    },
    onError(handler: (event?: unknown) => void): () => void {
      ws.on('error', (err: Error) => handler(err));
      return () => ws.off('error');
    },
  };
}
```

**关键决策：** Paseo 以**二进制 WebSocket 帧**（操作码 +
槽位 + 载荷）发送终端输出。RN Web 客户端使用 `ws.binaryType = 'arraybuffer'` 并接收
`MessageEvent.data` 为 ArrayBuffer。HarmonyOS 的 `@ohos.net.webSocket` 发出 `message`
回调，参数为 `string | ArrayBuffer`——确认 ArrayBuffer 二进制帧支持，并在
消息处理器中正确区分 JSON 与二进制消息的路由。

**交付物：**
- 单元测试：连接到本地守护进程（`npm run dev`）并解析 `server_info`
  状态消息
- 单元测试：接收二进制终端输出帧并提取操作码 + 载荷

---

### T3 — Paseo 客户端上下文与生命周期（第 2–3 天）

用 ArkUI 友好的状态管理封装 `DaemonClient`。每个页面需要访问：
- 连接状态（idle / connecting / connected / disconnected）
- 服务器信息（serverId、hostname、version、features）
- 用于 RPC 调用的 `DaemonClient` 实例

使用 ArkUI 的 `@Observed` / `@ObjectLink` 模式实现响应式，或者如果
装饰器模型不适合异步 WebSocket 生命周期，则使用简单的事件发射器模式。

```typescript
// client/paseo-client-context.ets
import { DaemonClient } from '@getpaseo/client';
import type { ServerInfoStatusPayload } from '@getpaseo/protocol/messages';

@Observed
export class ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
  serverId: string = '';
  hostname: string = '';
  version: string = '';
}

export class PaseoClientContext {
  client: DaemonClient | null = null;
  state: ConnectionState = new ConnectionState();

  async connect(host: string, port: number): Promise<void> { ... }
  disconnect(): void { ... }
  // 常用操作的 RPC 封装
  async createAgent(config: CreateAgentConfig): Promise<string> { ... }
  async sendMessage(agentId: string, text: string): Promise<void> { ... }
}
```

**交付物：**
- 连接到用户指定的守护进程地址
- 显示连接状态指示器
- 将最近使用的主机地址存储到 `@ohos.data.preferences`

---

### T4 — 连接页面（第 3 天）

```
┌──────────────────────────────┐
│         Paseo                │
│                              │
│   ┌──────────────────────┐   │
│   │  主机 (IP:端口)      │   │
│   │  192.168.1.5:6767    │   │
│   └──────────────────────┘   │
│                              │
│   ┌──────────────────────┐   │
│   │  密码（可选）        │   │
│   └──────────────────────┘   │
│                              │
│   ┌──────────────────────┐   │
│   │     连接             │   │
│   └──────────────────────┘   │
│                              │
│   最近连接：                 │
│   • 192.168.1.5:6767        │
│   • home-server.local:6767  │
└──────────────────────────────┘
```

简单的 `Column` 布局，包含用于主机/端口/密码的 `TextInput`，以及用于连接的 `Button`。
连接成功后 → 导航到 Agent 页面。

---

### T5 — 时间线存储与流模型（第 3–5 天）

这是逻辑最重的部分。将
`timeline/session-stream-reducers.ts`（1,240 行）和 `agent-stream/model.ts` 的核心概念移植到
响应式 ArkUI 模型中。

需要提取的关键函数：

| 源文件 | 函数 | 功能 |
|------------|----------|-------------|
| `session-stream-reducers.ts` | `processTimelineResponse()` | 将传入的时间线分页合并到 tail/head 数组中，包括去重、间隙检测、游标跟踪 |
| `session-stream-reducers.ts` | `classifySessionTimelineSeq()` | 序列号去重逻辑 |
| `agent-stream/model.ts` | `buildAgentStreamRenderModel()` | 将条目拆分为 virtualized-history / mounted-history / live-head 段 |
| `types/stream.ts` | `reduceStreamUpdate()` | 将单个 `AgentStreamEventPayload` 规范化为 `StreamItem` |

**策略：** 这些函数是纯 TypeScript，不依赖 React——
它们操作 `StreamItem[]` 数组。将它们提取到一个共享的 `models/timeline-core.ts` 中，
直接翻译算法，然后将输出封装在 ArkUI 响应式状态中。

```typescript
// models/timeline-store.ets
import type { StreamItem } from '../../../app/src/types/stream'; // 引用类型
import { processTimelineResponse } from './timeline-core';
import type { TimelineCursor, ProcessTimelineResponseOutput } from './timeline-core';

@Observed
export class TimelineStore {
  tail: StreamItem[] = [];
  head: StreamItem[] = [];
  cursor: TimelineCursor | undefined;
  isLoading: boolean = false;

  applyPage(response: TimelineResponse): void {
    const result = processTimelineResponse({
      payload: response,
      currentTail: this.tail,
      currentHead: this.head,
      currentCursor: this.cursor,
      ...
    });
    this.tail = result.tail;
    this.head = result.head;
    this.cursor = result.cursor ?? undefined;
  }

  appendStreamEvent(event: AgentStreamEventPayload): void {
    // 实时流事件直接追加到 head
    this.head = [...this.head, reduceStreamUpdate(this.head, event)];
  }
}
```

**交付物：**
- 移植 `processTimelineResponse` 及其依赖项（约 400 行纯逻辑）
- 使用现有 RN 测试中的已知时间线载荷进行单元测试
- 响应式存储，收到新数据时触发 UI 更新

---

### T6 — 消息列表组件（第 5–7 天）

渲染 `StreamItem[]` 的主滚动视图。使用 ArkUI `List` + `LazyForEach` 实现
虚拟化（内置，无需第三方库）。

```
┌──────────────────────────────┐
│ ← Agent: paseo-setup-tj37   │  ← agent-header
├──────────────────────────────┤
│ 你: 修复登录 bug            │  ← message-item (user_message)
│                              │
│ Claude: 我来调查一下...     │  ← message-item (assistant_message)
│                              │
│ ┌─ 工具: Read ────────────┐  │
│ │ src/auth/login.ts       │  │  ← tool-call-card
│ │ ...                     │  │
│ └──────────────────────────┘  │
│                              │
│ Claude: 找到问题了...       │  ← message-item
│                              │
│ ┌──────────────────────────┐  │
│ │  发送消息...             │  │  ← composer-bar
│ └──────────────────────────┘  │
└──────────────────────────────┘
```

**组件：**

| 组件 | 行数 | 描述 |
|-----------|-------|-------------|
| `message-list.ets` | ~500 | `List` + `LazyForEach`，滚动到底部，加载指示器 |
| `message-item.ets` | ~350 | 根据 `item.kind` 分发到 markdown-block 或 tool-call-card |
| `markdown-block.ets` | ~500 | 将解析后的 markdown AST 渲染为 `RichText`/`Span`/`ImageSpan`（覆盖：标题、段落、行内代码、粗体/斜体、链接、图片） |
| `code-block.ets` | ~200 | 带语法高亮（使用 `@getpaseo/highlight`）和复制按钮的代码块 |
| `tool-call-card.ets` | ~300 | 可展开的卡片，显示工具名称 + 截断结果 |
| `agent-header.ets` | ~200 | Agent 标题、状态徽章、kebab 菜单 |

**Markdown 渲染方案：**

1. `markdown-it` 将文本解析为 token 数组（从 npm 复用，纯 JS）
2. 在 ArkTS 中递归遍历 token
3. 将每种 token 类型映射到 ArkUI 组件：
   - `heading` → 带 fontSize/weight 的 `Text`
   - `paragraph` → `Text`
   - `code_inline` → 等宽字体 + 背景色的 `Text`
   - `fence` → `code-block` 组件
   - `list_item` → `Row` + `Text`
   - `link` → 蓝色文字 + `onClick` → 打开浏览器
4. Diff 块（Paseo 在代码块中使用自定义 diff 语法）→ 扩展 code-block

**交付物：**

- 带懒加载的可滚动消息列表
- 正确渲染：用户消息、助手 markdown、带语法高亮的代码块、
  工具调用卡片以及轮次边界
- 新内容自动滚动到底部（移植自
  `agent-stream/bottom-anchor-controller.ts` 的底部锚定逻辑）
- 滚动到顶部时自动加载更早的页面（分页）

---

### T7 — 终端仿真与 Canvas 渲染器（第 7–10 天）

Paseo 的终端是最复杂的组件。RN 版本使用以下方案之一：
- **Web（桌面/浏览器）：** `<webview>` 中的 xterm.js 插件
- **原生（iOS/Android）：** `components/terminal-emulator.native.tsx` 中的自定义
  基于 `Text` 的行渲染器

对于 HarmonyOS，构建一个**基于 Canvas 的终端渲染器**。

**架构：**

```
binary WS frame
      │
      ▼
┌─────────────────┐
│ terminal-parser  │  ← 解码操作码 + 载荷（output / snapshot / resize）
│   (~350 行)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ terminal-buffer  │  ← 字符网格 + 属性（前景色/背景色/粗体/反色）
│   (~450 行)      │     光标位置、回滚、滚动区域
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ terminal-renderer    │  ← Canvas 绘制循环
│   (~400 行)          │     从缓冲区绘制字符网格
│                      │     使用脏矩形优化性能
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ terminal-canvas.ets  │  ← ArkUI Canvas 组件
│   (~800 行)          │     键盘输入 → WebSocket 发送
│                      │     手势（双指缩放字体、滑动切换标签页）
│                      │     调整大小 → 二进制 resize 帧
└─────────────────────┘
```

**终端缓冲区数据结构：**

```typescript
interface TerminalChar {
  char: string;       // UTF-8 码点
  fg: number;         // 前景色索引
  bg: number;         // 背景色索引
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

interface TerminalBuffer {
  rows: number;
  cols: number;
  lines: TerminalChar[][];    // 环形缓冲区，[0] = 最顶部可回滚行
  cursorRow: number;
  cursorCol: number;
  scrollTop: number;          // 滚动区域
  scrollBottom: number;
  cursorVisible: boolean;
  // 光标保存/恢复、备用屏幕等——仅实现 Paseo 实际使用的部分
}
```

**终端解析器（xterm 转义序列的子集）：**

Paseo 终端从 Agent PTY 输出接收数据。只需要一个子集：

| 序列 | 含义 | 优先级 |
|----------|------|----------|
| `\n`、`\r`、`\r\n` | 换行 / 回车 | P0 |
| `\b` | 退格 | P0 |
| `\t` | 制表符 | P0 |
| `\x1b[K`、`\x1b[0K`... | 擦除行 | P0 |
| `\x1b[J`、`\x1b[0J`... | 擦除显示 | P0 |
| `\x1b[?25h` / `\x1b[?25l` | 光标显示/隐藏 | P0 |
| `\x1b[nA`、`\x1b[nB`... | 光标移动 | P1 |
| `\x1b[n;mH` | 光标定位 | P1 |
| `\x1b[m`、`\x1b[0m`... | SGR（颜色/属性） | P1 |
| `\x1b[?1049h` / `\x1b[?1049l` | 备用屏幕 | P1 |
| `\x1b[?47h` / `\x1b[?47l` | 备用屏幕（旧版） | P2 |
| `\x1b[6n` | 光标位置报告 | P2 |
| `\x1b]0;...\x07` | 设置窗口标题 | P2 |

**Canvas 渲染：**

```typescript
// terminal-renderer.ets
class TerminalRenderer {
  private ctx: CanvasRenderingContext2D;
  private font: string;
  private charWidth: number;
  private charHeight: number;
  private dirtyRows: Set<number> = new Set();

  // 主题颜色（Paseo 深色 / 浅色主题）
  private colors: TerminalColors;

  drawRow(row: number): void {
    const y = row * this.charHeight;
    for (let col = 0; col < this.cols; col++) {
      const ch = buffer.line[row][col];
      this.ctx.fillStyle = this.colors.bg[ch.bg];
      this.ctx.fillRect(col * this.charWidth, y, this.charWidth, this.charHeight);
      this.ctx.fillStyle = this.colors.fg[ch.fg];
      this.ctx.font = ch.bold ? `bold ${this.font}` : this.font;
      this.ctx.fillText(ch.char, col * this.charWidth, y + this.charHeight * 0.8);
    }
  }

  renderFrame(): void {
    if (this.dirtyRows.size === 0) return;
    for (const row of this.dirtyRows) {
      this.drawRow(row);
    }
    this.dirtyRows.clear();
  }
}
```

**交付物：**

- 终端 Canvas，能够渲染 ANSI 转义文本输出
- 回滚缓冲区（约 1000 行）
- 键盘输入转发到守护进程
- 尺寸变化检测 → 二进制 resize 帧
- 与 Paseo 深色/浅色主题保持主题一致性
- 重连时恢复快照（`terminal_snapshot` 消息）

---

### T8 — 输入栏（第 10–11 天）

用于发送提示词的底部输入区域。

```
┌──────────────────────────────────┐
│ ┌──────────────────────────────┐ │
│ │ 发送消息...                  │ │  ← TextArea，最多扩展至 5 行
│ └──────────────────────────────┘ │
│ [模型 ▾] [模式 ▾]        [发送] │  ← agent-controls 行
└──────────────────────────────────┘
```

使用 ArkUI `TextArea`，设置 `maxLines(5)`。使用 `KeyboardAvoidMode.RESIZE` 处理键盘
（内置于 ArkUI，无需第三方库）。

**功能：**
- 多行输入，自动扩展（最多 5 行）
- 发送按钮 + 回车键提交（Shift+Enter 换行）
- 提供商/模型/模式选择器（上滑弹出选择面板）

参考 RN 文件：`composer/input/input.tsx`、`composer/draft/input-draft.ts`、
`composer/agent-controls/`。

---

### T9 — Agent 页面组装（第 11–12 天）

将所有组件整合到主 Agent 交互页面中。

**布局：**
```
┌──────────────────────────────┐
│ NavigationBar                │  ← 返回、Agent 标题、连接指示器
├──────────────────────────────┤
│                              │
│       message-list           │  ← 可滚动时间线
│                              │
├──────────────────────────────┤
│       composer-bar           │  ← 固定在底部
└──────────────────────────────┘
```

**路由：** `agent-page.ets` 通过路由参数接收 `agentId`，从守护进程加载 Agent 状态，
订阅 `agent_stream` 和 `agent_update` 会话消息。

**导航结构（第一阶段）：**
```
ConnectPage → AgentPage
                 ├── TerminalPage（通过 router 推入）
                 └── （未来：SettingsPage、FileExplorer 等）
```

ArkUI 路由 API：`router.pushUrl({ url: 'pages/terminal-page', params: { ... } })`

---

### T10 — 缓冲、打磨与边界情况（第 12–14 天）

- 连接断开 → 带退避的重连，显示横幅提示
- 空状态 → "没有运行中的 Agent" 占位符
- 加载状态 → 骨架屏/加载动画
- 错误状态 → 内联错误消息
- 主题 → 深色模式支持（ArkUI `dark/` 资源目录）
- 性能 → 验证 `LazyForEach` 在 1000+ 时间线条目下的表现
- 键盘 → `KeyboardAvoidMode.RESIZE` 与输入栏的正确配合
- 终端 → 在真机上验证二进制帧处理

---

## 依赖矩阵

### 作为 npm 复用（无需修改）

| 包 | 行数 | 集成方式 |
|---------|-------|-------------|
| `@getpaseo/client` | 12,765 | 导入 `DaemonClient`、`DaemonTransport` 接口 |
| `@getpaseo/protocol` | 15,363 | 导入 Zod schema、消息类型、生命周期类型 |
| `@getpaseo/highlight` | 978 | 导入 `Highlighter` 用于代码块 |
| `markdown-it` | (npm) | 导入用于 markdown → token 解析 |
| `zod` | (npm) | 运行时验证（验证 ArkTS 兼容性） |
| `mnemonic-id` | (npm) | 生成可读的 Agent ID |

### 由 @ohos.* API 替代（无第三方依赖）

| RN 依赖 | HarmonyOS 替代方案 |
|---------------|----------------------|
| React Native View/Text | ArkUI `Column`/`Row`/`Text`/`List` |
| Expo Router | `@ohos.router` |
| `@tanstack/react-virtual` | `LazyForEach`（内置） |
| `react-native-reanimated` | `animateTo()` / 属性动画（内置） |
| `react-native-gesture-handler` | `gesture()` API（内置） |
| `@gorhom/bottom-sheet` | `bindSheet`（内置） |
| `react-native-safe-area-context` | `expandSafeArea` / `safeAreaInsets`（内置） |
| `react-native-keyboard-controller` | `KeyboardAvoidMode`（内置） |
| AsyncStorage | `@ohos.data.preferences` |
| `expo-clipboard` | `@ohos.pasteboard` |
| `expo-linking` | `@ohos.router` / `openLink` |
| react-native-svg | 不需要（使用 Image 展示图标） |

### 从头实现

| 模块 | 行数 | 优先级 |
|--------|-------|----------|
| Harmony WebSocket 传输 | ~100 | P0 |
| 时间线存储（响应式封装） | ~350 | P0 |
| 时间线核心逻辑（移植） | ~400 | P0 |
| 流模型（移植） | ~200 | P0 |
| 终端解析器 | ~350 | P0 |
| 终端缓冲区 | ~450 | P0 |
| 终端 Canvas 渲染器 | ~400 | P0 |
| 终端 UI 组件 | ~800 | P0 |
| 消息列表 | ~500 | P0 |
| 消息条目 | ~350 | P0 |
| Markdown 渲染器 | ~500 | P0 |
| 代码块 | ~200 | P0 |
| 工具调用卡片 | ~300 | P0 |
| 输入栏 | ~400 | P0 |
| Agent 标题栏 | ~200 | P0 |
| 连接页面 | ~250 | P0 |
| Agent 页面 | ~120 | P0 |
| 终端页面 | ~80 | P0 |
| 连接指示器 | ~100 | P1 |
| 主题系统 | ~150 | P1 |
| 图标 | ~80 | P1 |
| 客户端上下文 | ~150 | P1 |
| 客户端生命周期 | ~120 | P1 |
| Agent 模型 | ~200 | P2 |
| 连接模型 | ~150 | P2 |
| 常量 | ~60 | P2 |
| **总计** | **~7,800** | |

---

## 第一阶段不移植的文件

以下 Paseo 功能推迟到第二阶段及以后：

| 功能 | 跳过的文件 | 原因 |
|---------|-------------|--------|
| Git diff / PR 面板 | `git/`（约 8,500 行） | 需要 FileExplorer、diff 渲染——第二阶段 |
| 文件浏览器 | `file-explorer/` | 第二阶段 |
| 工作区管理 | `workspace/`、`projects/` | 第二阶段（第一阶段：单个 Agent 视图） |
| 语音 Agent | `voice/`（约 2,200 行） | 需要 `expo-two-way-audio` → `@ohos.multimedia.audio` 重写 |
| 通知 | `expo-notifications` | 需要 Push Kit 集成 |
| 相机 / 二维码配对 | `screens/` 配对流程 | 需要 ScanKit |
| 设置页面 | `screens/settings/`（约 4,000 行） | 第二阶段 |
| 深色/浅色切换 | `use-color-scheme` | 第二阶段（默认深色） |
| 拖拽排序 | `react-native-draggable-flatlist` | 第二阶段 |
| 硬件键盘 | `paseo-hardware-keyboard` | 仅平板功能 |
| 浏览器面板 | `browser-pane.electron.tsx` | 仅桌面端功能 |
| i18n（多语言） | `i18n/`（15,834 行） | 第二阶段（MVP 仅英文） |

---

## 风险登记册

| 风险 | 影响 | 缓解措施 |
|------|--------|-----------|
| `zod` 与 ArkTS 运行时不兼容 | 阻塞协议验证 | 预生成 TS 接口；必要时手动验证 |
| `@ohos.net.webSocket` 二进制帧处理有差异 | 阻塞终端功能 | 第 1 天测试二进制帧；必要时回退到 JSON 内嵌 base64 |
| Canvas 文本渲染在真机上的性能 | 终端卡顿 | 如可用则使用 `OffscreenCanvas`；批量绘制；在真机上测量 |
| `markdown-it` 包体积或运行时问题 | Markdown 渲染缓慢 | 在 Worker 上预解析或简化为基于正则的解析器 |
| ArkUI `List` + `LazyForEach` 在混合内容下的性能 | 滚动卡顿 | 在真机上用 500+ 条目验证；必要时考虑扁平列表 |
| ArkTS 项目中的 npm 包解析 | 无法导入客户端包 | 使用 `ohpm` 注册表映射或本地 tarball；第 1 天验证 |

---

## 每日进度表

| 天 | 任务 | 状态 |
|-----|-------|--------|
| 1 | T1（脚手架）+ T2（传输） | ✅ 已完成 |
| 2 | T2（传输测试）+ T3（客户端上下文） | ✅ 已完成 |
| 3 | T4（连接页面）+ T5（流类型 + 时间线核心） | ✅ 已完成 |
| 4 | T5（时间线存储） | ✅ 已完成 |
| 5 | T6（消息条目 + markdown + 代码 + 工具卡片） | ✅ 已完成 |
| 6 | T6（消息列表 + Agent 标题栏）+ T8（输入栏集成） | ✅ 已完成 |
| 7 | T7（终端缓冲区 + 解析器 + 渲染器） | ✅ 已完成 |
| 8 | T7（终端 Canvas + 工具栏 + 页面集成） | ✅ 已完成 |
| 9 | T9（Agent 页面用真实组件组装） | ✅ 已完成 |
| 10–14 | 与守护进程 RPC 集成、真机测试、打磨 | 📋 待完成 |

**实际：** 4,134 行 ArkTS + 151 行配置，32 个源文件。所有第一阶段组件已实现。
