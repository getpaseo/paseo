---
title: 把插件迁移到运行时入口
description: 把混合的插件入口机械地迁移为显式的客户端入口和服务端入口。
nav: 迁移
---

# 把插件迁移到运行时入口 {#migrate-a-plugin-to-runtime-entries}

本指南用于把为 Paseo 0.7 或更早版本编写的插件，更新为 0.8 引入的当前客户端/服务端入口格式。

把本页交给一个编程 Agent，并以插件目录作为它的工作目录。按顺序执行各个步骤。不要保留兼容入口。

## 1. 对现有代码分类 {#1-classify-the-existing-code}

从旧的结构开始：

```text
my-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.ts
  greeting.client.tsx
  greeting.server.ts
  greeting.shared.ts
```

完成后的结构是：

```text
my-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
```

只创建插件需要的入口，至少需要一个。组件和客户端回调需要客户端入口。RPC 处理函数和 Node API 需要服务端入口。

## 2. 重命名文件和目录 {#2-rename-files-and-directories}

严格按以下规则操作：

1. 用 `index.client.tsx`、`index.server.ts` 或两者替换混合的根入口。
2. 把每个 `name.client.ts` 或 `name.client.tsx` 移动到 `client/name.ts` 或 `client/name.tsx`。
3. 把每个 `name.server.ts` 或 `name.server.tsx` 移动到 `server/name.ts` 或 `server/name.tsx`。
4. 把每个 `name.shared.ts` 或 `name.shared.tsx` 移动到 `shared/name.ts` 或 `shared/name.tsx`。
5. 在对应的运行时目录下保留嵌套的功能目录。
6. 每次移动后更新相对导入路径。
7. 把 `paseo-plugin.json`、`package.json` 和 `tsconfig.json` 保留在根目录。
8. 删除旧的根入口。Paseo 不会加载它。

这些目录就是编译器的边界。`client/` 下的文件只编译进应用的包，`server/` 下的文件只编译进 daemon 的包，`shared/` 则编译进两者。`*.client.tsx` 之类的文件名后缀不再有任何含义，留在插件根目录的代码模块会导致编译错误。

## 3. 迁移每一处注册 {#3-move-every-registration}

把下表作为完整的注册检查清单。

| 旧的注册及位置                                                                                | 新的注册及位置                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 旧根入口中的 `plugin.handle(contract, handler)`                                               | `index.server.ts` 中的 `server.handle(contract, handler)`                                                              |
| 旧根入口中的 `plugin.addSurface(id, Component)`                                               | `index.client.tsx` 中的 `client.addScreen({ id, title, Component })`                                                   |
| 旧根入口中的 `plugin.addSidebarItem({ id, title, icon, surface })`                            | `index.client.tsx` 中的 `client.addSidebarHeaderItem({ id, title, Component })`；见[侧边栏项](reference#sidebar-items) |
| 新的侧边栏底部贡献                                                                            | `index.client.tsx` 中的 `client.addSidebarFooterItem({ id, title, Component })`                                        |
| 新的文件面板贡献                                                                              | `index.client.tsx` 中的 `client.addFilePanel(panel)`                                                                   |
| 旧根入口中的 `plugin.addWorkspacePanel(panel)`                                                | `index.client.tsx` 中的 `client.addWorkspacePanel(panel)`                                                              |
| 带有 `context: "agent"` 的 Agent 面板                                                         | `index.client.tsx` 中的 `client.addAgentPanel(panel)`；省略 `context`                                                  |
| 旧根入口中的 `plugin.addCommandCenterItem(item)`                                              | `index.client.tsx` 中的 `client.addCommandCenterItem(item)`                                                            |
| 旧根入口中的 `plugin.addClientSlashCommand(command)`                                          | `index.client.tsx` 中的 `client.addSlashCommand(command)`                                                              |
| 旧根入口中的 `plugin.addClientSide(fn)`                                                       | 删除这层包装，把 `fn` 的函数体移入默认的客户端入口函数                                                                 |
| 旧客户端回调中的 `client.addComposerPill(pill)`                                               | `index.client.tsx` 或被导入的 `client/` 函数中的 `client.addComposerPill(pill)`                                        |
| 新的标题栏贡献                                                                                | `client.addHeaderButton({ id, workspaceId, button })`                                                                  |
| 旧根入口中的 `plugin.addAttachmentSource(source)`                                             | `index.client.tsx` 中的 `client.addAttachmentSource(source)`                                                           |
| 新的设置界面贡献                                                                              | `index.client.tsx` 中的 `client.addSettingsScreen(screen)`；见[设置界面](reference#settings-screens)                   |
| 旧根入口中的 `plugin.addTheme(theme)`                                                         | `index.client.tsx` 中的 `client.addTheme(theme)`                                                                       |
| 旧根入口中的 `plugin.addTimelineTransformer(transformer)`                                     | `index.client.tsx` 中的 `client.addTimelineTransformer(transformer)`                                                   |
| 旧根入口中的 `plugin.addTimelineRenderer(renderer)`                                           | `index.client.tsx` 中的 `client.addTimelineRenderer(renderer)`                                                         |
| shared 文件中的 `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin/server"` | `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin"`                                                 |
| 处理函数参数类型 `ZodOutput<typeof contract.input>`                                           | 来自 `@getpaseo/plugin` 的 `RpcInput<typeof contract>`；返回类型使用 `RpcOutput`                                       |

用原 `addSidebarItem` 项的 `id` 注册替代它的界面，这样已保存的链接仍然有效。`/plugin/<plugin>/sidebar/<id>` 链接以及更早的 `/plugin/<plugin>/<id>` 链接，会打开具有该 `id` 的 `addSidebarItem`，否则打开具有该 `id` 的界面。

从 `@getpaseo/plugin/client` 导入 `PluginClientContext`，从 `@getpaseo/plugin/server` 导入 `PluginServerContext`。删除对旧 context 类型的导入。客户端注册返回幂等的移除函数，但标题栏按钮和 Composer 标签除外，它们返回 `{ update, remove }` 句柄。保留插件在销毁之前调用的所有移除函数；入口的清理函数运行后，Paseo 会移除尚未移除的注册。

### 0.13 的面板属性 {#panel-props-in-013}

所有面板类型共享 [params、revision 和持久化的标签页状态](./reference.md#workspace-panels)。

| 旧 API                                                                        | 替代方式                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| 工作区/Agent 面板的 `context` 属性                                            | 在注册时选择面板类型。                           |
| Agent 面板的 `agentId` 属性                                                   | `params.agentId`                                 |
| `addWorkspacePanel({ context: "workspace", ... })`                            | `addWorkspacePanel({ ... })`                     |
| `addWorkspacePanel({ context: "agent", ... })`                                | `addAgentPanel({ ... })`                         |
| Beta 文件面板的 `location.lineStart`、`location.lineEnd`、`location.revision` | `params.lineStart`、`params.lineEnd`、`revision` |
| Beta 的 `PluginFileTab`、`PluginFileLocation`                                 | `PluginTab`、`PluginFilePanelParams`             |

0.12 的别名会保留到 2027-04-23 之后移除。Beta 文件 API 直接替换。采用新 API 时，将
`requirements.paseo` 声明为 `>=0.13.0`。

### Composer 标签 {#composer-pills}

更新插件项目的 `@getpaseo/plugin` 依赖，然后运行 `npm run typecheck`。旧的贡献缺少必需的 `button` 字段，`PluginComposerPillProps` 不再导出，并且把新的注册当作函数调用会产生 TypeScript 错误。固定在旧 SDK 上的项目仍然按旧的契约检查；安装或重新加载插件并不会运行 TypeScript 的类型检查器。

把标签的 `Component` 替换为 `button.icon` 和 `button.label`，把 `title` 移入 `button`，把 `onPress` 移入 `button.behavior`。清理方式从调用返回的函数改为调用它的 `.remove()` 方法。

```tsx
const pill = client.addComposerPill({
  id: "review",
  workspaceId,
  agentId,
  button: {
    title: "Open review",
    icon: "Scan",
    label: "Review",
    behavior: { kind: "action", onPress: openReview },
  },
});

pill.update({ label: "Review · 3", visible: true });
// Client entry cleanup:
pill.remove();
```

把原组件中的动态文本改为由你的模型或 SDK 订阅发出更新。自定义图标组件仍然可以使用 hook。Composer 标签总是显示图标和文字，并且从不显示展开箭头。菜单、弹出框和可见性见[按钮](./reference.md#button-descriptor)。

## 4. 拆分导入 {#4-separate-imports}

把 hook（`usePaseo`、`useRpc`、`useSettings`、`useAgent`、`useWorkspace`）和客户端贡献类型从 `@getpaseo/plugin` 移到 `@getpaseo/plugin/client`。把 `Icon` 移到 `@getpaseo/plugin/client/ui`。从 `@getpaseo/plugin/server` 导入服务端 context 和生命周期契约。共享的辅助函数（`defineRpc`、`defineSettings`、`defineAttachmentSource`）、schema 和普通数据类型保留在根入口。这些规则同样适用于类型导入。完整的契约见[运行时模块](reference#runtime-modules)。

把其余的 SDK 子路径移到它们所属的运行时下：

| 旧入口                                 | 当前入口                           |
| -------------------------------------- | ---------------------------------- |
| `@getpaseo/plugin/react-native`        | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/client/react-native` | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/ui`                  | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/provider`            | `@getpaseo/plugin/server/provider` |
| `@getpaseo/plugin/acp`                 | `@getpaseo/plugin/server/acp`      |

0.8 之前的入口和旧的 `@paseo/plugin` scope 已被移除。`/client/host` 是 Paseo 应用集成的私有模块，插件作者从不导入它。

客户端入口只导入 `client/`、`shared/` 和可在客户端安全使用的包。服务端入口只导入 `server/`、`shared/` 和可在服务端安全使用的包。在客户端入口或从它可达的任何代码中导入 `node:` 模块都会导致编译错误。不要仅仅为了接线注册而把组件导入服务端入口；那项注册属于客户端入口。

### v0.13 中的 UI 导入 {#ui-imports-in-v013}

所有 Paseo UI 组件和 UI hook 都从 `/client/ui` 导入。之前的入口作为未写入文档的兼容别名保留到 2027-04-20。

对于逐步显示的时间线文本，把 `useRevealedText(text, phase)` 及其外层的 `Text` 换成 `/client/ui` 中的 `<StreamedText text={text} phase={phase} style={style} />`。插件设置的标题使用 `SettingsSection`；`SettingsGroup` 已弃用。

## 5. 识别只迁移了一半的错误 {#5-recognize-half-migration-errors}

| 编译器或加载错误                                                                                                           | 含义与修复方法                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `This plugin has no requirements.paseo`                                                                                    | 完成迁移，并按第 7 步声明版本范围。                                                                |
| `This plugin was made for an older version of Paseo`                                                                       | 目录中仍然只有旧的根入口。创建一个运行时入口，迁移注册，然后删除旧文件。                           |
| `Plugin entry points are missing: expected index.client.ts or index.client.tsx and/or index.server.ts or index.server.tsx` | 不存在受支持的入口。至少添加一个文件名完全匹配的入口。                                             |
| `server-only module cannot be imported into the plugin client bundle: <file>`                                              | 某个客户端导入触及了 `server/`。把这个调用移到 RPC 之后，并从 `shared/` 导入它的契约。             |
| `client-only module cannot be imported into the plugin server bundle: <file>`                                              | 某个服务端导入触及了 `client/`。把那项注册及其导入移到客户端入口。                                 |
| `Plugin modules belong in client/, server/, or shared/: <file>`                                                            | 某个代码模块仍在插件根目录。把它移到对应的目录并修复它的导入。                                     |
| `Node module cannot be imported into the plugin client bundle: node:<name> imported by <file>`                             | 客户端代码导入了 Node API。把该操作移到 `server/`，在 `shared/` 中暴露一个 RPC，并从客户端调用它。 |
| TypeScript 报告 `PluginContext`、`addClientSide` 或 `addClientSlashCommand` 不存在                                         | 按照上面的表格替换旧的 context 类型和注册。                                                        |

## 6. 完整示例：`plugin-examples/local-plugin` {#6-worked-example-plugin-exampleslocal-plugin}

只有入口文件和导入路径发生变化。组件和处理函数的函数体原样移动，无需编辑。

迁移前：

```text
local-plugin/
  index.ts
  main.client.tsx
  increment.server.ts
  increment.shared.ts
```

```ts
// index.ts
import type { PluginContext } from "@getpaseo/plugin";
import { contributeClient, ExamplePanel } from "./main.client";
import { increment } from "./increment.server";
import { incrementRpc } from "./increment.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(incrementRpc, increment);
  plugin.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExamplePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  plugin.addClientSide(contributeClient);
  return () => {};
}
```

迁移后：

```text
local-plugin/
  index.client.tsx
  index.server.ts
  client/main.tsx        # was main.client.tsx
  server/increment.ts    # was increment.server.ts
  shared/increment.ts    # was increment.shared.ts
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient, ExamplePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExamplePanel,
  });
  client.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  return contributeClient(client);
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { increment } from "./server/increment";
import { incrementRpc } from "./shared/increment";

export default function contribute(server: PluginServerContext) {
  server.handle(incrementRpc, increment);
  return () => {};
}
```

被移动文件中的导入路径变化：

```diff
 // client/main.tsx
-import { incrementRpc } from "./increment.shared";
+import { incrementRpc } from "../shared/increment";

 // server/increment.ts
-import { incrementRpc } from "./increment.shared";
+import { incrementRpc } from "../shared/increment";
```

`contributeClient` 原本就接收 `PluginClientContext` 并返回清理函数，因此客户端入口直接调用它并返回它的清理函数。如果插件的 `addClientSide` 回调还注册了标签或订阅，请保留那些代码；只去掉外层包装。

## 7. 声明 Paseo 版本要求 {#7-declare-the-paseo-requirement}

迁移完入口和导入后，在 `paseo-plugin.json` 中添加最低运行时版本：

```json
{
  "id": "my-plugin",
  "requirements": { "paseo": ">=0.8.0" }
}
```

保留你现有的 ID 和构建命令。缺少 `requirements.paseo` 表示 `<0.8.0`，因此即使文件已经移动，Paseo 0.8 及更高版本也会拒绝该插件。仅仅添加这个字段并不会迁移代码。请把本地的 `@getpaseo/plugin` 开发依赖更新到你的目标版本，并在类型检查之前重新安装依赖。

版本范围和预发布版本的语义见[版本要求](reference#requirements)。

## 8. 验证迁移 {#8-verify-the-migration}

运行：

```bash
npm run typecheck
paseo plugin reload <plugin-id>
paseo plugin ls
```

确认状态为 `running` 且没有错误。试用每一项贡献。对于带 RPC 的插件，调用客户端操作并验证服务端结果。对于只有客户端的插件，确认贡献在没有服务端进程的情况下也能加载。对任何保存下来的注册移除函数调用两次，验证第二次调用不产生任何效果。
