---
title: 插件快速上手
description: 构建、安装、分享和更新一个受信任的 Paseo 插件。
nav: 快速上手
---

# 插件快速上手 {#plugin-quickstart}

插件是安装到某个 Paseo daemon 中的 TypeScript 项目。它可以添加[界面和侧边栏项](/docs/plugins/reference#screens-and-sidebar-items)、[工作区面板](/docs/plugins/reference#workspace-panels)、[文件面板](/docs/plugins/reference#file-panels)、[Command Center 项](/docs/plugins/reference#command-center-items)、[斜杠命令](/docs/plugins/reference#slash-commands)、[Composer 标签](/docs/plugins/reference#composer-pills)、[时间线条目](/docs/plugins/reference#timeline-items)、[主题](/docs/plugins/reference#contribute-a-theme)、[附件来源](/docs/plugins/reference#add-a-composer-attachment-source)和 [daemon 端 RPC](/docs/plugins/reference#add-plugin-specific-backend-behavior)。它还可以[把编程 Agent 接入为 Provider](/docs/plugins/providers)。客户端贡献会在连接到该 daemon 的每个 Paseo 客户端上运行，包括移动端。

浏览[已发布的插件](https://paseo.sh/plugins)，然后在你的 daemon 上安装一个：

```bash
paseo plugin add owner/slug
```

或者把 `owner/slug` 粘贴到 **设置 → 插件 → 插件来源**，然后选择 **安装插件**。Paseo 会安装注册表中经过审查的制品。想直接从 Git 仓库安装时，请使用 `git:owner/repository` 或完整的 Git URL。

本指南会搭建一个插件、运行它，并为它添加一个工作区面板。

## 创建插件 {#create-a-plugin}

使用 daemon 所在机器上的绝对路径：

```bash
paseo plugin init /absolute/path/to/workspace-plugin
cd /absolute/path/to/workspace-plugin
npm install
```

`init` 会写入一个严格模式的 TypeScript 项目，但不会运行包管理器。`npm install` 只添加用于类型检查和测试的开发依赖；插件 SDK、React、React Native、TanStack Query 和 Zod 由 Paseo 在运行时提供。

生成的脚手架就是一个可用的插件：一个从侧边栏打开的界面，其中有一个按钮，通过 RPC 向 daemon 请求一句问候。

```text
workspace-plugin/
  paseo-plugin.json      # plugin ID and supported Paseo versions
  index.client.tsx       # runs in the Paseo app
  index.server.ts        # runs in a daemon subprocess
  client/greeting.tsx    # the screen component
  client/web.ts          # the only file allowed to touch browser APIs
  server/greeting.ts     # the RPC handler
  shared/greeting.ts     # the RPC contract, imported by both
  package.json
  tsconfig.json
```

每个入口默认导出一个函数，该函数注册贡献并返回一个清理函数。`index.client.tsx` 注册界面以及打开它的侧边栏项：

```tsx
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GreetingScreen } from "./client/greeting";

function GreetingItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      active={currentScreen?.screenId === "greeting"}
      onPress={() => openScreen({ screenId: "greeting" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "greeting", title: "Greeting", Component: GreetingScreen });
  client.addSidebarHeaderItem({ id: "greeting", title: "Greeting", Component: GreetingItem });
  return () => {};
}
```

`index.server.ts` 为 `shared/greeting.ts` 中的契约注册处理函数：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  return () => {};
}
```

目录就是边界。`client/` 下的代码只编译进应用的包，`server/` 下的代码只编译进 daemon 的包，`shared/` 则编译进两者。跨越这条边界导入、在根目录添加代码文件，或在客户端代码中导入 `node:` 模块，都会导致编译错误。没有 daemon 端工作的插件可以省略 `index.server.ts`；没有 UI 的插件可以省略 `index.client.tsx`。

客户端代码既在浏览器中运行，也在手机上运行。项目在不包含 DOM 库的情况下进行类型检查，因此在 `client/web.ts` 之外使用 `document` 和 `window` 都会报错；`client/web.ts` 演示了如何用 `Platform.OS` 把浏览器 API 隔离开，并提供原生端的后备实现。编写 UI 之前，请先阅读[跨平台规则](/docs/plugins/reference#cross-platform-rules)。

## 安装并试用 {#install-and-try-it}

插件是受信任的、没有沙盒的代码：服务端代码和准备命令以 daemon 用户在 daemon 所在机器上的权限运行，客户端代码在 Paseo 应用内部运行。安装插件意味着你信任该代码库、它的依赖以及它将来的更新。

在你要安装到的 daemon 上，打开 **设置 → 插件** 下的 **启用插件**。它是该 daemon 上所有插件的全局开关，也对应 daemon 的 `config.json` 中根级的 `pluginsEnabled` 字段；编辑该文件后，用 `paseo reload --json` 应用更改。自动化工具必须先读取当前值，并在获得你的明确许可后才能打开它。

然后进行类型检查并安装：

```bash
npm run typecheck
paseo plugin install /absolute/path/to/workspace-plugin
paseo plugin ls
```

或者从应用中安装该目录：

1. 在目标主机上打开 **设置 → 插件**。
2. 把 `/absolute/path/to/workspace-plugin` 粘贴到 **插件来源**。
3. 选择 **安装插件**。应用会使用 `paseo-plugin.json` 中的插件 ID。

来源字段也接受 Git 仓库、npm 包和插件子目录。可接受的语法和解析规则见[插件来源](/docs/plugins/reference#plugin-sources)。如果表单要求你更新主机，请先更新该主机再安装；已有的管理操作仍然可用。

每个已安装插件的行都会显示它的状态和描述。用它的开关启用或停用它，打开它的三点菜单可以进行设置、查看日志、重新加载和移除。

`paseo plugin ls` 应该把该插件报告为 `running`。打开 Paseo，在侧边栏中选择 **Greeting**，然后按 **Create greeting**。消息会通过 RPC 从 daemon 子进程返回。

如果侧边栏项没有出现，请检查 **启用插件** 是否已打开、插件是否为 `running`，以及客户端正在查看的是否就是你安装到的主机。`paseo plugin logs workspace-plugin` 会显示 daemon 端的输出，包括加载错误。

## 添加工作区面板 {#add-a-workspace-panel}

工作区面板会作为标签页，与 Agent、终端和文件并排打开。创建 `client/overview.tsx`：

```tsx
import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function WorkspaceOverview({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({
    name,
    directory,
  }));
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      label: { color: theme.colors.foregroundMuted },
      detail: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{workspace?.name}</Text>
      <Text style={styles.label}>Directory</Text>
      <Text style={styles.detail}>{workspace?.directory}</Text>
    </View>
  );
}
```

`useWorkspace` 从应用的缓存状态中读取面板要渲染的字段，不需要 RPC，并且在无关字段变化时不会重新渲染。每个 `Text` 都从 `theme.colors` 获取颜色，`layout.compact` 决定间距，因此面板在每个 Paseo 主题和手机上都能正常显示。令牌列表见[主题与布局](/docs/plugins/reference#theme-and-layout)。

在 `index.client.tsx` 中加入以下内容，注册该面板以及一个打开它的 Command Center 项：

```tsx
import { WorkspaceOverview } from "./client/overview";

// Inside contribute(client), after the existing registrations:
client.addWorkspacePanel({
  id: "overview",
  title: "Workspace overview",
  icon: "PanelsTopLeft",
  context: "workspace",
  locations: ["workspace", "explorer"],
  Component: WorkspaceOverview,
});
client.addCommandCenterItem({
  id: "open-overview",
  title: "Open workspace overview",
  icon: "PanelsTopLeft",
  context: "workspace",
  onSelect({ openPanel }) {
    openPanel("overview");
  },
});
```

`icon` 可以是 [Lucide](https://lucide.dev/icons/) 图标名称、内联 SVG 或组件。参见[图标](/docs/plugins/reference#icons)。

## 编辑并重新加载 {#edit-and-reload}

只有在重新加载插件后，源码改动才会生效：

```bash
npm run typecheck
paseo plugin reload workspace-plugin
```

重新加载会停止旧的插件、运行它的清理函数、编译当前源码，然后重新启动它。重新加载失败后插件会保持失败状态，并在 `paseo plugin ls` 中报告错误；修复源码后再次重新加载即可。

打开一个工作区，在 macOS 上按 **⌘K**，在 Windows 和 Linux 上按 **Ctrl+K**，然后选择 **Open workspace overview**。面板会作为工作区标签页打开。

## 安装已发布的插件 {#install-a-published-plugin}

在 daemon 主机上用 npm 安装一个受信任的 npm 插件：

```bash
paseo plugin install npm:@acme/paseo-review@1.2.0
```

或者把同样的标识符粘贴到 **设置 → 插件 → 插件来源**，然后选择 **安装插件**。安装后的行使用 manifest 中的 ID，并提供与目录插件相同的启用开关以及 Logs、Reload 和 Remove 操作。获取插件时需要 npm；之后的加载和重新加载都使用已安装的文件。

标识符语法见[插件来源](/docs/plugins/reference#plugin-sources)。要分享你自己的插件，请按照[发布插件](/docs/plugins/publishing)操作。

发布在 Git 仓库中的插件通过显式的 Git 简写或 URL 安装：

```bash
paseo plugin add git:owner/repository
paseo plugin add https://gitlab.com/group/repository.git
paseo plugin add git:owner/monorepo:plugins/workspace
paseo plugin add git:owner/repository --ref main
```

当插件位于仓库根目录之下时，追加 `:relative/path`。`--ref` 只在首次安装时选择 Git 内容；省略时安装默认的 HEAD。确切的语法见[来源参考](/docs/plugins/reference#plugin-sources)。

```bash
paseo plugin ls
paseo plugin update workspace-plugin
paseo plugin update --all
```

`ls` 报告来源标识和当前已安装的版本，不会联系远程。`update` 会展示一个拟更新的 npm 或 Git 版本，并请求你批准。npm 提供更新的 latest 发布版本；Git 提供当前默认的 HEAD，与首次安装时的选择器无关。使用 `--check` 只预览，使用 `--yes` 则无需提示直接批准。显式目标和批量更新见 [CLI 参考](/docs/plugins/reference#cli-reference)。

## 读取后端日志 {#read-backend-logs}

daemon 端的处理函数和清理函数可以使用普通的 Node 日志：

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

在 **设置 → 插件** 下打开插件的三点菜单并选择 **Logs**，即可读取最近的输出；也可以使用 CLI：

```bash
paseo plugin logs workspace-plugin
paseo plugin logs workspace-plugin --json
```

日志尾部包含 `[paseo]` 的加载、就绪、停止中和已停止条目，以及编译和加载失败信息，并且在重新加载和崩溃后依然保留。客户端的输出留在应用中。保留策略以及哪些内容不应记录，见[调试后端输出](/docs/plugins/reference#debug-backend-output)。

## 下一步 {#next}

- [发布插件](/docs/plugins/publishing)：通过 npm、私有注册表或 Git 分享。
- [构建 Provider 插件](/docs/plugins/providers)：直接或通过 ACP 接入 Agent，渲染由 Provider 拥有的时间线条目，测试并发布它。
- [插件参考](/docs/plugins/reference)：每种贡献类型及其字段、运行时模块、宿主环境和 CLI。
- [把插件迁移到运行时入口](/docs/plugins/migration)：逐步迁移基于单一 `index.ts` 入口编写的插件。
- [TypeScript SDK](/docs/sdk)：在客户端和服务端代码中以 `paseo` 提供的工作区、Agent、Provider 和配置 API。
