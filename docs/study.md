# Paseo 项目学习笔记

## Paseo 是什么？

Paseo 是一个**移动端应用**，让你可以随时随地通过手机监控和控制运行在你本地开发机上的 AI 编码智能体（如 Claude Code、Codex、GitHub Copilot、OpenCode、Pi）。它不是一个云端 AI 服务——它直接连接到你的实际开发环境，你的代码始终留在你自己的机器上。

## 技术栈

| 层面 | 技术 |
|------|------|
| 运行时 | **Node.js 22.20.0** |
| 包管理 | **npm workspaces**（单体仓库） |
| 语言 | **TypeScript 5.9** |
| 移动端/Web | **Expo**（React Native） |
| 桌面端 | **Electron** |
| 格式化 | **oxfmt** |
| Lint | **oxlint** |
| 测试 | **vitest** |
| 类型检查 | **tsgo**（TypeScript 原生编译器的快速替代） |

## 仓库结构

```
packages/
├── highlight/           # 语法高亮库（最底层）
├── relay/               # E2E 加密中继
├── protocol/            # 有线协议 schema（Zod）
├── client/              # 守护进程客户端库
├── server/              # 守护进程核心（智能体生命周期、WebSocket、MCP）
├── cli/                 # 命令行工具（paseo run/ls/logs/wait）
├── app/                 # Expo 移动端 + Web 客户端
├── desktop/             # Electron 桌面封装
├── website/             # 营销网站（paseo.sh）
└── expo-two-way-audio/  # 双向音频支持
```

### 各包职责

| 包 | 用途 |
|---|---|
| `packages/server` | 守护进程：智能体生命周期管理、WebSocket API、MCP 服务器 |
| `packages/app` | 移动端 + Web 客户端（基于 Expo） |
| `packages/cli` | Docker 风格的命令行工具（`paseo run/ls/logs/wait`） |
| `packages/relay` | 端到端加密中继，用于远程访问 |
| `packages/desktop` | Electron 桌面端封装 |
| `packages/website` | 营销网站（paseo.sh） |
| `packages/protocol` | 有线协议 schema 定义（Zod） |
| `packages/client` | 守护进程客户端库 |
| `packages/highlight` | 语法高亮库 |

## 构建依赖链

```
highlight → relay → protocol → client → server → CLI
                                  ↓
                               app (Expo)
                                  ↓
                              desktop (Electron)
```

**重要：** 当修改底层包时，必须按顺序重新构建所有依赖它的上层包。

## 关键构建命令

| 命令 | 构建内容 |
|------|---------|
| `npm run build:protocol` | 仅构建协议（有线 schema） |
| `npm run build:client` | 协议 + 客户端（守护进程客户端库） |
| `npm run build:server-deps` | highlight + relay + client（server/CLI 的所有依赖） |
| `npm run build:server` | 完整的 server + CLI 构建 |
| `npm run build:app-deps` | highlight + client + expo-two-way-audio（app 的所有依赖） |
| `npm run build:daemon-web-ui` | 构建守护进程内嵌的 Web UI |

`build:clean` 变体（如 `build:client:clean`）在构建前先执行 `clean`——适合 CI 环境或当 `dist/` 缓存导致问题时使用。本地迭代开发使用普通 `build` 以加快速度。

## 从零开始构建

### 第一步：环境准备

```bash
# 确保 Node.js 版本正确
node -v  # 应该是 22.20.0

# 克隆仓库
git clone https://github.com/getpaseo/paseo.git
cd paseo

# 安装依赖（会自动安装 lefthook git hooks）
npm install
```

### 第二步：按依赖顺序构建

```bash
# 1. 构建基础库
npm run build:highlight

# 2. 构建中继
npm run build:relay

# 3. 构建协议 + 客户端
npm run build:client

# 4. 构建服务端依赖（highlight + relay + client 的组合快捷方式）
npm run build:server-deps

# 5. 构建完整的服务端 + CLI
npm run build:server

# 6. 构建 App 依赖
npm run build:app-deps
```

或者直接一条命令构建全部：
```bash
npm run build
```

### 第三步：启动开发环境

需要**三个终端**分别启动不同服务：

**终端 1 — 启动守护进程：**
```bash
npm run dev:server
# 守护进程运行在 127.0.0.1:6768
```

**终端 2 — 启动 Expo 移动端/Web 开发服务器：**
```bash
npm run dev:app
# Expo 运行在 http://localhost:8081
```

**终端 3（可选）— 启动 Electron 桌面端：**
```bash
npm run dev:desktop
# 自动选择 8082-8089 之间的端口
```

### 第四步：验证构建

```bash
# 类型检查
npm run typecheck

# Lint 检查
npm run lint

# 格式化检查
npm run format:check

# 使用 CLI 验证守护进程
npm run cli -- daemon status
```

## PASEO_HOME 说明

`PASEO_HOME` 是存放运行时状态的目录（智能体、工作树、工作区配置、socket、守护进程日志）。解析规则：

- **服务器自身**（如桌面应用启动或 `npm run start`）默认使用 `~/.paseo`
- **仓库开发脚本**默认使用 `$ROOT/.dev/paseo-home`，将开发状态限定在当前检出目录
- **`npm run cli -- ...`** 自动使用当前检出的 `.dev/paseo-home` 和开发守护进程端点
- **Paseo 创建的工作树**从源检出复制持久化 JSON 元数据来初始化

## 守护进程端点

- 桌面应用启动的稳定守护进程：`localhost:6767`
- 根检出开发守护进程：`localhost:6768`
- 根检出 Expo：`http://localhost:8081`
- 根检出桌面开发 Expo：`8082` 到 `8089` 之间第一个空闲端口

## 关键约定和注意事项

### ⚠️ 重要规则

1. **绝不要重启主守护进程（端口 6767）**——它管理着所有正在运行的智能体。如果你是一个智能体，重启它会杀掉你自己的进程。

2. **绝不要假设超时意味着服务需要重启**——超时可能是暂时的。

3. **绝不要给测试添加认证检查**——智能体提供商自行处理认证。

4. **修改 App 路由、启动路由、记忆工作区恢复或活动工作区选择前，必须阅读 `docs/expo-router.md`。**

5. **绝不要运行完整测试套件**——测试非常重，会卡死机器。只运行你改动的单个测试文件：
   ```bash
   npx vitest run <file> --bail=1
   ```
   各包测试命令：
   | 命令 | 范围 |
   |------|------|
   | `npm run test --workspace=@getpaseo/protocol` | 协议单元测试 |
   | `npm run test --workspace=@getpaseo/client` | 客户端单元测试 |
   | `npm run test:unit --workspace=@getpaseo/server` | 服务端单元测试 |
   | `npm run test:integration --workspace=@getpaseo/server` | 服务端集成测试 |
   | `npm run test:e2e --workspace=@getpaseo/server` | 服务端 E2E 测试 |
   | `npm run test --workspace=@getpaseo/cli` | CLI 测试 |
   | `npm run test --workspace=@getpaseo/app` | App 测试 |
   | `npm run test --workspace=@getpaseo/relay` | 中继测试 |

6. **每次改动后必须运行 typecheck 和 lint。**

7. **构建依赖包后再诊断跨包类型错误**——类型检查依赖 `dist/` 中的声明文件。如果在依赖其他工作区的包中 typecheck 失败，先重新构建所属的构建栈。

8. **提交前运行 `npm run format`**——使用 oxfmt 格式化，不要手动修复格式。

9. **始终使用 npm scripts 进行 lint 和格式化**，不要直接运行 `npx eslint`、`npx oxfmt` 等：
   ```bash
   npm run lint -- packages/app/src/components/message.tsx
   npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx
   ```

### 协议向后兼容

协议 schema 变更必须满足两个方向的兼容性：
- 旧客户端仍能解析新守护进程的消息
- 新守护进程仍能解析旧客户端的消息

具体规则：
- 新字段使用 `.optional()` 并提供合理默认值或 `.transform()` 回退
- 不要将 optional 改为 required，不要删除字段，不要缩小类型（如 `string` → `enum`）
- 移除的字段仍然接受（我们停止发送，但不停止读取）
- 所有向后兼容的 shim 都必须标记 `COMPAT(name)` 注释，注明添加版本和目标移除日期

### 功能检测

新功能可能要求新的守护进程能力：
- 客户端检测能力是否存在，存在则运行功能，不存在则显示"更新主机以使用此功能"
- **不做降级回退路径**——用户要么升级，要么不用这个功能
- 能力标志位于 `server_info.features.*`

### 跨平台开发

App 运行在 iOS、Android、Web（浏览器）和 Web（Electron 桌面）四个平台：

| 守卫 | 类型 | 用途 |
|------|------|------|
| `isWeb` | 常量 | DOM API——`document`、`window`、`<div>`、`addEventListener`。这是**例外**而非默认 |
| `isNative` | 常量 | 原生 API——Haptics、`StatusBar.currentHeight`、推送令牌、相机 |
| `getIsElectron()` | 缓存函数 | 桌面封装功能——文件对话框、标题栏拖拽区域、守护进程管理 |
| `useIsCompactFormFactor()` | hook | 布局决策——侧边栏覆盖 vs 固定、模态框 vs 全屏、单面板 vs 分割 |

原则：
- **默认跨平台**，不要无故设限
- **优先使用 Metro 文件扩展名**而非 `if` 语句——`.web.ts`/`.native.ts`/`.electron.tsx`
- **不要在 `isWeb` 守卫外使用原始 DOM API**
- **不要使用 `onPointerEnter`/`onPointerLeave`**——它们在原生 iOS 上不会触发
- **Hover 只在 Web 上有效**——使用 `isHovered || isNative || isCompact` 模式

### 测试哲学

- 垂直切片的 TDD（一个测试 → 一个实现 → 重复）
- 使用真实依赖而非 mock
- 不稳定的测试视为 bug
- 只使用确定性断言
- 完整测试套件只在 CI 上运行

## 文档体系

`docs/` 目录是系统级和流程级知识的事实来源。

| 文档 | 内容 |
|------|------|
| `docs/product.md` | Paseo 是什么、面向谁、发展方向 |
| `docs/architecture.md` | 系统设计、包分层、WebSocket 协议、智能体生命周期、数据流 |
| `docs/agent-lifecycle.md` | 智能体状态、父子关系、归档语义、标签页 vs 归档 |
| `docs/data-model.md` | 基于文件的 JSON 持久化、Zod schema、原子写入、无迁移 |
| `docs/glossary.md` | 权威术语表——UI 标签优先，无同义词 |
| `docs/coding-standards.md` | 类型规范、错误处理、状态设计、React 模式、文件组织 |
| `docs/design.md` | 主题令牌——颜色、字体、间距、圆角、图标 |
| `docs/hover.md` | Hover 规范模式及智能体破坏它的三种方式 |
| `docs/unistyles.md` | Unistyles 陷阱——`useUnistyles()` 禁用及替代方案 |
| `docs/floating-panels.md` | 锚定弹出框——Portal/Modal Android 兼容、生命周期守卫等 |
| `docs/expo-router.md` | Expo Router 路由所有权、启动恢复和原生白屏陷阱 |
| `docs/file-icons.md` | 文件浏览器的 Material 图标主题集成 |
| `docs/providers.md` | 添加新智能体提供商的端到端指南 |
| `docs/custom-providers.md` | 自定义提供商配置 |
| `docs/service-proxy.md` | 服务代理：将工作区脚本暴露为公共 URL |
| `docs/development.md` | 开发服务器、构建同步陷阱、CLI 参考、Playwright MCP |
| `docs/rpc-namespacing.md` | WebSocket RPC 命名约定 |
| `docs/terminal-performance.md` | 终端延迟管道、合并/背压不变量 |
| `docs/testing.md` | TDD 工作流、确定性、真实依赖优于 mock、测试组织 |
| `docs/mobile-testing.md` | Maestro 和移动端测试工作流 |
| `docs/android.md` | App 变体、本地/云端构建、EAS 工作流 |
| `docs/docker.md` | Docker 中运行守护进程和 Web UI |
| `docs/release.md` | 发布手册、草稿发布、完成检查清单 |
| `docs/i18n.md` | 客户端 UI 翻译（8 种语言） |
| `docs/timeline-sync.md` | 实时流 vs 权威历史、追赶分页、恢复行为 |
| `SECURITY.md` | 中继威胁模型、E2E 加密、DNS 重绑定、智能体认证 |

## 常用命令速查

```bash
# 开发
npm run dev                          # 启动开发守护进程（127.0.0.1:6768）
npm run dev:app                      # 启动 Expo（端口 8081）连接开发守护进程
npm run dev:desktop                  # 启动 Electron 桌面开发（自动选择 8082-8089 端口）
npm run dev:website                  # 启动营销网站开发服务器

# CLI
npm run cli -- ls -a -g              # 列出所有智能体
npm run cli -- ls -a -g --json       # 同上，JSON 格式
npm run cli -- inspect <id>          # 显示智能体详细信息
npm run cli -- logs <id>             # 查看智能体时间线
npm run cli -- daemon status         # 检查守护进程状态

# 平台运行目标
npm run android                      # Android（debug）
npm run ios                          # iOS（debug）
npm run web                          # Web 浏览器

# 代码质量
npm run typecheck                    # 类型检查所有工作区
npm run lint                         # Lint 所有文件
npm run format                       # 自动格式化所有文件
npm run format:check                 # 检查格式化（不写入）
npm run knip                         # 检查未使用代码

# 构建
npm run build:protocol               # 重新构建有线 schema
npm run build:client                 # 重新构建守护进程客户端库
npm run build:server                 # 重新构建完整 server + CLI
npm run build:daemon-web-ui          # 构建守护进程内嵌 Web UI
```

## i18n（国际化）

客户端 UI 支持 8 种语言（`en`、`ar`、`es`、`fr`、`ja`、`pt-BR`、`ru`、`zh-CN`）。英文源字符串位于 `packages/app/src/i18n/resources/en.ts`。

- 只翻译客户端拥有的 UI 文案
- 不翻译智能体输出、守护进程日志、终端内容、文件路径、提供商/模型名称、原始协议错误
- 运行 parity 测试检查缺失的 key：`npx vitest run packages/app/src/i18n/resources.test.ts --bail=1`

---

# Highlight 模块深度分析

## 概述

`@getpaseo/highlight` 是 Paseo 项目中**语法高亮库**，位于依赖链的最底层。它的职责是将代码文本解析为带有样式标记的 Token 数组，供上层（app、desktop）渲染彩色代码。

## 技术基础

基于 **Lezer** 增量解析器系统（CodeMirror 生态），搭配 `@lezer/highlight` 的 `highlightTree` 做语法标记。不依赖 CodeMirror 编辑器本身，只用了它的语法解析能力。

| 属性 | 值 |
|------|-----|
| 包名 | `@getpaseo/highlight` |
| 运行环境 | Node.js / 浏览器（ES Module） |
| TypeScript 目标 | ES2020 |
| 依赖数 | 16 个 Lezer/Codemirror 语言包 |
| 源文件 | 5 个核心文件 + 4 个测试文件 |

## 架构

```
src/
├── types.ts          # 类型定义（20 种高亮样式）
├── colors.ts         # GitHub 亮/暗色板（手调精确色值）
├── themes.ts         # 8 套语法主题 + 10 色角色调色板 → 20 色的展开引擎
├── parsers.ts        # 文件扩展名 → Lezer 解析器映射（30+ 语言）
├── highlighter.ts    # 核心高亮引擎：解析 → 标记 → 分行 Token
└── __tests__/        # 4 个测试文件
```

## 逐文件分析

### 1. `types.ts` — 类型定义

定义了 20 种 `HighlightStyle`：

| 类别 | 样式 |
|------|------|
| 关键字 | `keyword` |
| 注释 | `comment` |
| 字面量 | `string`、`number`、`literal`、`regexp`、`escape` |
| 标识符 | `function`、`definition`、`class`、`type`、`variable` |
| 标记/属性 | `tag`、`attribute`、`property` |
| 标点 | `operator`、`punctuation` |
| 结构 | `meta`、`heading`、`link` |

每个 Token 的结构：
```typescript
interface HighlightToken {
  text: string;          // 代码文本片段
  style: HighlightStyle | null;  // 样式标记，null 表示无高亮
}
```

### 2. `parsers.ts` — 语言解析器注册表

通过**文件扩展名**查找对应的 Lezer 解析器，支持 30+ 种语言：

| 语言族 | 扩展名 | 解析器 |
|--------|--------|--------|
| JS/TS | `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` | `@lezer/javascript`（配置不同 dialect） |
| C/C++/ObjC | `.c` `.h` `.cc` `.cpp` `.cxx` `.hpp` `.hxx` `.m` `.mm` | `@lezer/cpp` |
| 标记语言 | `.html` `.htm` `.xml` `.md` `.mdx` `.css` `.scss` `.json` `.yaml` `.yml` | 各自 Lezer 解析器 |
| 后端 | `.java` `.py` `.go` `.php` `.rs` | 各自 Lezer 解析器 |
| 移动端 | `.swift` `.dart` | CodeMirror StreamLanguage 兼容层 |
| 其他 | `.cs` `.ex` `.exs` | 第三方 Lezer 解析器 |

关键点：
- **Swift 和 Dart** 使用了 `StreamLanguage.define()` ——这是 CodeMirror 6 为兼容旧版 CodeMirror 5 模式提供的适配层，说明这两个语言还没有成熟的 Lezer 原生解析器
- **JSX/TSX** 通过 `parser.configure({ dialect: "..." })` 在同一个 JS 解析器上开启方言支持

导出三个函数：
- `getParserForFile(filename)` — 获取解析器或 null
- `isLanguageSupported(filename)` — 判断是否支持
- `getSupportedExtensions()` — 返回所有支持的扩展名列表

### 3. `highlighter.ts` — 核心高亮引擎

这是模块的心脏。工作流程：

```
源代码 → Lezer Parser → 语法树 → highlightTree → 字符级样式映射 → 分行 Token 数组
```

**步骤一：构建 Tag → Style 映射**

用 `tagHighlighter` 将 Lezer 的 `tags`（如 `tags.keyword`、`tags.comment`）映射到 20 种 `HighlightStyle`。共 40+ 条映射规则，其中：
- 4 种不同的 keyword 子类 → 都映射为 `"keyword"`
- 4 种 comment 子类 → 都映射为 `"comment"`
- `tags.special(tags.string)` → `"string"`（处理模板字符串内的插值等特殊情况）
- `tags.function(tags.variableName)` vs `tags.function(tags.propertyName)` → 都映射为 `"function"`

**步骤二：highlightCode 主函数**

```typescript
function highlightCode(code: string, filename: string): HighlightToken[][]
```

1. 根据文件名获取解析器，不支持则返回纯文本（`style: null`）
2. 解析代码为 Lezer 语法树
3. 按行分割代码
4. 用 `highlightTree` 遍历语法树，将每个字符位置映射到样式（`styleMap` 数组）
5. 按行遍历，合并连续相同样式的字符为一个 Token

**步骤三：highlightLine 便捷函数**

```typescript
function highlightLine(line: string, filename: string): HighlightToken[]
```

单行版本的封装，直接调用 `highlightCode` 取第一行。

**设计亮点**：
- 字符级样式映射（`styleMap`）保证了即使语法节点互相嵌套，每个字符也能有正确的样式
- 相邻同样式字符的合并逻辑简洁有效
- 空行和空输入都有正确处理

### 4. `colors.ts` — GitHub 默认色板

手调的两套色板（暗色/亮色），精确匹配 GitHub 的代码配色：

| 样式 | 暗色 | 亮色 |
|------|------|------|
| keyword | `#ff7b72` | `#cf222e` |
| string | `#a5d6ff` | `#0a3069` |
| comment | `#8b949e` | `#6e7781` |
| function | `#d2a8ff` | `#8250df` |
| class | `#ffa657` | `#953800` |

这两套色板保留在 `colors.ts` 中是为了**精确性和字节级向后兼容**——GitHub 主题已经有了大量用户，不能悄然改变颜色。

### 5. `themes.ts` — 8 套语法主题系统

**设计理念**：语法高亮主题与 App 的亮/暗主题**独立选择**，仅通过亮/暗轴耦合——亮色 App 用主题的亮色变体，暗色 App 用暗色变体。纯暗色主题（Dracula、Nord）无论 App 的亮暗都只用一套色板。

**8 套主题**：
| ID | 名称 | 亮/暗变体 |
|----|------|----------|
| `github` | GitHub | ✅ 两者 |
| `catppuccin` | Catppuccin | ✅ Latte/Mocha |
| `dracula` | Dracula | ❌ 仅暗色 |
| `tokyo-night` | Tokyo Night | ✅ Day/Night |
| `one` | One | ✅ Light/Dark |
| `nord` | Nord | ✅ Snow Storm/Polar Night |
| `gruvbox` | Gruvbox | ✅ Light/Dark |
| `solarized` | Solarized | ✅ Light/Dark |

**RolePalette 展开机制**：

每个主题只定义 10 种 **角色颜色**（`RolePalette`），然后通过 `expandRolePalette()` 自动展开为完整的 20 种 `HighlightStyle` 映射。展开规则体现了语义分组：

```typescript
// 这些映射揭示了 20 种 HighlightStyle 之间的语义层次：
string → string, regexp, link         // 都是"字符串类"
number → number, literal, escape      // 都是"数值/字面量类"
function → function, definition, heading  // 都是"定义类"
type → class, type                    // 都是"类型类"
attribute → attribute, property       // 都是"属性类"
base → variable, punctuation          // 都是"基础文本类"
comment → comment, meta               // 都是"注释/元信息类"
```

这个设计非常精妙——添加新主题只需提供 10 个颜色值，而非 20 个，减少了主题创作的工作量和出错可能。

## 依赖关系

```
@getpaseo/highlight
├── @lezer/highlight          ← highlightTree + tagHighlighter（核心引擎）
├── @lezer/common             ← Parser 类型
├── @codemirror/language      ← StreamLanguage（Swift/Dart 兼容层）
├── @codemirror/legacy-modes  ← Swift、Dart 旧版模式
├── @lezer/javascript         ← JS/TS/JSX/TSX 解析
├── @lezer/json               ← JSON 解析
├── @lezer/css                ← CSS/SCSS 解析
├── @lezer/html               ← HTML 解析
├── @lezer/xml                ← XML 解析
├── @lezer/markdown           ← Markdown/MDX 解析
├── @lezer/python             ← Python 解析
├── @lezer/rust               ← Rust 解析
├── @lezer/go                 ← Go 解析
├── @lezer/java               ← Java 解析
├── @lezer/php                ← PHP 解析
├── @lezer/cpp                ← C/C++/ObjC 解析
├── @lezer/yaml               ← YAML 解析
├── @replit/codemirror-lang-csharp ← C# 解析（第三方）
├── lezer-elixir              ← Elixir 解析（第三方）
```

## 公共 API

```typescript
// 类型
export type { HighlightStyle, HighlightToken }
export type { SyntaxThemeId, SyntaxThemeOption, SyntaxColors }

// 高亮函数
export { highlightCode, highlightLine }

// 语言检测
export { getParserForFile, isLanguageSupported, getSupportedExtensions }

// 颜色
export { darkHighlightColors, lightHighlightColors }

// 主题
export { SYNTAX_THEME_IDS, SYNTAX_THEME_OPTIONS, isSyntaxThemeId, resolveSyntaxColors }
```

## 在 Paseo 中的位置

作为依赖链的最底层（`highlight → relay → protocol → client → ...`），highlight 模块被 `packages/app` 直接依赖（用于渲染代码块的语法高亮），不依赖 Paseo 的任何其他包。它是一个**纯函数库**，没有副作用，输入代码字符串和文件名，输出结构化的 Token 数组。

多场景复用：
```
highlight-cache.ts  ← LRU 缓存 + 大小上限（100k 字符）
  ├── highlighted-code-block.tsx  ← Markdown 代码块渲染
  ├── file-pane.tsx               ← 文件预览
  ├── message.tsx                 ← 消息中的代码片段
  ├── tool-call-details.tsx       ← Edit diff / Write / Read 详情
  └── harmonyos-mvp-plan.md       ← 鸿蒙移植计划中也复用它
```

---

# Highlight 设计决策：为什么不用 tree-sitter？

## 为什么要自建 highlight 模块？

highlight 模块的定位不是一个"自己造的轮子"，而是对 Lezer 生态的**薄封装**——它做的是：

1. **统一接口**：将 16 个不同语言解析器（Lezer 原生 + CodeMirror legacy + 第三方）统一为一个 `highlightCode(code, filename)` 调用
2. **平台无关的 Token 输出**：输出的是 `HighlightToken[]` 结构体，不是 HTML 字符串。Paseo 的 React Native 渲染层需要结构化数据来驱动 `MarkdownTextSpan`
3. **主题系统**：8 套语法主题 + RolePalette 展开机制
4. **多场景复用**：被代码块、文件预览、消息、工具调用详情等多个组件消费

## 为什么不用 tree-sitter？

### 1. 跨平台 = 最大的硬约束

Paseo 运行在 **iOS、Android、Web、Electron** 四个平台：

| 方案 | iOS | Android | Web | Electron |
|------|-----|---------|-----|----------|
| **Lezer** | ✅ 纯 JS | ✅ 纯 JS | ✅ 纯 JS | ✅ 纯 JS |
| **tree-sitter (原生)** | ❌ 需编译 C → `.dylib` | ❌ 需编译 C → `.so` | ❌ 浏览器无法加载原生库 | ❌ 需 `node-gyp` 编译 |
| **tree-sitter (WASM)** | ⚠️ JSC 下 WASM 性能差 | ⚠️ Hermes 对 WASM 支持有限 | ⚠️ 每个语法 ~1-3MB | ✅ 可用 |

Paseo 的 mobile app 跑在 React Native 上，iOS 用 JavaScriptCore，Android 用 Hermes——它们对 WASM 的支持远不如桌面浏览器的 V8。

### 2. 体积

```
tree-sitter:  30 grammar WASMs × ~1.5MB avg ≈ 45MB
Lezer:        30 JS parser bundles × ~50KB avg ≈ 1.5MB
```

对移动端 App 来说，45MB 只是语法高亮功能的开销是不可接受的。Lezer 的 JS 语法文件会被 Metro bundler tree-shake 和压缩。

### 3. 需求不匹配——Paseo 只需要着色，不需要精确 AST

tree-sitter 的核心价值在于**增量解析 + 精确语法树**，适合编辑器语义分析和代码转换。Paseo 对语法高亮的需求是**只读展示**：
- 不需要增量更新（每次展示的是完整代码块，不是实时编辑）
- 不需要语法树查询（不需要 `(function_declaration name: (identifier) @name)` 这种 query）
- 只需要"这个词是什么颜色"

Lezer 的 `highlightTree` 恰好就是为"只做着色"这个场景设计的，它遍历语法树时直接回调 `(from, to, style)`，一步到位产生字符级样式映射。

### 4. 生态和维护

```
Lezer:
  - CodeMirror 团队维护，与编辑器生态深度绑定
  - 语法包发布在 npm，版本管理简单
  - highlightTree API 稳定，专为 token 级着色设计

tree-sitter:
  - 语法质量参差不齐（社区贡献为主）
  - WASM 绑定需要 tree-sitter + tree-sitter-wasm + 每个语言的 WASM
  - 版本碎片化——不同语法可能依赖不同 tree-sitter ABI 版本
```

### 5. Paseo 没有本地编译工具链的假设

Paseo 的 app 层（Expo）特意避免了需要原生编译的依赖——这样可以用 Expo 的托管构建（EAS Build），开发者不需要维护 Xcode/Gradle 本地工具链。引入 tree-sitter 会打破这个设计原则。

### 总结对比表

| 约束 | Lezer | tree-sitter |
|------|-------|-------------|
| 纯 JS 跨平台（iOS/Android/Web/Electron） | ✅ | ❌ |
| 无原生编译工具链依赖 | ✅ | ❌ |
| 30+ 语言包体积可控 | ✅ ~1.5MB | ❌ ~45MB |
| 只需着色不需 AST 查询 | ✅ highlightTree | ⚠️ 功能过剩 |
| React Native 直接消费输出 | ✅ Token[] → React | ⚠️ 需桥接层 |

---

# Highlight 端到端渲染流程

## 输入

假设 AI 智能体回复了一段代码块：

````markdown
下面是答案：

```ts
// greeting.ts
function greet(name: string): string {
  return `Hello, ${name}!`;
}

const result = greet("World");
console.log(result);
```
````

## 处理流程

### 第 1 步：Markdown 解析器提取 fenced code block

```typescript
// 从 markdown 中提取出:
code = '// greeting.ts\nfunction greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nconst result = greet("World");\nconsole.log(result);'
language = "ts"     // fence info string  "```ts"
```

### 第 2 步：语言别名 → 文件扩展名

```typescript
// highlighted-code-block.tsx
function fenceLanguageToExtension(info: string | null | undefined): string | null {
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();  // "ts"
  const normalized = first.replace(/^\./, "");                // "ts"
  return LANGUAGE_ALIASES[normalized] ?? normalized;          // "ts"
}
```

### 第 3 步：highlightToKeyedLines → 带缓存的语法解析

```typescript
// highlight-cache.ts
// 缓存 key = "ts:<code>"
// 1. 检查 LRU 缓存（200 条上限），命中直接返回
// 2. 检查代码长度 > 100_000 字符？超过则跳过（避免主线程卡顿）
// 3. 调用 @getpaseo/highlight 的 highlightCode(code, "x.ts")
```

### 第 4 步：Lezer 解析 + 样式映射（核心）

```typescript
// highlighter.ts — highlightCode(code, "x.ts")

// 4a. 选择解析器：扩展名 "ts" → @lezer/javascript parser (ts dialect)
const parser = jsParser.configure({ dialect: "ts" });

// 4b. 解析为语法树
const tree = parser.parse(code);
// 语法树内部结构（简化）：
// Program
//   VariableDeclaration  ← "const result = greet(...)"
//     Keyword: "const"
//     VariableDefinition: "result"
//     CallExpression:
//       Function: "greet"
//       String: '"World"'

// 4c. highlightTree 遍历语法树，每个节点查 tagHighlighter 映射表
highlightTree(tree, highlighter, (from, to, classes) => {
  for (let i = from; i < to; i++) {
    styleMap[i] = classes;  // 字符级样式
  }
});
```

此时 `styleMap` 的样子（每个字符一个样式标签）：

```
位置:  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 ...
字符:  /  /     g  r  e  e  t  i  n  g  .  t  s \n  f  u  n  c  t
样式:  c  c  -  c  c  c  c  c  c  c  c  c  c  c  -  k  k  k  k  k
       ↑ comment     ↑ comment 持续...              ↑ keyword 开始
```

### 第 5 步：样式 map → 分行 Token 数组

```typescript
// highlighter.ts — 按行遍历，合并相邻同款字符
// 输出：HighlightToken[][]
[
  // 第 0 行
  [{ text: "// greeting.ts", style: "comment" }],
  // 第 1 行
  [
    { text: "function", style: "keyword" },
    { text: " ",      style: null },
    { text: "greet",  style: "definition" },
    { text: "(",      style: "punctuation" },
    { text: "name",   style: "variable" },
    { text: ":",      style: "punctuation" },
    { text: "string", style: "type" },
    { text: ")",      style: "punctuation" },
    { text: ":",      style: "punctuation" },
    { text: "string", style: "type" },
    { text: " {",     style: "punctuation" }
  ],
  // 第 2 行
  [
    { text: "  return", style: "keyword" },
    { text: " `Hello, ${name}!`", style: "string" },
    { text: ";", style: "punctuation" }
  ],
  // 第 3 行
  [{ text: "}", style: "punctuation" }],
  // 第 4 行（空行）
  [{ text: "", style: null }],
  // 第 5 行
  [
    { text: "const", style: "keyword" },
    { text: " result", style: "definition" },
    { text: " = ", style: "punctuation" },
    { text: "greet", style: "function" },
    { text: '("World");', style: "punctuation" }
  ],
  // 第 6 行
  [
    { text: "console", style: "variable" },
    { text: ".", style: "punctuation" },
    { text: "log", style: "function" },
    { text: "(result);", style: "punctuation" }
  ]
]
```

### 第 6 步：附加 key（用于 React 渲染）

```typescript
// highlight-cache.ts — highlightToKeyedLines
// 为每个 token 生成稳定的 React key
```

### 第 7 步：React 渲染

```typescript
// highlighted-code-block.tsx
function renderCodeSegments(keyedLines: KeyedLine[]): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  for (let i = 0; i < keyedLines.length; i++) {
    if (i > 0) {
      segments.push(<MarkdownTextSpan key={`line-${i}-nl`}>{'\n'}</MarkdownTextSpan>);
    }
    for (const { key, token } of keyedLines[i].tokens) {
      segments.push(<TokenSpan key={`line-${i}-${key}`} token={token} />);
    }
  }
  return segments;
}
```

### 第 8 步：syntaxTokenStyleFor 查主题色

```typescript
// syntax-token-styles.ts
// 用户选了 "catppuccin" 主题，App 当前是暗色模式
// → resolveSyntaxColors("catppuccin", "dark")
// → expandRolePalette(catppuccinMocha)
// → { keyword: "#cba6f7", comment: "#9399b2", string: "#a6e3a1", ... }
```

### 最终视觉结果

```
// greeting.ts                              ← #9399b2 (comment, 灰色)
function greet(name: string): string {      ← function=#cba6f7, greet=#89b4fa, string=#f9e2af
  return `Hello, ${name}!`;                 ← return=#cba6f7, 模板字符串=#a6e3a1
}

const result = greet("World");              ← const=#cba6f7, result=#89b4fa, greet=#89b4fa
console.log(result);                        ← console=#cdd6f4, .log=#89b4fa
```

## 完整数据流图

```
Markdown 文本
  │
  ▼
fenced code block 提取 (Markdown 解析器)
  │  code = "...", language = "ts"
  ▼
fenceLanguageToExtension("ts") → "ts"
  │
  ▼
highlightToKeyedLines(code, "ts")
  │
  ├─ LRU 缓存命中？ → 直接返回
  │
  └─ 未命中:
       │
       ▼
     highlightCode(code, "x.ts")           ← @getpaseo/highlight
       │
       ├─ getParserForFile("x.ts")         ← parsers.ts 查表
       │    └─ jsParser.configure({dialect:"ts"})
       │
       ├─ parser.parse(code)               ← Lezer 解析
       │
       ├─ highlightTree(tree, highlighter) ← 语法树 → 字符样式
       │
       └─ 分行合并同款字符 → HighlightToken[][]
       │
       ▼
     highlight-cache.ts 存入 LRU
       │
       ▼
     toKeyedLine() → KeyedLine[]
       │
       ▼
  renderCodeSegments(keyedLines)
       │
       ▼
  TokenSpan × N
       │  syntaxTokenStyleFor(token.style)
       │  resolveSyntaxColors(currentTheme, colorScheme)
       ▼
  手机上看到彩色代码 🎨
```

---

# Rust 生态中的同类库对比

在 Rust 生态里，与 Paseo 的 highlight 模块对标的库主要有三个：

## 1. syntect — 最直接的对标

[syntect](https://github.com/trishume/syntect) 是 Rust 生态最流行的语法高亮库，`bat`、`delta`、`zola` 都在用它。

| 维度 | Paseo highlight (Lezer) | syntect |
|------|------------------------|---------|
| 解析引擎 | Lezer（增量语法树） | Sublime Text 的 `.sublime-syntax`（Oniguruma 正则） |
| 语法来源 | 每个语言一个解析器 npm 包 | `.sublime-syntax` YAML 文件（可复用 Sublime/Bat 生态） |
| 输出 | `HighlightToken[]`（结构化数组） | `Vec<(Style, &str)>`（样式 + 文本行） |
| 主题 | 自定义 RolePalette 展开（8 套） | `.tmTheme` XML 文件（数百套社区主题可直接用） |
| 语言数 | 30+（硬编码在 parsers.ts） | 官方子包 `syntect::dumps` 内置 100+ 语法 |

syntect 的优势是 **Sublime 社区的语法定义和主题资源海量可直接复用**，缺点是用正则匹配而非真正的语法解析——对嵌套结构的处理不如 Lezer/tree-sitter 精确。

## 2. tree-sitter-highlight — 更精确，但更重

[tree-sitter-highlight](https://crates.io/crates/tree-sitter-highlight) 是 tree-sitter 官方的语法高亮库，Helix 编辑器就在用它。

| 维度 | Paseo highlight (Lezer) | tree-sitter-highlight |
|------|------------------------|----------------------|
| 解析引擎 | Lezer（纯 JS） | tree-sitter（C 编译） |
| 语法定义 | npm 包 | 每个语言的 `.so`/`.dylib` 或 WASM |
| 查询方式 | `highlightTree` 回调 | tree-sitter Query（`highlights.scm` 文件） |
| 增量 | ❌ Paseo 是只读场景，不需要 | ✅ 原生支持增量重解析 |

tree-sitter-highlight 在精度上明显优于 syntect，因为它有真正的语法树。但在 Rust 原生应用里，"编译 C"不是问题——这正是它在 Rust 生态反而不是缺点的原因。

## 3. syntastica — 新一代竞争者

[syntastica](https://github.com/RubixDev/syntastica) 试图同时支持 tree-sitter 和 TextMate 语法两种后端。设计理念是用 tree-sitter 当解析器，但把着色逻辑抽象为通用接口——更接近 Paseo 的定位（薄封装，统一接口）。

## 综合对比表

| | Paseo highlight | syntect | tree-sitter-highlight | syntastica |
|---|---|---|---|---|
| **语言** | TypeScript | Rust | Rust | Rust |
| **解析方式** | Lezer（语法树） | 正则（Oniguruma） | tree-sitter（语法树） | tree-sitter（语法树） |
| **精度** | 高（真正的 AST） | 中（正则状态机） | 高（真正的 AST） | 高（真正的 AST） |
| **语法生态** | ~30 种，需手动添加 | 100+，社区 `.sublime-syntax` | 200+，社区 `tree-sitter-*` | 继承 tree-sitter |
| **主题生态** | 8 套，手动维护 | 数百套 `.tmTheme` 文件 | 需 Query 文件 | 继承 tree-sitter |
| **输出格式** | `HighlightToken[][]`（结构化 JS 对象） | `Vec<(Style, &str)>` | 样式 spans | 样式 spans |
| **跨平台** | ✅ 纯 JS | ✅ 纯 Rust | ⚠️ 需编译 C 或 WASM | ⚠️ 需编译 C 或 WASM |
| **增量解析** | ❌ 不需要 | N/A（正则无树） | ✅ | ✅ |
| **谁在用** | Paseo | bat, delta, zola, mdBook | Helix, Zed, neovide | 较少 |

## 核心差异：设计哲学

Paseo 的 highlight 模块和 Rust 这三个库代表了三种设计路线：

```
Paseo (Lezer)         → "刚好够用"——30 种语言，8 套主题，纯 JS，面向移动端
syntect               → "生态为王"——100+ 语言随便用，复用 Sublime 20 年的积累
tree-sitter-highlight  → "精确为上"——编辑器级的 AST 查询，为语义着色而生
```

如果要在 Rust 里做一个类似 Paseo highlight 的库，最合理的选择取决于场景：
- **CLI 工具渲染代码** → **syntect**（轻量，主题多）
- **代码编辑器/LSP 前端** → **tree-sitter-highlight**（精确，增量）
- **移动端/嵌入式/WASM** → Lezer 更合适，或 tree-sitter WASM 的轻量子集

Paseo 选 Lezer 的关键原因是**纯 JS 跨平台 + 不引入原生编译**——这个约束在 Rust 生态里不存在（Rust 本身就是编译型语言），所以 syntect 和 tree-sitter-highlight 在 Rust 世界里反倒是更自然的选择。

---

# Relay 模块深度分析

## 概述

`@getpaseo/relay` 是 Paseo 项目中的 **E2E 加密中继模块**，负责在守护进程（daemon）和客户端（app）之间建立安全的双向通信通道。它解决的核心问题是：让手机在外网安全地连接到家里/公司的开发机，无需开放端口、无需 VPN。

设计核心理念：**中继是不可信的**——relay 服务器只看到 IP 地址、时序、消息大小和握手阶段的公钥，无法读取消息内容、伪造消息或从握手过程中推导出加密密钥。

## 技术基础

| 属性 | 值 |
|------|-----|
| 包名 | `@getpaseo/relay` |
| 运行环境 | Node.js / 浏览器 / Cloudflare Workers |
| 加密原语 | NaCl (tweetnacl) — Curve25519 + XSalsa20-Poly1305 |
| 部署平台 | Cloudflare Workers (Durable Objects) |
| 运行时依赖 | 仅 3 个（tweetnacl, base64-js, ws） |
| 源文件 | 7 个核心文件 + 6 个测试文件（含 1 个 E2E 测试） |

## 架构

```
src/
├── crypto.ts                    # 底层 NaCl 加密原语（Curve25519 密钥交换 + XSalsa20-Poly1305 加解密）
├── base64.ts                    # Base64 编解码工具（支持标准 + URL-safe）
├── encrypted-channel.ts         # ECDH 握手协议 + 加密通道状态机（最核心的文件）
├── e2ee.ts                      # 对上层暴露的 E2EE 统一出口（纯 re-export）
├── cloudflare-adapter.ts        # Cloudflare Durable Objects 适配器 + Worker 入口
├── types.ts                     # 共享类型定义（ConnectionRole, RelaySessionAttachment）
└── __tests__/                   # 测试文件
```

### 三个入口点

| 入口 | 路径 | 用途 |
|------|------|------|
| 主入口 | `@getpaseo/relay` | crypto 原语 + encrypted-channel（客户端和守护进程都使用） |
| E2EE | `@getpaseo/relay/e2ee` | 对上层封装好的 E2EE 接口 |
| Cloudflare | `@getpaseo/relay/cloudflare` | Cloudflare Worker + Durable Object 部署 |

## 依赖

```
@getpaseo/relay
├── tweetnacl      ← NaCl 加密库（Curve25519 + XSalsa20-Poly1305）
├── base64-js      ← 二进制 ↔ base64 文本转换
└── ws             ← WebSocket 类型定义（devDependencies 中的 @types/ws）
```

relay 模块不依赖 Paseo 的任何内部包，仅依赖 2 个纯 JS 加密/编码库，是一个**独立可部署的安全通信模块**。

## 逐文件分析

### 1. `types.ts` — 共享类型定义

```typescript
type ConnectionRole = "server" | "client";

interface RelaySessionAttachment {
  serverId: string;
  role: ConnectionRole;
  version?: "1" | "2";            // 协议版本
  connectionId?: string | null;   // v2 中每条连接的唯一标识
  createdAt: number;
}
```

两个角色（daemon ↔ client）对称地通过 WebSocket 连接 relay，通过 `serverId` 匹配同一会话。

### 2. `crypto.ts` — NaCl 加密原语

**密码学方案：**

| 步骤 | 算法 | 说明 |
|------|------|------|
| 密钥生成 | Curve25519 | 32 字节公钥 + 32 字节私钥 |
| 密钥交换 | ECDH (`box.before`) | 双方用对方公钥 + 自己私钥 → 32 字节共享密钥 |
| 加密 | XSalsa20-Poly1305 (`box.after`) | AEAD 认证加密，每次生成 24 字节随机 nonce |
| 传输编码 | `[nonce: 24B] [ciphertext]` | 二进制 → base64 文本（WebSocket 兼容） |

**核心函数：**
```typescript
generateKeyPair()                                  // → { publicKey, secretKey }
exportPublicKey(publicKey) / importPublicKey(b64)  // Uint8Array ↔ base64
deriveSharedKey(secretKey, peerPublicKey)          // → 32-byte SharedKey
encrypt(sharedKey, data)       // string|ArrayBuffer → ArrayBuffer (nonce + ciphertext)
decrypt(sharedKey, data)       // ArrayBuffer → string (优先 UTF-8) | ArrayBuffer
```

**PRNG 适配**：`ensurePrng()` 优先 `nacl.randomBytes`（Node.js），fallback 到 `crypto.getRandomValues`（浏览器/Cloudflare Workers），保证三平台安全随机数。

**解密输出策略**：解密后先尝试 UTF-8 解码为字符串，失败则返回 ArrayBuffer——通道同时支持文本和二进制数据传输。

### 3. `encrypted-channel.ts` — ECDH 握手 + 加密通道状态机

这是 relay 模块最核心的文件（~460 行），实现了完整的握手协议和安全通道。

#### 握手协议

```
客户端 (initiator)                              守护进程 (responder)
     │                                               │
     │  ① 扫描 QR 码 → 获得 daemon 公钥                │
     │  ② 生成临时密钥对                               │
     │  ③ 用自己的私钥 + daemon 公钥 → 共享密钥         │
     │                                               │
     │ ─── e2ee_hello {type, key: clientPubKey} ──→  │
     │                                               │
     │                          ④ 解析 hello，验证消息格式
     │                          ⑤ 接管 onmessage，缓存后续消息
     │                          ⑥ daemon 私钥 + client 公钥 → 共享密钥
     │                                               │
     │  ←────── e2ee_ready {type} ──────────────    │
     │                                               │
     │  ⑦ 收到 ready → 状态 open，flush 积压消息      │  ⑦ 发完 ready → 状态 open
     │                                               │
     │  ═══════════ 加密通信开始 ═══════════          │  ═══════════ 加密通信开始 ═══════════
```

**为什么是 `e2ee_hello` / `e2ee_ready` 而非 `hello` / `ready`？**

早期版本用 `hello` / `ready`，但 `ready` 与 AI 智能体的 "ready" 状态通知冲突。加上 `e2ee_` 前缀隔离了协议层和应用层消息。`dist-handshake-parity.test.ts` 专门验证编译产物不包含旧版字符串。

#### 客户端通道

```typescript
createClientChannel(transport, daemonPublicKeyB64, events)
```

关键行为：
- 生成临时密钥对 → 立即推导共享密钥
- 发送 `e2ee_hello`（含自己公钥）
- **每 1 秒重试**，直到收到 `e2ee_ready` 或通道关闭
- 重试中 send 抛错不崩溃（daemon 重启期间 socket 可能处于 CLOSING/CLOSED），通过 `onerror` 事件报告
- 使用 `unref()` 避免阻塞 Node 进程退出（测试友好）

#### 守护进程通道

```typescript
createDaemonChannel(transport, daemonKeyPair, events)
```

关键行为：
- 等待第一个消息 → 解析为 `e2ee_hello`
- 验证失败时抛出详细错误（含 `receivedType`、`hasKey`、消息预览）
- 验证成功 → **立即接管 onmessage**，缓存后续消息（防止下一个加密消息被误解析为 hello）
- 推导共享密钥 → 发送 `e2ee_ready`
- 回放缓存的消息（跳过重复的 hello/ready）

#### 加密通道状态机

```
connecting → handshaking → open → closed
```

| 状态 | send 行为 | receive 行为 |
|------|----------|-------------|
| `handshaking` | 缓存到 pending 队列（上限 200 条） | 等待 `e2ee_ready` |
| `open` | `encrypt → base64 → transport.send` | `base64→decrypt → events.onmessage` |
| `closed` | 抛出错误 | 忽略 |

#### 安全：re-handshake 保护

通道 open 后收到新的 `e2ee_hello` 时：

| 情况 | 行为 | 原因 |
|------|------|------|
| **同一 client 公钥** | 重新发送 `e2ee_ready`，不更换密钥 | 客户端丢包重试，换密钥会解密失败 |
| **不同的 client 公钥** | 关闭通道（code 1008） | 防止 MITM 在已建立的安全通道上替换密钥 |

#### Transport 抽象

```typescript
interface Transport {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}
```

WebSocket 的最小抽象——加密通道可以与任何符合此接口的传输层配合（浏览器 `WebSocket`、Node.js `ws`、Cloudflare DO WebSocket）。

### 4. `base64.ts` — Base64 编解码

```typescript
arrayBufferToBase64(ArrayBuffer)   → base64 string
base64ToArrayBuffer(base64 string) → ArrayBuffer
```

支持标准 base64 和 URL-safe base64（`-`→`+`, `_`→`/`），自动补全 `=` 填充。将加密后的二进制 `[nonce|密文]` 编码为 WebSocket 文本帧。

### 5. `cloudflare-adapter.ts` — Cloudflare 部署

部署在 Cloudflare Workers 上，使用 **Durable Objects (DO)** 实现有状态的 WebSocket 中继。

#### 协议版本

| 版本 | 连接模型 | 说明 |
|------|---------|------|
| **v1** | `server ←→ client`（单 server socket + 单 client socket） | 早期设计，保留向后兼容 |
| **v2** | 控制通道 + 每连接独立 data 通道 | 当前版本，支持多 client |

Worker 入口通过 `v` 参数做版本隔离路由到不同的 DO 实例：`relay-v1:<serverId>` 和 `relay-v2:<serverId>`。

#### v2 连接拓扑

```
守护进程                               Relay DO                              客户端
─────────                             ────────                             ────────
server-control ───(sync/connected/disconnected)──→ [server-control]
                                                                           client:conn_abc
server:conn_abc ←──(加密数据)──→ [server:conn_abc] ←──(加密数据)──→       client:conn_xyz
server:conn_xyz ←──(加密数据)──→ [server:conn_xyz] ←──(加密数据)──→       ...
```

| Socket 类型 | 数量限制 | 职责 |
|------------|---------|------|
| `server-control` | 每 serverId 1 条 | 接收客户端连接/断开事件 |
| `server:connId` | 每连接 1 条 | 双向转发加密数据 |
| `client:connId` | 每连接多条 | 支持断线重连而不丢失会话 |

#### 消息转发（webSocketMessage）

```
v1:  server → 所有 client  /  client → 所有 server
v2:  client → server:connId 存在则直接转发，不存在则 buffer（上限 200 条）
     server-data → 所有 client:connId
     server-control → COMPAT: 处理 JSON {type:"ping"} 保活
```

#### 控制通道保活（COMPAT）

```typescript
// COMPAT(relay-json-ping): Old daemons (< v0.1.76) send JSON {type:"ping"}
// and rely on JSON {type:"pong"} reply. New daemons use WebSocket protocol
// pings (auto-answered at the edge, DO stays hibernated).
// Remove when daemon floor >= v0.1.76 (target: 2026-11-13).
```

#### 半开连接检测

Cloudflare WebSocket 可能接受写入但对端实际已断开（half-open）。检测和恢复：

1. **T+10s**：发送 `sync` 消息 nudge daemon → 如果 daemon 正常，会建立 data socket
2. **T+15s**：如果仍无 data socket，关闭所有 server-control → 强制 daemon 重连

#### 连接断开清理

```
最后一个 client socket close  →  清理 pendingFrames
                               →  关闭 server:connId
                               →  广播 disconnected 事件到 server-control

server data socket close       →  关闭所有 client:connId（强制客户端重连并重握手）
```

#### WebSocket 休眠

Cloudflare DO 的核心成本优势：无活动消息时 DO 休眠（不消耗 CPU/内存），消息到达时自动唤醒。Paseo relay 大多数时间空闲，休眠大幅降低成本。

### 6. `e2ee.ts` — 统一出口

纯 re-export 模块，将 encrypted-channel 和 crypto 中上层需要的部分集中导出，提供干净的 `@getpaseo/relay/e2ee` 入口。

## 公共 API

```typescript
// 主入口 @getpaseo/relay
export type { ConnectionRole, RelaySessionAttachment }
export { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encrypt, decrypt }
export { createClientChannel, createDaemonChannel, EncryptedChannel }
export type { Transport, EncryptedChannelEvents }

// E2EE 入口 @getpaseo/relay/e2ee
export { createClientChannel, createDaemonChannel, EncryptedChannel }
export { generateKeyPair, exportPublicKey, importPublicKey, exportSecretKey, importSecretKey }

// Cloudflare 入口 @getpaseo/relay/cloudflare
export { RelayDurableObject }
export default relayWorker  // Cloudflare Worker fetch handler
```

## 安全模型

来自 `SECURITY.md`：

> The relay is designed to be **untrusted**. All traffic between phone and daemon is end-to-end encrypted. Even if the relay is compromised, your data remains protected.

| 中继能看到 | 中继不能做 |
|-----------|-----------|
| IP 地址、时序、消息大小 | 读取消息内容（XSalsa20-Poly1305 加密） |
| session ID | 伪造消息（NaCl box AEAD 认证，篡改即被检测） |
| `e2ee_hello` / `e2ee_ready` 握手帧（仅公钥） | 从握手推导密钥（Curve25519 ECDH，中继只看到双方公钥） |
| — | 跨会话重放（每会话全新临时密钥对，旧密文无效） |

**额外防护**：守护进程可选配置共享密钥密码（`auth.password` / `PASEO_PASSWORD`），HTTP + WebSocket 携带 Bearer token，密码 bcrypt 哈希存储。

## 在 Paseo 中的位置

```
构建依赖链: highlight → relay → protocol → client → server → CLI
                                     ↑                    ↑
                               app 也通过 client 消费    server 消费 relay
```

```
packages/relay
├── 被 @getpaseo/server 依赖  ← daemon 连接 relay（encrypted-channel + cloudflare）
└── 被 @getpaseo/app 依赖     ← 客户端连接 relay（encrypted-channel，通过 client 包）
```

## 关键设计决策

### 1. 为什么 E2EE 而非仅 TLS？

TLS 保护传输层，但 relay 自身仍能读取明文。E2EE 保证 relay 完全沦陷后数据依然安全。

### 2. 为什么 NaCl (tweetnacl) 而非 WebCrypto？

| 约束 | NaCl (tweetnacl) | WebCrypto |
|------|-----------------|-----------|
| Node.js | ✅ 纯 JS | ✅ 原生 |
| 浏览器 | ✅ | ✅ |
| Cloudflare Workers | ✅ 纯 JS | ⚠️ 部分支持 |
| React Native (iOS JSC / Android Hermes) | ✅ | ⚠️ 有限支持 |

tweetnacl 纯 JS 实现在所有环境下都工作。

### 3. 为什么 Durable Objects 而非普通 WebSocket 服务器？

| 因素 | Durable Objects | 普通 WS 服务器 |
|------|----------------|---------------|
| 状态管理 | 内置单例 | 需 Redis/DB |
| 水平扩展 | Cloudflare 自动 | 需手动设计 |
| 休眠/唤醒 | 原生支持 → 低成本 | 需自己实现 |
| 运维 | 近零 | 需管服务器 |
| 延迟 | 全球边缘网络 | 取决于部署位置 |

WebSocket 休眠是成本杀手——空闲时不消耗资源。

### 4. 为什么 v1/v2 两套协议？

v1 只有一条 server ↔ client 通道。v2 分离控制通道和数据通道：

- 多 client 共享同一 session
- client 断连时 daemon 能收到通知（v1 中唯一通道死了就通知不了）
- 控制流量（sync/connected/disconnected）与数据流量（加密消息）隔离

## E2E 测试

`e2e.test.ts` 使用 `wrangler dev` 本地启动 relay DO，建立真实 WebSocket 连接完成完整加密消息交换：

1. wrangler dev 本地启动（模拟 Cloudflare DO）
2. 守护进程连接（server-control + server-data）
3. 客户端连接（client）
4. 客户端通过 data 通道发送 `e2ee_hello`（含公钥）
5. 守护进程收到 → 推导共享密钥
6. 双向交换加密消息
7. 验证 relay 看到的只有密文（原始 WebSocket 消息不含明文）
8. 验证错误密钥无法解密

条件跳过：Node.js ≥ 25 时 wrangler dev 有已知兼容性问题，默认跳过。设置 `FORCE_RELAY_E2E=1` 强制运行。

---

# Protocol 模块深度分析

## 概述

`@getpaseo/protocol` 是 Paseo 的**共享协议层**——定义守护进程（daemon）和客户端（app/CLI）之间所有通信的 schema、类型和数据格式。它是整个项目的"宪法"：所有 RPC 消息、持久化数据结构和跨包类型都在这里定义。所有上层包（client、server、app、CLI）都依赖它。

协议层的核心约束（来自 CLAUDE.md）：
- **向后兼容是必须的**——schema 变更不能让旧客户端解析不了新守护进程的消息，反之亦然
- **新功能需要能力检测**——客户端检查 `server_info.features.*`，不支持则不启用，不做降级回退
- **COMPAT 注释标记所有兼容性 shim**——方便未来清理

## 技术基础

| 属性 | 值 |
|------|-----|
| 包名 | `@getpaseo/protocol` |
| 唯一运行时依赖 | **Zod v4**（schema 定义和验证） |
| TypeScript 目标 | ES2020 |
| 总代码量 | ~33,600 行（含测试） |
| 核心文件 | `messages.ts`（4,747 行，597 个导出） |
| 子模块 | 5 个子目录（binary-frames, browser-automation, chat, loop, schedule） |
| 导出模式 | `./*` 通配（子路径可直接导入，如 `@getpaseo/protocol/schedule/rpc-schemas`） |

## 架构

```
src/
├── messages.ts                          # 核心：所有顶层 RPC schema + 类型（~4,747 行）
│
├── agent-lifecycle.ts                   # Agent 生命周期状态（5 种）
├── agent-types.ts                       # Agent 领域核心类型（~490 行）
├── agent-labels.ts                      # Agent 标签（筛选/分组/排序）
├── agent-state-bucket.ts                # Agent 状态分桶（UI 状态聚合）
├── agent-title-limits.ts                # 标题长度限制
├── agent-feature-schemas.ts             # Agent 功能开关/选项 schema
├── agent-attention-notification.ts      # Agent 关注通知
│
├── client-capabilities.ts               # 客户端能力声明（4 个 cap flag）
├── connection-offer.ts                  # 配对连接 offer 解析（QR 码 #offer= 片段）
├── host-connection-schema.ts            # 主机连接配置 schema
│
├── provider-manifest.ts                 # 提供商注册表（5 个真实 + 2 个 mock）
├── provider-config.ts                   # 提供商配置
├── provider-icon-names.ts               # 提供商图标名
│
├── paseo-config-schema.ts              # paseo.json 配置 schema
├── daemon-endpoints.ts                  # 守护进程端点
│
├── git-remote.ts                        # Git 远程 URL 工具
├── path-utils.ts                        # 路径工具函数
├── error-utils.ts                       # 错误处理工具
├── literal-union.ts                     # 字面量联合类型工具
│
├── terminal-snapshot.ts                 # 终端快照 → ANSI 转义序列渲染器
├── terminal-stream-protocol.ts          # 终端二进制流协议（opcode 编解码）
├── terminal-activity.ts                 # 终端活动指标
├── terminal-input-mode.ts               # 终端输入模式
├── terminal-key-input.ts                # 终端按键输入
├── terminal-profiles.ts                 # 终端配置档案
├── terminal-subscription-key.ts         # 终端订阅键
│
├── tool-call-display.ts                 # 工具调用 UI 展示
├── tool-name-normalization.ts           # 工具名规范化
│
├── binary-frames/                       # 二进制帧协议
│   ├── demux.ts                         # 多路解复用（demux）
│   ├── file-transfer.ts                 # 文件传输二进制帧
│   └── terminal.ts                      # 终端二进制帧编解码
│
├── browser-automation/                  # 浏览器自动化
│   ├── rpc-schemas.ts                   # 22 种浏览器命令 schema
│   └── capabilities.ts                  # 浏览器自动化能力声明
│
├── chat/                                # 多智能体聊天室
│   ├── types.ts                         # ChatRoom, ChatMessage 类型
│   └── rpc-schemas.ts                   # chat/*.request / chat/*.response
│
├── schedule/                            # 定时任务调度
│   ├── types.ts                         # Schedule, Cadence, Target 类型
│   ├── rpc-schemas.ts                   # schedule/* RPC schema
│   └── cron-expression.ts               # Cron 表达式解析
│
├── loop/                                # 循环运行
│   └── rpc-schemas.ts                   # loop/* RPC schema
│
└── __tests__/                           # 30+ 测试文件
```

## 核心领域分析

### 1. `messages.ts` — 协议核心

这是 Paseo 中**最大的单体文件**（4,747 行），包含所有客户端↔守护进程的 WebSocket 消息 schema。它使用 Zod v4 定义每一对 request/reply 消息。

**RPC 命名规范**（`docs/rpc-namespacing.md`）：
- Request: `domain.provider.operation`（如 `chat/create`）
- Response: `domain.provider.operation.response`（如 `chat/create/response`）
- 每条 request 有唯一的 `requestId`（`z.string()`），response 在 `payload.requestId` 中回传

**消息类别概览**：

| 域 | 请求示例 | 说明 |
|----|---------|------|
| Agent 管理 | `FetchAgentsRequest`, `SendAgentMessage`, `ArchiveAgentRequest`, `AbortRequest` | 创建、查询、控制 agent |
| Daemon 运维 | `DaemonGetStatusRequest`, `DaemonGetPairingOfferRequest`, `DiagnosticsRequest` | 守护进程状态和诊断 |
| 工作区 | `FetchWorkspacesRequest`, `WorkspaceTitleSetRequest` | 多工作区管理 |
| 配置 | `GetDaemonConfigRequest`, `ReadProjectConfigRequest`, `WriteProjectConfigRequest` | 守护进程和项目配置 CRUD |
| 音频 | `VoiceAudioChunkMessage`, `AudioPlayedMessage`, `SetVoiceModeMessage` | 语音输入流 |
| 听写 | `DictationStreamStart`, `DictationStreamChunk`, `DictationStreamFinish`, `DictationStreamCancel` | 语音转文字 |
| Agent 历史 | `FetchAgentHistoryRequest`, `FetchRecentProviderSessionsRequest` | 会话历史恢复 |
| 项目操作 | `ProjectRenameRequest`, `ProjectRemoveRequest` | 项目管理 |

**Schema 设计模式**：

```typescript
// 1. 基础模式：string literal 区分消息类型
export const AbortRequestMessageSchema = z.object({
  type: z.literal("abort"),
  requestId: z.string(),
  agentId: z.guid(),
});

// 2. discriminator 模式：type 字段分发不同的 payload
export const AgentFeatureSchema = z.discriminatedUnion("type", [
  AgentFeatureToggleSchema,      // { type: "toggle", ... }
  AgentFeatureSelectSchema,      // { type: "select", ... }
]);

// 3. passthrough 模式：允许未知字段（向后兼容的关键）
export const MutableDaemonConfigSchema = z.object({...}).passthrough();

// 4. 子模块 schema 被导入并统一嵌入
// messages.ts 从 chat/rpc-schemas.ts 等文件导入，保持一致的 RPC 约定
```

**Timeline 事件体系**：

```
AgentStreamEvent (discriminated union)
  ├── thread_started      ← 新会话
  ├── turn_started        ← 新回合
  ├── turn_completed      ← 回合完成（含 usage）
  ├── turn_failed         ← 回合失败
  ├── turn_canceled       ← 回合取消
  ├── timeline            ← 产出时间线条目
  │   └── AgentTimelineItem
  │       ├── user_message
  │       ├── assistant_message
  │       ├── reasoning
  │       ├── tool_call (running/completed/failed/canceled)
  │       │   └── ToolCallDetail (shell/read/edit/write/search/fetch/sub_agent...)
  │       ├── todo
  │       ├── error
  │       └── compaction
  ├── permission_requested ← 权限请求
  ├── permission_resolved  ← 权限裁决
  ├── mode_changed        ← 模式切换
  ├── model_changed       ← 模型切换
  ├── usage_updated       ← 用量更新
  └── attention_required  ← 需要用户关注
```

### 2. `agent-types.ts` — Agent 领域类型（~490 行）

定义了 Agent 运行时所需的所有核心类型：

| 类型 | 说明 |
|------|------|
| `AgentSessionConfig` | Agent 启动配置（provider, cwd, systemPrompt, model, mode, mcpServers...） |
| `AgentModelDefinition` | 模型定义（provider, id, label, contextWindow, thinkingOptions） |
| `AgentRunOptions` | 运行选项（outputSchema, resumeFrom, maxThinkingTokens） |
| `AgentRunResult` | 运行结果（sessionId, finalText, usage, timeline, canceled） |
| `AgentUsage` | Token/成本统计（inputTokens, outputTokens, totalCostUsd） |
| `AgentCapabilityFlags` | 提供商能力标志（supportsStreaming, supportsMcpServers...） |
| `AgentPersistenceHandle` | 会话持久化句柄（provider + sessionId） |
| `AgentPermissionRequest` | 权限请求（tool approval, plan confirmation, mode change） |
| `AgentPermissionResponse` | 权限裁决（allow + updatedInput / deny + message） |
| `ToolCallDetail` | 工具调用详情（discriminated union: shell/read/edit/write/search/fetch/sub_agent...） |
| `McpServerConfig` | MCP 服务器配置（stdio/http/sse 三种 transport） |
| `AgentStreamEvent` | 流式事件（discriminated union: 10+ 事件类型） |
| `AgentTimelineItem` | 时间线条目（消息、工具调用、todo、错误、压缩） |

### 3. `agent-lifecycle.ts` — Agent 生命周期

```typescript
const AGENT_LIFECYCLE_STATUSES = [
  "initializing", "idle", "running", "error", "closed"
];
```

5 种状态覆盖 agent 的完整生命周期。协议层只定义常量，不包含状态转换逻辑（状态机在 `packages/server` 中实现）。

### 4. `client-capabilities.ts` — 能力协商

```typescript
export const CLIENT_CAPS = {
  reasoningMergeEnum: "reasoning_merge_enum",
  customModeIcons: "custom_mode_icons",         // COMPAT: >= v0.1.84
  terminalReflowableSnapshot: "terminal_reflowable_snapshot",  // COMPAT: >= v0.1.88
  browserHost: "browser_host",
};
```

客户端在 WebSocket 连接时宣告自己的能力集，守护进程据此决定发送哪些字段和格式。每个 flag 都有 `COMPAT` 注释标明添加版本和清理条件。

### 5. `connection-offer.ts` — 配对连接

```typescript
ConnectionOfferV2 = {
  v: 2,
  serverId: string,
  daemonPublicKeyB64: string,   // 守护进程公钥
  relay: { endpoint: string, useTls?: boolean }  // 中继地址
}
```

配对 URL 格式：`https://app.paseo.sh/#offer=<base64url encoded JSON>`

这个 URL 就是 QR 码的内容——客户端扫描后解析出 `serverId` + 守护进程公钥 + 中继地址，然后通过 relay 发起加密连接。

### 6. `provider-manifest.ts` — 提供商注册表

定义了 6 个内置提供商定义：

| Provider | id | modes | voice 支持 |
|----------|----|-------|-----------|
| Claude | `claude` | default, auto, acceptEdits, plan, bypassPermissions | ✅ |
| Codex | `codex` | auto, auto-review, full-access | ✅ |
| Copilot | `copilot` | agent (ACP), plan (ACP), allow-all | ❌ |
| OpenCode | `opencode` | build, plan | ✅ |
| Pi | `pi` | (none) | ❌ |
| OMP | `omp` | (none) | ❌ |

还有 2 个仅开发环境使用的 mock provider：
| Provider | id | 用途 |
|----------|----|------|
| Mock Load Test | `mock` | 输出大量合成 agent 流量用于性能测试 |
| Mock Slow | `mock-slow` | 模拟缓慢的模型发现过程，测试加载和超时 UI |

每个 mode 携带视觉元数据（icon + colorTier），支持 4 种颜色层级：`safe`（安全）、`moderate`（中等）、`dangerous`（危险）、`planning`（规划）。

### 7. 子模块

#### `binary-frames/` — 二进制帧协议

WebSocket 通道上混合传输 JSON RPC 消息和二进制帧。二进制帧通过 demux（demultiplexer）路由到不同处理程序：

| 帧类型 | 文件 | 用途 |
|--------|------|------|
| Terminal | `terminal.ts` | 终端 I/O（output/input/resize/snapshot/restore，5 种 opcode） |
| File Transfer | `file-transfer.ts` | 大文件传输 |
| Demux | `demux.ts` | 二进制帧路的多路分解 |

终端帧格式（2 字节头 + payload）：
```
[opcode: 1B] [slot: 1B] [payload...]
```

#### `browser-automation/` — 浏览器自动化

通过 Playwright 驱动的远程浏览器控制，支持 22 种命令：

```
list_tabs, new_tab, snapshot, click, fill, wait, type, keypress,
navigate, back, forward, reload, screenshot, upload, select, hover,
drag, logs, evaluate, scroll, resize, close_tab
```

使用严格的 Zod schema 验证所有命令参数，包括 `browserId` 格式验证（UUID 或时间戳连字符模式）。

#### `chat/` — 多智能体聊天室

让多个 agent 在同一个聊天室中对话。RPC 接口：`chat/create`, `chat/list`, `chat/inspect`, `chat/post`, `chat/read`, `chat/wait`。

`chat/wait` 支持长轮询——客户端调用后等待新消息（可选 `afterMessageId` 和 `timeoutMs`）。

#### `schedule/` — 定时任务调度

| 概念 | 说明 |
|------|------|
| Schedule | 定时任务定义（id, name, prompt, cadence, target, status） |
| Cadence | 执行频率：`every`（固定毫秒间隔）或 `cron`（cron 表达式 + 时区） |
| Target | 执行目标：`agent`（已有 agent）或 `new-agent`（每次新建） |
| ScheduleRun | 执行记录（id, scheduledFor, startedAt, endedAt, status, output） |
| ScheduleSummary | 仅摘要（不含 runs 数组，列表页用） |

`new-agent` target 使得每次定时执行都会创建一个全新 agent——适合定期 CI 类任务，保证干净的上下文。

#### `loop/` — 循环运行

`loop/*` RPC 提供与 `/loop` CLI 命令对应的交互式循环控制（run/list/inspect/logs/stop）。

### 8. `terminal-snapshot.ts` — 终端快照渲染

将 `TerminalState`（包含 grid、scrollback、光标、样式）序列化为 ANSI 转义序列字符串，供 xterm.js 终端模拟器恢复显示。关键特性：

- 支持 3 种颜色模式（3-bit、8-bit 调色板、24-bit 真彩）
- 软换行行标注（`gridWrapped`/`scrollbackWrapped`）支持 resize 时的内容回流
- 光标样式（block/underline/bar）和闪烁状态通过 DECSCUSR 序列渲染
- 兼容旧版：无 wrap info 时使用硬换行模式（`[?7l`）

## Schema 设计模式

### 向后兼容策略

```
1. .passthrough()     ← 允许未知字段  
2. .optional() + .default()  ← 新字段带默认值
3. .catch({})         ← 解析失败静默回退
4. z.union([...])      ← 联合类型扩展而非替换
5. .partial()         ← Patch schema 全部可选
```

### COMPAT 注释模式

```typescript
// COMPAT(projectMetadataAgentTitle): `agentTitle` project metadata prompts were
// removed in v0.1.96; keep legacy paseo.json parseable until 2026-12-16.
.passthrough()
```

每个兼容性 shim 都标记了：名称、添加/移除版本、目标清理日期。一个 `rg "COMPAT\("` 就能找到所有待清理项。

### Features 能力门控

```typescript
// 客户端告知能力
CLIENT_CAPS: { customModeIcons, terminalReflowableSnapshot, browserHost }

// 守护进程告知能力
server_info.features: { 
  schedules: true,      // COMPAT(schedules): added in v0.1.X
  loop: true, 
  chat: true,
  // ...
}
```

客户端在一个地方检查能力 → 下游代码读干净的 shape → 不支持时显示"更新主机以使用此功能"。

## 协议包在依赖链中的位置

```
highlight → relay → protocol → client → server → CLI
                         ↑            ↑
                      app 通过 client 消费    server 消费
```

- **protocol 不调用任何外部服务**——它只是一个类型定义库
- **运行时成本为零**——除了 Zod 的 `.parse()` 调用，没有 I/O 或计算开销
- **每个上层包都通过子路径导入 protocol**——`@getpaseo/protocol/messages`、`@getpaseo/protocol/agent-types` 等

## 公共 API

```typescript
// 核心消息
export { ... } from "@getpaseo/protocol/messages"
// 约 597 个导出：每个 request/response schema + 对应的 TS 类型

// Agent 类型
export { ... } from "@getpaseo/protocol/agent-types"
export { AGENT_LIFECYCLE_STATUSES } from "@getpaseo/protocol/agent-lifecycle"

// 配置
export { MutableDaemonConfigSchema, ... } from "@getpaseo/protocol/messages"

// 提供商
export { AGENT_PROVIDER_DEFINITIONS, ... } from "@getpaseo/protocol/provider-manifest"

// RPC 子模块
export { ... } from "@getpaseo/protocol/chat/rpc-schemas"
export { ... } from "@getpaseo/protocol/schedule/rpc-schemas"
export { ... } from "@getpaseo/protocol/loop/rpc-schemas"
export { ... } from "@getpaseo/protocol/browser-automation/rpc-schemas"

// 二进制帧
export { ... } from "@getpaseo/protocol/binary-frames"

// 终端
export { renderTerminalSnapshotToAnsi } from "@getpaseo/protocol/terminal-snapshot"
export { encodeTerminalStreamFrame, decodeTerminalStreamFrame } from "@getpaseo/protocol/terminal-stream-protocol"

// 连接配对
export { ConnectionOfferSchema, parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer"
```

## 设计亮点

### 1. Zod 作为单一事实来源

所有数据形状只用 Zod schema 定义一次，通过 `z.infer<>` 自动生成 TypeScript 类型。这消除了类型定义和运行时验证之间的不同步风险。

### 2. discriminated union 模式

Zod 的 `z.discriminatedUnion("type", [...])` 是 Paseo 协议最核心的模式——所有事件、消息、配置都通过 `type` 字段分发到不同的 payload schema。这使得：
- 运行时验证精确到具体的 payload 形状
- TypeScript 的类型收窄能覆盖所有分支（exhaustiveness check）
- 协议扩展只需添加新的 union member，不破坏现有解析

### 3. 子路径导出

```json
"exports": { "./*": { "types": "./dist/*.d.ts", "default": "./dist/*.js" } }
```

通配符导出使消费者可以按功能域导入，只加载需要的部分：
```typescript
import { ChatCreateRequestSchema } from "@getpaseo/protocol/chat/rpc-schemas"
```

### 4. 协议层保持"纯数据"

Protocol 包不包含任何网络 I/O、文件系统操作或副作用代码。唯一的"逻辑"代码是：
- `normalizeAgentModelDefinition` — 规范化模型定义（补全 thinking option 默认值）
- `getAgentProviderDefinition` — 查找提供商定义
- `parseConnectionOfferFromUrl` — URL 片段解析
- 终端二进制帧编解码函数
- ANSI 渲染（纯函数，输入 → 输出）

这些函数都不依赖外部状态或副作用。

### 5. 配置和类型集中管理确保了"单一真相来源"

如果没有 protocol 包，每个上层包会各自重复定义 schema。当你需要改一个字段时，需要同时改 4 个包的代码。protocol 包确保了 SCHEMA 变更是一处生效、全局一致的。
