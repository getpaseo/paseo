---
title: 插件参考
description: 本地插件文件、客户端和服务端运行时、平台限制、贡献、RPC、生命周期、宿主环境和 CLI 命令。
nav: 参考
---

# 插件参考 {#plugin-reference}

从[插件快速上手](/docs/plugins)开始创建你的第一个插件。

要迁移已有的插件？请按照独立的[运行时入口迁移指南](/docs/plugins/migration)操作。

本地插件是安装到某个 Paseo daemon 中的目录来源。插件可以贡献：

- 为 Paseo 客户端添加 React Native 界面，以及侧边栏顶部和底部项；
- 作为工作区标签页打开的工作区面板和 Agent 面板；
- 用于查看或编辑匹配文件的[文件面板](#file-panels)；
- Command Center 中的全局、工作区和 Agent 操作；
- 消息 Composer 中的斜杠命令；
- 经过转换的、以及由 daemon 推送的 Agent 时间线行；
- **设置 → 外观** 中的浅色和深色主题；
- 在 daemon 旁运行、经过 schema 校验的 RPC 处理函数；
- 通过 TypeScript SDK 执行的普通 Paseo 操作；
- 消息 Composer 中可搜索的外部资源。

插件代码是受信任的，没有沙盒。客户端界面在 Paseo 应用中运行。后端贡献在一个子进程中运行，可以访问 daemon 所在的机器，包括它的文件、进程、凭据和网络。

## 项目文件 {#project-files}

`paseo plugin init /absolute/path/to/my-plugin` 会创建：

```text
my-plugin/
  paseo-plugin.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
  package.json
  tsconfig.json
```

必需的根 manifest 是 `paseo-plugin.json`：

```json
{
  "id": "my-plugin",
  "description": "Reviews changes before merge",
  "requirements": { "paseo": ">=0.8.0" }
}
```

| 字段           | 是否必填 | 行为                                                                                                       |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`           | 是       | 默认的安装 ID。                                                                                            |
| `name`         | 否       | 注册表和网站使用的非空显示名称；与安装 ID 无关。                                                           |
| `icon`         | 否       | 插件包内 PNG 文件的相对路径。                                                                              |
| `media`        | 否       | 包内图片或视频路径的数组，或 HTTPS URL。空数组是有效的。                                                   |
| `description`  | 否       | 在 **设置 → 插件** 中显示在插件 ID 下方的非空摘要。                                                        |
| `translations` | 否       | 其他语言的展示文本，由注册表读取，Paseo 会忽略它。见[其他语言](/docs/plugins/publishing#other-languages)。 |
| `requirements` | 否       | 支持的 Paseo 版本，见下文。                                                                                |
| `build`        | 否       | 准备命令，见 CLI 参考。                                                                                    |

路径相对于 `paseo-plugin.json`，使用正斜杠，并且不能包含 `..` 片段。即使 `media` 在运行时 manifest 中是可选的，可视化插件的注册表展示页仍然需要一张界面图片。接受的格式和展示页要求见[图标和截图](/docs/plugins/publishing#icons-and-screenshots)。Paseo 会校验这些引用，但不会打开本地资源或获取 URL。

未知的顶层字段会被忽略。已知字段仍然会被校验，`requirements` 中的未知键会被拒绝，以免拼写错误的约束悄悄跳过兼容性检查。使用 `name`、`icon` 或 `media` 的 manifest 需要 Paseo 0.11.0 或更高版本；较旧的 daemon 会在安装时拒绝这些字段。

### 版本要求 {#requirements}

`requirements` 是一个可选对象。它目前支持的键 `paseo` 接受一个 npm semver 范围。省略 `requirements.paseo` 表示 `<0.8.0`：即该插件早于第一个破坏性的插件版本。Paseo 0.8 及更高版本会拒绝它，并附上[迁移指南](migration)的链接。空字符串、无效的范围以及未知的 manifest 要求键都会被拒绝。

| 范围             | 兼容的版本                                           |
| ---------------- | ---------------------------------------------------- |
| `>=0.8.0`        | 0.8.0 及之后的版本，包括预发布版本和将来的破坏性版本 |
| `^0.8.0`         | 0.8.x 版本，包括预发布版本                           |
| `>=0.8.3 <0.9.0` | 0.8.3 到最后一个 0.8 补丁版本，包括预发布版本        |

预发布的 Paseo 版本也满足其稳定核心版本（`major.minor.patch`）所满足的范围，因此 `0.8.0-beta.1` 满足 `>=0.8.0`，但不满足 `<0.8.0`。

`>=0.12.0-beta.4` 这样的预发布最低版本也会通过稳定核心 `0.12.0` 接受 `0.12.0-beta.3`。若要排除同一核心的较早构建，请使用不同的稳定核心版本。

`paseo plugin init` 会写入 `>=` 加当前 CLI 版本，并为类型检查固定匹配的 SDK。采用更新的 API 时，请提高最低版本。当某个之后的版本不兼容时，请添加上限；只有下限并不能保证免受将来破坏性变更的影响。

daemon 会在安装、运行准备命令或加载插件之前检查自己的版本，并在启动、启用和重新加载时再次检查。被拒绝的更新会保留已安装的修订。每个已连接的应用在执行客户端代码之前会检查自己的版本，并在 **设置 → 插件** 中显示不兼容。兼容的 daemon 并不能让较旧的应用变得兼容。没有客户端入口的插件不要求已连接的应用匹配。

例如：`Plugin "review" requires Paseo >=0.8.0. Your daemon is 0.7.2.` 请使用兼容的插件修订，或更新提示中的运行时。0.8 之前的版本不理解这个 manifest 字段，也无法显示这条新的诊断信息。

### 运行时入口 {#runtime-entries}

| 入口               | 运行时                 | 接收                  | 何时需要                                         |
| ------------------ | ---------------------- | --------------------- | ------------------------------------------------ |
| `index.client.tsx` | Paseo 应用，每个客户端 | `PluginClientContext` | 插件有任何 UI、回调、主题或附件来源时            |
| `index.server.ts`  | daemon 子进程          | `PluginServerContext` | 插件贡献处理函数、钩子、设置持久化或 Provider 时 |

至少需要一个入口；两者都接受 `.ts` 或 `.tsx`。仍然只有旧 `index.ts` 的目录会加载失败，并指向[迁移指南](/docs/plugins/migration)。

插件、界面、侧边栏项、工作区面板、Command Center 项、附件来源和斜杠命令的 ID 以小写字母开头，只包含小写字母、数字或连字符。

生成的 `package.json` 把 `@getpaseo/plugin` 和其他宿主模块安装为开发依赖，用于本地类型检查和测试。它们的运行时实例由 Paseo 提供。使用者在添加插件时不会安装它们。

其他每个模块都位于以下三个目录之一。在其中嵌套没有问题；位于插件根目录的模块会导致编译错误。

| 目录      | 编译进         | 用于                                                |
| --------- | -------------- | --------------------------------------------------- |
| `client/` | 仅应用的包     | React、React Native、hook、样式、界面、面板和回调。 |
| `server/` | 仅 daemon 的包 | Node API、本地资源、凭据和 RPC 处理函数。           |
| `shared/` | 两者           | Zod RPC 契约以及两个运行时都会导入的普通值。        |

## 运行时翻译 {#runtime-translations}

**尚未发布的 API。** 发布插件前，请将 `requirements.paseo` 设置为首次包含这些 API 的版本。[翻译示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/translations) 暂用 `>=0.12.1`，实际引入版本尚未确定。

将 JSON 资源随客户端代码一起打包。必须提供英语（`en`）；其他语言使用规范语言标签，例如 `zh-CN`。资源由嵌套对象和字符串叶节点组成。其他语言可省略键，缺失时回退到英语。定义翻译时会拒绝未知键、无效资源、非规范语言标签，以及与英语不一致的插值占位符。

```ts
// client/messages.ts
import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
```

在插件的 `tsconfig.json` 中启用 `resolveJsonModule`。Paseo 在本地打包这些导入，不通过网络加载。资源对示例：

`client/locales/en.json`:

```json
{
  "title": "Workspace notes",
  "add": "Add note",
  "notes_one": "{{count}} note",
  "notes_other": "{{count}} notes"
}
```

`client/locales/zh-CN.json`:

```json
{
  "title": "工作区笔记",
  "add": "添加笔记",
  "notes_other": "{{count}} 条笔记"
}
```

在 React UI 中使用插件的 hook：

```tsx
import { useTranslation } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { messages } from "./messages";

function NoteCount({ count }: { count: number }) {
  const { t, locale } = useTranslation(messages);
  return <Text accessibilityLanguage={locale}>{t("notes", { count })}</Text>;
}
```

对于由宿主持续渲染的标签，使用 `messages.message(key, options?)`：

```tsx
client.addScreen({
  id: "notes",
  title: messages.message("title"),
  Component: Notes,
});
```

`PluginText` 为 `string | PluginMessage`。消息引用支持界面标题（包括标题函数）、设置与侧边栏标题、工作区与文件面板标题、Command Center 标题、斜杠命令描述与参数提示、按钮标题与标签、嵌套菜单标题、附件来源标题/选择器标题/搜索占位文本，以及主题名称。现有的字符串仍然有效。保持 ID、斜杠命令名称、图标、URL 和命令搜索关键词不变。

描述符类型保留现有的字符串默认值。为翻译描述符显式标注类型时，传入文本类型参数，例如 `PluginScreenContribution<PluginText>`。内联注册会自动推导类型。

回调中的临时文本使用 `client.i18n.t(messages, "add")`，它读取调用时的应用语言。`client.i18n.locale` 和 hook 的 `locale` 返回解析后的应用语言，即使某条消息回退到英语。不要将 `t` 的返回值用作持续注册的标签。

键由英语资源推导。`notes` 等复数基础键要求数字类型的 `count`；i18next 根据语言选择 `_zero`、`_one`、`_two`、`_few`、`_many` 或 `_other` 形式。命名插值使用 `{{name}}`，调用时传入 `{ name: value }`。TypeScript 将导入 JSON 的字符串值拓宽为 `string`，因此 JSON 插值名称在运行时检查；内联字面量资源还能推导必需的插值名称。`{{amount, number}}` 等 i18next 格式化语法使用解析后语言的 `Intl` 格式化器。

显式选择的应用语言优先于设备语言；“跟随系统”使用应用支持的语言解析规则。连接到同一 daemon 的不同应用各自保留语言设置。切换语言会更新已挂载的 UI 和宿主标签，不重新加载插件、不重置组件状态，也不替换 RPC/查询缓存。网页和原生的模态框与弹出层均收到相同的安装上下文。

RPC 返回与语言无关的结构化数据，在客户端翻译呈现内容。保持用户草稿、agent 输出、原始 daemon 错误、日志与终端文本不变。manifest 列表翻译和 `OVERVIEW.<locale>.md` 是独立的发布元数据，参见[你的列表页面](publishing#your-listing-page)。

## 运行时模块 {#runtime-modules}

Paseo 从对应的入口构建每个包。把 `client/` 导入 daemon 的包、把 `server/` 导入应用的包，或在应用的包中任何位置导入 Node 模块，都会导致编译错误。服务端导入 React、React Native 或客户端 SDK 入口也会失败。共享代码只能导入共享代码：不能导入 Node、React、特定运行时的 SDK 入口或特定运行时的类型。

SDK 根入口（`@getpaseo/plugin`）只包含共享数据、schema 和与运行时无关的辅助函数。从 `/client` 导入客户端 context 和 hook，从 `/server` 导入服务端 context 和生命周期契约，从 `/client/ui` 导入 UI。这些规则同样适用于类型导入和传递依赖。`/client/host` 是应用宿主的私有模块；插件不能导入它。

### 客户端运行时 {#client-runtime}

Paseo 为客户端代码提供以下模块：

| 模块                         | 用于                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `@getpaseo/plugin`           | 共享数据、`defineRpc`、`defineSettings`、`defineAttachmentSource`、`RpcInput` 和 `RpcOutput` |
| `@getpaseo/plugin/client/ui` | Paseo UI 组件和 UI hook                                                                      |
| `@getpaseo/plugin/client`    | 客户端贡献 context、`usePaseo`、`useRpc`、`useSettings` 和数据 hook                          |
| `@tanstack/react-query`      | 请求状态和缓存                                                                               |
| `react`                      | 组件和 hook                                                                                  |
| `react/jsx-runtime`          | 编译后的 JSX                                                                                 |
| `react-native`               | 跨平台 UI                                                                                    |
| `zod`                        | 共享 schema                                                                                  |

宿主拥有与之配套的 React 和渲染器版本。SDK 的 React peer 范围允许补丁版本差异，以便工具链和 Node 使用者使用；它不会改变应用固定的 React 版本，也不保证与其他宿主的渲染器兼容。

这些确切的模块标识符使用宿主的运行时实例。请求其他宿主模块的客户端包会以 `Module "<name>" is not available in plugin client code` 失败。

不要导入 `lucide-react-native`、`react-native-svg` 或 DOM 库。把贡献的 `icon` 字段设为一个 [Lucide 图标名称](https://lucide.dev/icons/)、内联 SVG 或组件；Paseo 会校验图标并渲染它。参见[图标](#icons)。

### 跨平台规则 {#cross-platform-rules}

客户端代码通过 React Native Web 在 iOS、Android 和浏览器中运行。在浏览器中正常、在手机上崩溃的组件是最常见的插件 bug。规则如下：

| 应该                                                                            | 不应该                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 使用 `react-native` 中的 `View`、`Text`、`Pressable`、`ScrollView`、`TextInput` | 使用 `<div>`、`<span>`、`<button>` 或任何 HTML 元素                        |
| 使用由 `theme.colors` 和 `layout.compact` 构建的 `style` 对象                   | 使用 `className`、CSS 字符串或写死的颜色                                   |
| 使用 `onPress`                                                                  | 使用 `onClick`、`onMouseEnter` 或其他 DOM 处理函数                         |
| 使用 `Linking`、`Clipboard` 之类的 React Native API                             | 在组件中使用 `window`、`document`、`localStorage`、`navigator`、`location` |

脚手架的 `tsconfig.json` 省略了 DOM 库。请让跨平台组件远离 DOM 全局对象；不要添加 `/// <reference lib="dom" />`，也不要在 `lib` 中加入 `"DOM"`。`layout.platform` 携带与 React Native 的 `Platform.OS` 相同的值，用于渲染决策。

### 播放音频 {#play-audio}

调用 `client.playAudio({ base64, mimeType }): Promise<void>` 在当前客户端（浏览器、Electron、iOS 或 Android）上播放音频文件。传入插件 RPC 返回的 base64 文件即可；不需要浏览器全局对象或平台检查。

```ts
const audio = await client.rpc(renderSpeech, { text: "Your agent needs you" });
// renderSpeech returns { base64: string, mimeType: "audio/wav" }.
await client.playAudio(audio);
```

promise 在播放结束时 resolve，在文件无效、播放失败或插件卸载时 reject。调用共享 Paseo 的语音播放队列，并按顺序播放。卸载插件会取消它正在播放和排队中的音频。语音播放控件也可以中断这个共享队列。播放不会请求麦克风权限。

为了可移植性，请使用 PCM WAV 或 MP3 文件。其他编解码格式取决于客户端的解码器。接受 MIME 参数。请传入完整的音频文件；不支持原始 PCM 采样。浏览器要求用户交互后才允许播放声音；请处理 reject 并提供一个播放按钮。该函数在运行插件客户端的设备上播放，而不是在 daemon 上，并且不保证应用被挂起或关闭时仍能播放。

### 外部链接和工作区浏览器 {#external-links-and-workspace-browsers}

使用 `ExternalLink` 在 Paseo 之外打开文档：

```tsx
import { ExternalLink } from "@getpaseo/plugin/client/ui";

export function DocumentationLink() {
  return <ExternalLink href="https://paseo.sh/docs">Open documentation</ExternalLink>;
}
```

该组件具有无障碍的链接语义，并使用与 `openExternalUrl(url: string): Promise<void>` 相同的打开方式：

```ts
import { openExternalUrl } from "@getpaseo/plugin/client";

export async function openDocumentation() {
  await openExternalUrl("https://paseo.sh/docs");
}
```

请直接在用户交互中调用该函数，以便浏览器允许打开新标签页。

| 平台          | 外部链接                            | `navigation.openBrowser`             |
| ------------- | ----------------------------------- | ------------------------------------ |
| Electron      | 系统浏览器                          | 可用；创建一个本地工作区浏览器标签页 |
| 浏览器 Web    | 带 `noopener,noreferrer` 的新标签页 | `undefined`                          |
| iOS / Android | 操作系统的 URL 处理程序             | `undefined`                          |

#### ExternalLink 属性 {#externallink-props}

| 属性                            | 是否必填 | 行为 / 默认值                      |
| ------------------------------- | -------- | ---------------------------------- |
| `href: string`                  | 是       | 绝对的 HTTP(S) 目标地址            |
| `children: ReactNode`           | 是       | 链接文本或内联的 React Native 内容 |
| `accessibilityLabel: string`    | 否       | 覆盖从内容推导出的无障碍名称       |
| `testID: string`                | 否       | 测试标识符；默认不设置             |
| `onError(error: unknown): void` | 否       | 接收打开时的错误；默认记录到日志   |

#### 打开工作区浏览器 {#open-a-workspace-browser}

在界面或面板中使用 `navigation.openBrowser`。渲染该操作之前先检查它是否可用。下面这个工作区面板在其他平台上改用外部链接：

```tsx
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "react-native";

export function DocumentationPanel({ navigation, workspaceId, theme }: PluginWorkspacePanelProps) {
  const openBrowser = navigation?.openBrowser;
  const url = "https://paseo.sh/docs";

  if (!openBrowser) {
    return <ExternalLink href={url}>Open documentation</ExternalLink>;
  }

  return (
    <Pressable accessibilityRole="button" onPress={() => openBrowser({ url, workspaceId })}>
      <Text style={{ color: theme.colors.foreground }}>Open in workspace browser</Text>
    </Pressable>
  );
}
```

`navigation.openBrowser({ url, workspaceId, serverId? }): void` 会创建并聚焦一个新标签页。它从不会自动退回到外部打开。

| 选项                  | 是否必填 | 行为 / 默认值                            |
| --------------------- | -------- | ---------------------------------------- |
| `url: string`         | 是       | 绝对的 HTTP(S) 目标地址                  |
| `workspaceId: string` | 是       | 已存在于目标主机应用工作区列表中的工作区 |
| `serverId: string`    | 否       | 默认为界面或面板所选的主机               |

要以另一台主机为目标，请传入它的 ID 以及该主机的工作区 ID：

```ts
openBrowser({ url, workspaceId: remoteWorkspaceId, serverId: remoteServerId });
```

`serverId` 选择工作区的所有者。页面运行在你本地的桌面上，即使是远程工作区也是如此；`localhost` URL 指的是该桌面。

#### 错误与拒绝 {#errors-and-refusal}

| 条件                                             | 结果                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| 外部 URL 格式错误或使用非 HTTP(S) 协议           | 被忽略；`openExternalUrl` resolve，但不会打开任何内容                  |
| 操作系统打开失败                                 | `openExternalUrl` reject；`ExternalLink` 调用 `onError` 或记录错误     |
| 浏览器拦截了新的外部标签页                       | 无法与成功的 `noopener` 打开区分                                       |
| 应用内浏览器的 URL 格式错误或使用非 HTTP(S) 协议 | 在创建标签页之前抛出 `Only absolute HTTP(S) URLs are supported.`       |
| 应用内浏览器的工作区 ID 为空                     | 在创建标签页之前抛出 `workspaceId is required.`                        |
| 目标主机/工作区未知，或其工作区列表尚未加载      | 在创建标签页之前抛出 `Workspace is unavailable on the requested host.` |

跨客户端的、带类型的主机范围持久化请使用[设置 API](#settings-screens)。打开你自己注册的贡献请使用 `openSettings`、`openScreen` 和 `openPanel`。

### 服务端运行时 {#server-runtime}

Paseo 为服务端代码提供 `@getpaseo/plugin`、`@getpaseo/plugin/server`、`@getpaseo/plugin/server/provider`、`@getpaseo/plugin/server/acp` 和 `zod`。后端贡献在 daemon 子进程中运行，可以通过 Node 访问宿主机器。请把文件系统、进程、凭据以及其他本机工作放在 `server/` 下。没有 `index.server.ts` 的插件不会启动子进程。

### Provider {#providers}

直接实现和 ACP 实现、会话生命周期、Composer 设置、时间线渲染器、测试和分发，见[构建 Provider 插件](/docs/plugins/providers)。

使用来自 `@getpaseo/plugin/server/provider` 的 `ProviderRegistration` 调用 `server.registerProvider()`。它的连接通过 `send()` 接收输入，并通过 `onEvent()` 发出完整的状态快照。`send()` 只报告是否接受；提示词的处理结果、轮次、配置、持久化、权限和失败都是事件。

消息、结构化命令、引导和命令副作用都使用同一个 `session.prompt` 输入。在实时的用户时间线条目上重复 `clientMessageId`，并恰好发布一个与之匹配的 `session.prompt_result`。把 Provider 创建的子会话发布为带有 `parentSessionId` 的会话。

Provider 设置是 Paseo 在 Composer 中渲染的开关/选择描述符。把 Provider 私有的选项保留在 `session.open` 的 `ProviderSessionConfig.providerOptions` 中。这个记录包含配置的默认值和针对单个 Agent 的覆盖值；请在你的 Provider 中校验并应用它。配置和合并语义见 [Provider 选项](/docs/sdk/provider-options)。宿主工具以 MCP 服务器的形式出现在完整的会话配置中。

Paseo 刷新 Agent 的方式是关闭它当前的 Provider 会话，再用当前的配置和持久化值打开它。Provider 在 `session.open` 期间重新读取外部状态。

使用 `@getpaseo/plugin/server/acp` 中的 `runAcpProvider()` 适配一个基于命令的 ACP。只针对厂商在发现、配置、通知或工具调用方面的差异添加转换器钩子。

`ProviderRegistration.icon` 是相对于插件目录的文件路径，例如 `icon.svg`。它必须解析到该目录内一个遵循 [SVG 图标规则](#svg-rules)的普通文件。Paseo 在插件启动时读取并校验该文件；这个字符串从不是内联 SVG 或 URL。

### 用量来源 {#usage-sources}

**需要 Paseo 0.11**。在服务端入口中用 `server.registerUsageSource()` 注册一个来源。从 `@getpaseo/plugin/server/usage` 导入它的契约和辅助函数。

一个来源实现两个调用：

```ts
interface UsageAccount {
  key: string;
  label?: string;
  harness?: string;
  input: JsonValue;
}

type UsageScope =
  | { kind: "global" }
  | { kind: "session"; provider: string; model?: string; env: Record<string, string> };

interface UsageSourceRegistration {
  id: string;
  label: string;
  icon?: string;
  input: ZodType;
  discover(scope: UsageScope): Promise<UsageAccount[]>;
  fetch(input: unknown): Promise<UsageReport>;
}

type UsageReport =
  | {
      status: "available";
      planLabel?: string;
      windows: UsageWindow[];
      balances?: UsageBalance[];
      details?: UsageDetail[];
    }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string };

type UsageProblem =
  | { kind: "expired"; expiresAt: string; refreshedBy?: string }
  | { kind: "rejected"; status: number; refreshedBy?: string }
  | { kind: "no_quota"; detail: string };
```

会话发现只返回该 Agent 运行时使用的那个登录。Agent 弹出框只使用这些输入；它从不尝试来自全局发现或其他 Agent 的登录。对于其他任何 Provider，返回 `[]`。全局发现会列出每个账号，包括已过期的登录。

从会话的启动环境中解析会话账号。没有登录时返回 `[]`。不要在会话发现中扫描默认存储，也不要在全局发现中扫描 Agent。发现是一种查询，没有 Agent 生命周期钩子。已关闭的 Agent 在恢复之前没有会话范围。

输入指定凭据存储的位置；不要把凭据放进输入或报告中。Paseo 在调用 `fetch()` 之前会按你的 schema 校验每个输入。在任何范围内，相同的键就是同一份报告；只有当有序的登录输入一致时，获取才会共享五分钟的缓存。每次登录获取有 20 秒的截止时间。

内置的会话路由：

| 来源         | 会话                                           | 登录存储                                                                     |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude       | `claude`                                       | `CLAUDE_CONFIG_DIR` 或默认位置；在 macOS 上，该目录对应的钥匙串条目优先      |
| Claude       | 使用 `anthropic/…` 模型的 `pi`、`omp`          | 该运行环境的 Anthropic 登录存储                                              |
| Codex        | `codex`                                        | `CODEX_HOME/auth.json` 或默认位置                                            |
| Codex        | 使用 `openai/…` 模型的 `pi`、`opencode`、`omp` | 该运行环境的 OpenAI 登录存储                                                 |
| Cursor       | `cursor`                                       | 该会话的 `XDG_CONFIG_HOME`、`APPDATA` 或主目录下 cursor-agent 的 `auth.json` |
| Muse         | `muse`                                         | 该会话自己的 Muse 启动配置                                                   |
| 其他内置来源 | 任意                                           | 无会话发现                                                                   |

Claude 会排除 Bedrock、Vertex 以及使用其他 `ANTHROPIC_BASE_URL` 的会话。Codex 会排除设置了 `OPENAI_BASE_URL` 的会话。Cursor 会排除通过 `CURSOR_API_KEY` 或 `CURSOR_AUTH_TOKEN` 验证的会话，以及在 macOS 上把登录保存在钥匙串中的会话（除非设置了 `AGENT_CLI_CREDENTIAL_STORE=file`，否则这是默认行为）。

使用稳定的账号键：由 `[A-Za-z0-9._-]` 中的字符组成，长度为 1–128。它标识被计量配额的账号或组织，并且在 token 轮换后保持不变。不要把凭据或原始邮箱地址用作键。对于敏感的稳定身份，请使用 `hashAccountKey()`；当账号元数据不可用时，使用存储位置标识。标签可以为账号命名，但不会成为账号的身份。

按优先顺序返回登录，并把 `harness` 设为所属运行环境的显示名称，例如 Codex、OpenCode、Pi 或 OMP。daemon 把输入视为不透明的值，从不从中推导标签。

主机范围的 Usage 弹窗会把键相同的登录归为一张账号卡片，并发尝试它们，在选择结果时优先考虑发现的顺序。如果任一登录返回 `available`，就显示用量且没有错误。如果全部失败，就把每个登录的错误分行显示，并附上它的运行环境标签和各自的解决方法。发现失败会由 daemon 记录到日志，并且不会产生卡片。

时间窗口的名称必须来自 Provider 的数据：显式的时长、具名的 API 字段（例如 `five_hour` 或 `weekly`），或 Provider 自己的周期名称。响应中的位置和重置倒计时并不能确定时长。当 Provider 省略时长时，请使用 “Rolling” 或 “Primary limit” 之类的中性名称，并在适配器旁说明缺失的元数据。

对于数值形式的时长，请使用 `@getpaseo/plugin/server/usage` 中的 `windowFromReportedDuration()`（Paseo 0.11+）。传入报告的秒数或 `null`、一个中性的 `unknown` 标识和名称，以及可选的稳定配额 `scope`。该辅助函数会一并推导出 ID、标签和短标签；它不接受对时长标签的覆盖。对于具名的 API 周期，请使用 `windowFromUsedPct()`，并采用该字段所支持的名称。

窗口 ID 标识的是配额范围和周期，而不是它在响应中的位置、使用率或重置时刻。对于特定于模型的配额，请以 Provider 稳定的功能 ID 作为范围；没有 ID 时退回到报告的限额名称。在位置移动和显示名称变化时保持 ID 不变。不要把旧的、有歧义的 ID 映射到另一个周期：已保存的固定项会在所有账号中按来源和窗口 ID 匹配，因此用户必须重新选择修正后的窗口。

在用户自定义固定项之前，`summary: true` 会选择来源的默认值。应用会为卡片、侧边栏和开关计算出同一个生效的选择。第一次编辑会把这些默认值保存为快照；显式的空选择会保持为空。

请在 `fetch()` 中重新读取所选的存储，让 CLI 的 token 轮换生效。不要兑换 refresh token，也不要写入凭据存储：在别处刷新可能会使 CLI 的副本失效，而重写解析过的文件可能会丢弃你没有建模的字段。如果存储在发现之后消失了，请抛出错误；卡片会显示该错误，直到下一次发现将其移除。

使用 `unavailable(problem)` 说明为什么某个已有的登录无法提供配额。它需要一个 problem；没有不带参数的形式。`expiresAt` 是 ISO 时间戳。被拒绝的登录会携带上游的 HTTP 状态码。`refreshedBy` 是一个 CLI 名称，例如 `claude`、`codex`、`opencode`、`omp` 或 `pi`。解决方法的句子由 Paseo 负责。不要在该字段中放入说明或面向用户的句子。对于 `no_quota`，`detail` 会原样显示。

```ts
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hashAccountKey, unavailable } from "@getpaseo/plugin/server/usage";
import { findLoginStores, readLogin, readQuota } from "./server/logins";

const input = z.object({ path: z.string() }).strict();

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "example-usage",
    label: "Example",
    icon: "icon.svg",
    input,
    discover: async () =>
      (await findLoginStores()).map((path) => ({
        key: hashAccountKey(path),
        input: { path },
      })),
    fetch: async (value) => {
      const { path } = input.parse(value);
      const login = await readLogin(path);
      if (login.expiresAt <= Date.now())
        return unavailable({
          kind: "expired",
          expiresAt: new Date(login.expiresAt).toISOString(),
          refreshedBy: "example",
        });
      return readQuota(login);
    },
  });
  return () => {};
}
```

内置的 Claude 发现优先使用 macOS 钥匙串中的登录，只有当钥匙串为空时才使用 Claude Code 的凭据文件。`CLAUDE_CONFIG_DIR` 选择该文件所在的目录。新的 token 使用 OAuth 资料中的账号和组织 ID；已过期或被拒绝的资料使用存储位置的哈希。Codex 依次优先使用 Codex CLI、OpenCode、Pi 和 OMP，并按保存的元数据或 JWT 声明中的 ChatGPT 账号 ID 分组。Pi 和 OMP 的登录在过期后仍可被发现。OMP 需要 `node:sqlite`。

不带 ID 调用 `usage.list_reports` 时会发现账号。带 ID 调用时，它会刷新已知的账号，而不重新发现身份。如果某个存储切换了账号，现有卡片会显示新登录的配额，直到下一次发现。报告会缓存五分钟；`forceRefresh` 会绕过缓存。条目携带 `id`、`account.label` 和 `fetchedAt`。失败的账号还会携带可选的 `loginErrors` 条目，其中包含 `harness` 和每个登录失败的 `report`。客户端通过 `server_info.features.usageSources` 判断是否启用此功能。较旧的 `provider.usage.list` RPC 会为 0.10 客户端映射同样的报告，并把问题渲染到它的 `error` 字符串中。

来源图标是一个文件路径，规则与 Provider 图标相同。

## 入口与清理 {#entry-point-and-cleanup}

每个存在的入口都默认导出一个贡献函数，并返回清理函数。客户端入口接收 `PluginClientContext`；服务端入口接收 `PluginServerContext`。客户端注册方法返回幂等的移除函数，但标题栏按钮和 Composer 标签除外，它们返回 `{ update, remove }` 句柄。入口的清理函数会在 Paseo 移除剩余的注册之前运行。

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Main } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "My plugin", Component: Main });
  return () => {};
}
```

清理函数可以是异步的。请释放插件创建的计时器、监听器、套接字和其他资源。在重新加载、停用、移除、断开连接或 daemon 关闭时，Paseo 还会移除注册、卸载界面、reject 待处理的 RPC、关闭插件的 daemon 会话并停止它的子进程。

## 生命周期钩子 {#lifecycle-hooks}

在 `index.server.ts` 中：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  server.on("agent.turn_ended", (event) => {
    console.log(event.agent.id, event.outcome);
  });

  return () => {};
}
```

| 注册                            | 回调接收                           | 返回                                                |
| ------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `server.on(name, callback)`     | `(event, { paseo, signal })`       | `void` 或 `Promise<void>`                           |
| `server.before(name, callback)` | `({ request }, { paseo, signal })` | 修改后的请求，或返回 `undefined` 保持不变；支持异步 |

只要插件处于启用状态，钩子就会在 daemon 上运行，即使没有应用连接。

### 修改配置并注入 MCP 服务器 {#change-configuration-and-inject-an-mcp-server}

在 `contribute(server)` 中添加这个回调。把占位 URL 替换为你的 MCP 端点。

```ts
server.before("agent.create", ({ request }) => {
  if (request.config.provider !== "codex") {
    return request;
  }

  return {
    ...request,
    config: {
      ...request.config,
      providerOptions: {
        ...request.config.providerOptions,
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
      mcpServers: {
        ...request.config.mcpServers,
        company: {
          type: "http",
          url: "https://tools.example.com/mcp",
        },
      },
    },
  };
});
```

| 输入                                        | 结果                |
| ------------------------------------------- | ------------------- |
| `providerOptions.sandbox_mode: "read-only"` | `"workspace-write"` |
| `providerOptions.web_search: "disabled"`    | 由展开运算保留      |
| 已有的 `mcpServers.search`                  | 由展开运算保留      |
| 已有的 `mcpServers.company`                 | 被替换为上面的条目  |

所选的 Provider 会校验 `providerOptions`，并且必须支持配置的 MCP 服务器。显式的 Codex 沙盒和批准选项会覆盖它的模式预设。

### 在每次打开会话时注入环境变量 {#inject-environment-variables-on-every-session-opening}

```ts
server.before("agent.session_open", ({ request }) => {
  return {
    ...request,
    env: {
      ...request.env,
      COMPANY_ENV: "development",
    },
  };
});
```

它会在创建、恢复、刷新和导入时运行。如果只想在创建时注入，请改为在 `agent.create` 回调中设置 `env`。

### 选择工作区隔离方式 {#choose-workspace-isolation}

```ts
server.before("workspace.create", ({ request }) => {
  if (request.source.kind !== "directory") {
    return request;
  }

  return {
    ...request,
    source: {
      kind: "worktree",
      cwd: request.source.path,
      action: "branch-off",
    },
  };
});
```

**结果**：显式的目录创建请求会变成 worktree 请求。已有的工作区以及目录查找/导入操作不受影响。

### 在轮次结束时发送后续消息 {#send-a-follow-up-when-a-turn-ends}

把 [server/inspect.ts](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts) 复制到你的插件中。该辅助文件从 `@getpaseo/protocol/agent-types` 导入类型；请把与插件 SDK 版本相同的 `@getpaseo/protocol` 加入开发依赖，并在加载插件之前安装它们。`latestOutputText` 会拼接最近一条用户消息之后的文本片段。

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { latestOutputText } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.on("agent.turn_ended", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 20 });
    const text = latestOutputText(page.entries.map(({ item }) => item));
    if (/out of credits/i.test(text)) {
      await agent.send("Try again.");
    }
  });

  return () => {};
}
```

```text
Turn ends: "out of credits"
  → plugin sends "Try again."
  → a new turn starts
```

该处理函数只获取最近 20 条时间线条目，不检查这一页之前的输出。插件需要更多历史时，请用 `cursor` 和 `direction` 继续翻页。

这会用现有的 SDK 发送一条新消息。持续匹配会不断发送后续消息；需要时请在插件中添加次数限制或延迟。附件和工具的效果不会被重放。

### 回应权限请求 {#answer-a-permission-request}

使用同一个[辅助文件](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts)中的 `shellCommand`：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.on("agent.permission_requested", async (event, context) => {
    const command = shellCommand(event.request);
    if (command === null) {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    if (/\brm\s+-rf\b/.test(command)) {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "deny", message: "Recursive deletion is blocked." },
      });
      return;
    }

    if (command.trim() === "git status") {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "allow" },
      });
    }
  });

  return () => {};
}
```

| 请求             | 结果                 |
| ---------------- | -------------------- |
| `rm -rf build`   | 拒绝                 |
| `git status`     | 批准                 |
| 其他命令或请求   | 保持待处理，留给用户 |
| 已经处理过的请求 | SDK 响应失败         |

这个正则表达式只是一个示例策略，而不是 shell 解析器。权限请求也可能是问题、计划和模式变更；请求权限不会结束当前轮次。

### 事件 {#events}

| 名称                         | 事件字段                                              | 触发时机                      |
| ---------------------------- | ----------------------------------------------------- | ----------------------------- |
| `agent.created`              | `agent`                                               | 普通创建完成；不包括导入/恢复 |
| `agent.closed`               | `agent`                                               | 一个运行中的 Agent 运行时关闭 |
| `agent.turn_started`         | `agent`, `turnId`                                     | 实时轮次开始                  |
| `agent.turn_ended`           | `agent`, `turnId`, `outcome`, 已弃用的 `timeline: []` | 实时轮次完成、失败或被取消    |
| `agent.permission_requested` | `agent`, `request`                                    | 权限请求或问题进入待处理状态  |
| `agent.permission_resolved`  | `agent`, `requestId`, `resolution`                    | 待处理的请求得到回应或被清除  |
| `agent.archived`             | `agent`, `archivedAt`                                 | 归档状态已保存                |
| `workspace.created`          | `workspace`                                           | 记录已创建；目录可用          |
| `workspace.archived`         | `workspace`                                           | 归档状态已保存                |

Agent 事件不包括 daemon 私有的一次性辅助 Agent。公开的后台工作区及其普通 Agent 与其他工作区运行相同的生命周期钩子。归档事件可能早于运行时/worktree 清理；当清理很重要时，请单独观察生命周期何时完成。

`agent.turn_ended.timeline` 已弃用，并且始终为空。需要历史时，请用 `context.paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 20 })` 按需获取。钩子负载的大小不会随对话历史增长。

**共享的负载结构**（`@getpaseo/plugin/server`）：

```ts
interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

| 字段         | 结构 / 含义                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| `turnId`     | Provider 报告的 `string` 或 `null`；会话重新打开后可能重复                               |
| `timeline`   | `readonly AgentTimelineItem[]`；包含之前对话的完整快照；文本可能跨越多个条目             |
| `request`    | SDK 的 `AgentPermissionRequest`；`kind` 为 `tool`、`plan`、`question`、`mode` 或 `other` |
| `resolution` | SDK 的 `AgentPermissionResponse`                                                         |
| `archivedAt` | 时间戳字符串                                                                             |

### before 钩子 {#before-hooks}

| 名称                 | 请求字段                                                                | 可编辑                              |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `agent.create`       | `config`，可选的 `env`                                                  | 除 `cwd` 外的公开 Agent 配置；`env` |
| `agent.session_open` | `agentId`, `workspaceId`, `provider`, `cwd`, `reason`, `purpose`, `env` | 仅 `env`                            |
| `workspace.create`   | `source`，可选的 `title`，`firstAgentContext`                           | 整个显式创建请求                    |

**`agent.create.config`** 使用 `AgentSessionConfig`：

| 字段                                          | 约束                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `provider`, `model`                           | 独立的字段；修改 Provider 可能需要同时修改模型/模式/选项 |
| `modeId`, `thinkingOptionId`, `featureValues` | 特定于 Provider 的选择                                   |
| `title`, `systemPrompt`                       | Agent 配置                                               |
| `providerOptions`                             | 不透明的、特定于 Provider 的选项                         |
| `mcpServers`, `toolPolicy`                    | MCP 配置和精确的工具预批准                               |
| `cwd`                                         | 不能修改                                                 |

**`agent.session_open` 请求示例：**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| 字段          | 取值                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| `workspaceId` | 字符串或 `null`                                                                      |
| `reason`      | `create`、`resume`、`refresh`、`import`                                              |
| `purpose`     | `interactive`、`history`                                                             |
| `env`         | 启动覆盖映射；不包括 daemon 继承的环境变量。替换整个映射即可添加、替换或移除覆盖项。 |

### 顺序与返回值 {#ordering-and-returned-values}

```text
Creation request
  → agent.create hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.session_open hooks (same ordering; env only)
  → set PASEO_AGENT_ID and PASEO_AGENT_CWD
  → open provider session and save agent configuration
```

| 回调返回                                                | 下一个回调收到                    |
| ------------------------------------------------------- | --------------------------------- |
| `{ ...request, env: { ...request.env, REGION: "eu" } }` | 之前的请求，添加或替换了 `REGION` |
| `{ ...request, env: { REGION: "eu" } }`                 | 之前的请求，整个覆盖映射被替换    |
| `undefined`                                             | 未改变的请求                      |
| 抛出错误或返回无效数据                                  | 操作失败；后面的回调不会运行      |

没有自动的深度合并。后面的回调可以覆盖前面的值。Agent 配置会被保存；环境变量覆盖项不会随之持久化。

### context 与清理 {#context-and-cleanup}

| 契约                       | 行为                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `context.paseo`            | 已连接到此 daemon 的现有 SDK                                                        |
| `context.signal`           | 在调用超时或插件停止时中止；请把它传给外部请求                                      |
| 输入数据                   | 分离的快照；通过返回的请求或 SDK 命令改变状态                                       |
| 注册结果                   | 幂等的移除函数，例如 `const remove = server.on(...); remove();`                     |
| 重新加载、停用、移除、关闭 | 移除剩余的注册                                                                      |
| 未知的钩子名称             | 注册失败                                                                            |
| 钩子超时                   | 30 秒；会中止 signal。before 钩子会让待处理的操作失败；事件处理函数会记录一条错误。 |
| 事件处理函数出错           | 记录在插件名下；原操作继续进行                                                      |
| 事件投递                   | 实时、尽力而为；没有重放、持久化或自动重试                                          |
| 事件并发                   | 不同的事件可能重叠；不保证回调完成的顺序                                            |

### 完整示例 {#complete-examples}

| 插件                                                                                                   | 包含                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | 全部十一个钩子；隐去环境变量值的 JSON 日志             |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | 后续消息、权限、环境变量、切换 Provider、选择 worktree |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP 注入以及 Codex 沙盒/批准选项                       |

用 `paseo plugin logs lifecycle-logger` 或主机的 `daemon.log` 读取 logger 的输出。

## 界面和侧边栏项 {#screens-and-sidebar-items}

界面是一整页的插件 UI。侧边栏项是 Paseo 在侧边栏顶部或底部渲染的组件；按下它时做什么由它决定。先注册界面，再注册一个打开它的项：

`client/main.tsx`：

```tsx
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function Main({ theme, host, layout }: PluginScreenProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{host.label}</Text>
      <Text style={styles.detail}>{layout.platform}</Text>
    </View>
  );
}
```

`index.client.tsx`：

```tsx
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Main } from "./client/main";

function MainItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Blocks"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "My plugin", Component: Main });
  client.addSidebarHeaderItem({ id: "main", title: "My plugin", Component: MainItem });
  return () => {};
}
```

`PluginScreenProps` 包含：

| 字段         | 含义                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`      | 当前 Paseo 主题的带类型 `PluginTheme` 颜色令牌。                                                                                                                                                                                                                                       |
| `host`       | 所选主机的 `id` 和显示用的 `label`。                                                                                                                                                                                                                                                   |
| `layout`     | `compact` 以及 `ios`、`android` 或 `web` 平台。                                                                                                                                                                                                                                        |
| `params`     | 打开界面时传入的参数，键和值都是字符串。没有参数时为 `{}`。                                                                                                                                                                                                                            |
| `navigation` | 可选的客户端导航。`openAgent({ agentId, serverId? })` 和 `openWorkspace({ workspaceId, serverId? })` 在 `serverId` 上打开目标，省略时在所选主机上打开。`openBrowser({ url, workspaceId, serverId? })` 仅在 Electron 上可用；见[链接和浏览器](#external-links-and-workspace-browsers)。 |

路由、标题栏、关闭操作、主机选择器、错误边界和 query client 由 Paseo 负责。界面主体由插件负责。

`addScreen({ id, title, Component })` 注册一个界面。`title` 是界面标题栏的[显示文本](#runtime-translations)，也可以是接收界面参数并返回显示文本的函数。参数或语言变化时，该函数会再次运行。无效标题和空字符串标题会被拒绝。如果标题函数抛出错误或解析为空字符串，会改为显示界面 ID；界面仍然会渲染。

`openScreen({ screenId, params })` 以参数打开一个界面，例如机器人界面要显示的那个机器人。参数保存在界面 URL 的查询字符串中，因此重新加载、前进后退以及指向该界面的链接都会保留它们。任何字符串键都可以；值必须是字符串，其他类型会抛出错误。用其他参数打开同一个界面会显示新的参数。

### 侧边栏项 {#sidebar-items}

`addSidebarHeaderItem` 在侧边栏顶部的列表中添加一行。`addSidebarFooterItem` 在底部添加一行，位于 **添加 project** 和底部图标行之间。图标行是固定的；插件不能向其中添加内容。两者都接受 `{ id, title, Component }`。`title` 是该项在 **设置 → 侧边栏** 中的标签（用户在那里重新排序和隐藏各项），也是 `SidebarRow` 的默认标签和无障碍标签。设置页面为这些项显示一个通用的插件图标；来自已弃用的 `addSidebarItem` 的行保留其注册时的图标。

当插件安装在多台主机上时，侧边栏项按应用当前显示的界面所属的主机渲染。不在任何主机的界面上时，它使用最近一次在该插件的某个界面中选择的主机，或最近一次从它的某个项打开的主机，否则使用第一台主机。

`Component` 接收 `PluginSidebarItemProps`：

| 字段                      | 含义                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `theme`, `host`, `layout` | 与 `PluginScreenProps` 中相同。                                                  |
| `currentScreen`           | 在该项所属主机上打开的、此插件的界面的 `{ screenId, params }`，没有时为 `null`。 |
| `openScreen(input)`       | 打开此插件的某个界面：`{ screenId, params? }`。未知的界面 ID 会抛出错误。        |
| `openPopover(Content)`    | 在宽布局中把 `Content` 锚定在被按下的行旁边打开，在紧凑布局中以底部面板打开。    |

`Content` 接收 `theme`、`host`、`layout`、`close()` 和 `openScreen(input)`。打开界面会关闭弹出框。

用 `@getpaseo/plugin/client/ui` 中的侧边栏组件渲染该项：

| 组件               | 属性与行为                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SidebarRow`       | 必填 `onPress`；可选 `icon`（任意一种[图标](#icons)形式）、`label`、`active`、`trailing`、`id`。占满整行宽度。`trailing` 渲染在行的可按区域旁边，因此其中的按钮可以单独按下；按下其中其他位置则相当于按下该行。`id` 用于在测试 ID 中区分同一项的多行。 |
| `SidebarSeparator` | 没有属性。侧边栏的分隔线，放在各组行之间。                                                                                                                                                                                                             |

弹出框锚定在被按下的那一行，无论按下的是行本身还是它的 `trailing` 内容，因此每行的“More”按钮会在它自己的行旁边打开弹出框。

```tsx
import type { PluginSidebarItemProps, PluginPopoverProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "react-native";

function SyncDetails({ theme, close, openScreen }: PluginPopoverProps) {
  return (
    <Pressable onPress={() => openScreen({ screenId: "sync" })}>
      <Text style={{ color: theme.colors.foreground }}>Open sync history</Text>
    </Pressable>
  );
}

function SyncItem({ openPopover }: PluginSidebarItemProps) {
  return <SidebarRow icon="RefreshCw" onPress={() => openPopover(SyncDetails)} />;
}

client.addSidebarFooterItem({ id: "sync", title: "Sync", Component: SyncItem });
```

抛出错误的项不会渲染任何内容；侧边栏的其余部分继续正常工作。

#### 一个项中的多行 {#several-rows-in-one-item}

项的 `Component` 可以返回 fragment、数组或 `null`，因此一个项可以渲染一个在运行时变化的列表。设置中只列出该项一次，它作为一个整体移动和隐藏。下面这个项为每个机器人显示一行，并以机器人 ID 作为参数打开该机器人的界面：

```tsx
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { botName, useBots } from "./client/bots";

function BotScreen({ theme, params }: PluginScreenProps) {
  return <Text style={{ color: theme.colors.foreground }}>Bot {params.botId}</Text>;
}

function BotsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const bots = useBots();
  const openBotId = currentScreen?.screenId === "bot" ? currentScreen.params.botId : null;
  return (
    <>
      <SidebarSeparator />
      {bots.map((bot) => (
        <SidebarRow
          key={bot.id}
          id={bot.id}
          icon="Bot"
          label={bot.name}
          active={bot.id === openBotId}
          onPress={() => openScreen({ screenId: "bot", params: { botId: bot.id } })}
        />
      ))}
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "bot",
    title: (params) => botName(params.botId) ?? "Bot",
    Component: BotScreen,
  });
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: BotsItem });
  return () => {};
}
```

#### 在运行时添加和移除项 {#add-and-remove-items-at-runtime}

`addSidebarHeaderItem` 和 `addSidebarFooterItem` 在入口返回之后仍然可用。它们各自返回一个移除函数；项会在不重新加载的情况下出现和消失：

```tsx
let removeAlerts: (() => void) | null = null;

function showAlerts(client: PluginClientContext) {
  removeAlerts ??= client.addSidebarFooterItem({
    id: "alerts",
    title: "Alerts",
    Component: AlertsItem,
  });
}

function hideAlerts() {
  removeAlerts?.();
  removeAlerts = null;
}
```

## 宿主 UI {#host-ui}

在客户端代码中从 `@getpaseo/plugin/client/ui` 导入由 Paseo 提供的 UI。下面的示例会打开一个受控的弹窗、渲染一个宿主图标，并用 toast 确认操作：

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function IssueActions({ theme }: PluginSurfaceProps) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  function saveIssue() {
    toast.show("Issue saved", { variant: "success" });
    setOpen(false);
  }

  return (
    <View>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Pencil" size={18} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground }}>Edit issue</Text>
        </View>
      </Pressable>

      <Modal
        title="Edit issue"
        icon={<Icon name="Pencil" size={18} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          <Pressable accessibilityRole="button" onPress={saveIssue}>
            <Text style={{ color: theme.colors.foreground }}>Save</Text>
          </Pressable>
        </Modal.Content>
      </Modal>
    </View>
  );
}
```

### Modal {#modal}

`Modal` 在紧凑布局中使用底部面板，否则使用居中的对话框。`open` 状态由插件负责。

| 属性           | 类型                      | 是否必填 | 行为                             |
| -------------- | ------------------------- | -------- | -------------------------------- |
| `title`        | `string`                  | 是       | 为弹窗及其可见的标题栏提供标签。 |
| `icon`         | `ReactNode`               | 否       | 渲染在标题栏中标题的前面。       |
| `open`         | `boolean`                 | 是       | 为 `true` 时显示弹窗内容。       |
| `onOpenChange` | `(open: boolean) => void` | 是       | 用户关闭弹窗时收到 `false`。     |
| `children`     | `ReactNode`               | 是       | 包含 `Modal.Content`。           |

`Modal.Content` 负责宿主渲染的标题栏下方的主体：

| 属性                    | 类型                   | 默认值             | 行为                                                                     |
| ----------------------- | ---------------------- | ------------------ | ------------------------------------------------------------------------ |
| `children`              | `ReactNode`            | 必填               | 标题栏下方的主体内容。                                                   |
| `style`                 | `StyleProp<ViewStyle>` | —                  | 为整个主体视口（包括空白区域）设置样式。用于背景。                       |
| `contentContainerStyle` | `StyleProp<ViewStyle>` | 内边距 24，间距 16 | 覆盖内容布局。要让行贴边显示，请设置 `padding: 0, gap: 0`。              |
| `scrollable`            | `boolean`              | `true`             | 由宿主滚动主体。如果主体高度受限并使用你自己的滚动容器，请设为 `false`。 |

普通的 `Modal.Content` 已经带有内边距并且可以滚动。除非你想要再缩进一层，否则不要再添加一个带内边距的包装。主体样式不会影响宿主的标题栏、拖动手柄和关闭控件。在紧凑的原生布局中，宿主会在底部预留安全区域空间；把内容的内边距设为零只会去掉装饰性的缩进，而不会去掉这部分空间。键盘的避让是单独处理的。

使用 `scrollable={false}` 时，主体会填满底部面板的可用高度，居中对话框则使用可用高度的 85%。请在你的列表上使用 `flex: 1, minHeight: 0`。默认可滚动的对话框在宽布局中保持与内容一样的大小。呈现方式取决于窗口尺寸，包括较窄的桌面窗口和较宽的平板。

关闭按钮、背景遮罩、平台的返回操作、Web 上的 Escape 键以及紧凑布局下底部面板的手势都会关闭弹窗。关闭时会调用 `onOpenChange(false)`；插件必须更新 `open` 才能关闭它。

弹窗的子元素保留插件的运行时 context。`usePaseo`、`useRpc`、`useWorkspace` 和 `useAgent` 在其中都可以使用。

### 滚动 {#scrolling}

当内容可能出现在 Paseo 弹窗中时，请从 `@getpaseo/plugin/client/ui` 导入 `ScrollView` 和 `FlatList`。它们接受 React Native 的属性和 ref，并与底部面板的手势集成。在底部面板之外，它们使用普通的 React Native 滚动。不要直接导入底部面板库。

只使用一个垂直滚动的所有者：要么是默认的弹窗主体，要么是你自己的、配合 `scrollable={false}` 使用的列表。在默认可滚动主体中嵌套一个固定高度的垂直列表，可能会在 Android 上与底部面板争夺手势。水平滚动可以与宿主的垂直主体共存。

默认主体和 SDK 列表都共享原生底部面板的手势：先向上拖动展开，再开始滚动；在列表顶部向下拖动会收起或关闭面板。`scrollable={false}` 会移除宿主的滚动容器，但不会改变这些手势。在使用 `scrollToEnd` 等列表方法之前，请先展开底部面板；在面板达到最大高度之前，它会锁定列表的偏移量。

```tsx
import { FlatList, Modal } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";

// Inside your controlled Modal:
<Modal.Content
  scrollable={false}
  style={{ backgroundColor: theme.colors.surface1 }}
  contentContainerStyle={{ padding: 0, gap: 0 }}
>
  <FlatList
    style={{ flex: 1, minHeight: 0 }}
    data={items}
    keyExtractor={(item) => item.id}
    renderItem={({ item }) => (
      <Text style={{ padding: 16, color: theme.colors.foreground }}>{item.title}</Text>
    )}
  />
</Modal.Content>;
```

对于水平标签页，请把 `<ScrollView horizontal style={{ flexGrow: 0 }}>…</ScrollView>` 放在默认的 `Modal.Content` 中。让内容的垂直滚动仍由宿主负责。

### 复制和粘贴 {#copy-and-paste}

`copyText(text): Promise<void>` 写入运行应用的设备的剪贴板。请在用户操作中调用它，并在报告成功之前 await 它。如果平台拒绝复制或剪贴板不可用，它会 reject；浏览器权限和安全上下文要求仍然适用。

```tsx
import { copyText, useToast } from "@getpaseo/plugin/client/ui";

// Inside your component:
const toast = useToast();
async function copyResult() {
  try {
    await copyText(result);
    toast.show("Copied", { variant: "success" });
  } catch {
    toast.error("Could not copy. Select the text and use Copy.");
  }
}
```

以编程方式复制和原生文本选择是两种不同的交互。使用 `<Text selectable>` 支持长按选择和系统的复制。弹窗表单请从 `@getpaseo/plugin/client/ui` 导入 `TextInput`。它接受 React Native 的输入属性和 ref，支持系统粘贴，并向原生底部面板注册焦点，以便键盘能把表单顶上来。在底部面板之外，它使用普通的输入框。普通的 React Native 输入框也支持粘贴，但不会向底部面板注册焦点；键盘可能会遮住它。系统粘贴不需要任何读取剪贴板的 API。不要在原生插件中使用 DOM 剪贴板代码，也不要使用 `react-native` 中已弃用的 `Clipboard` 导出。

可运行的[弹窗 UI 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/modal-ui)包含一个带内边距的表单、全宽的行、一个虚拟化列表、水平标签页和一个支持复制/粘贴的输入框。

### Toast {#toasts}

`useToast()` 返回两个方法：

| 方法                      | 行为                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `show(message, options?)` | 显示一个 toast，除非提供了 `durationMs`，否则持续 2,200 ms。 |
| `error(message)`          | 显示一个错误 toast，持续 3,200 ms。                          |

`show` 接受以下选项：

| 选项         | 类型                                                       | 默认值      |
| ------------ | ---------------------------------------------------------- | ----------- |
| `variant`    | `"default" \| "info" \| "success" \| "warning" \| "error"` | `"default"` |
| `durationMs` | `number`                                                   | `2200`      |

显示另一个 toast 会替换当前可见的 toast。空消息会被忽略。

### 图标 {#icons}

每个贡献的 `icon` 字段都接受以下三种形式之一，类型为 `@getpaseo/plugin/client` 中的 `PluginIcon`：

| 形式        | 示例                        | 适用场景                                        |
| ----------- | --------------------------- | ----------------------------------------------- |
| Lucide 名称 | `icon: "Scan"`              | 任意 [Lucide 图标](https://lucide.dev/icons/)。 |
| 内联 SVG    | `icon: { svg: reviewIcon }` | 品牌标志，或 Lucide 中没有的图标。              |
| 组件        | `icon: ReviewBadge`         | 随状态变化的图标，例如计数器。                  |

附件来源接受 Lucide 名称或内联 SVG（`PluginSerializableIcon`），因为每个附加的条目都会保存其来源的图标。

Paseo 在贡献注册时校验图标。未知的 Lucide 名称或违反规则的 SVG 会导致插件加载失败，并给出原因：

```text
Workspace panel review has an invalid icon: script elements are not allowed
```

Paseo 按界面的图标尺寸绘制内联 SVG，并把界面的图标颜色作为 `currentColor` 传入。用 `currentColor` 绘制即可跟随主题；固定的填充色会保持原样。

组件会收到 `PluginIconProps`，即 `{ size, color }`，并在该尺寸内渲染。头部按钮和 Composer 胶囊传入的是 [`PluginButtonIconProps`](#custom-icons-and-popover-content)。

#### SVG 规则 {#svg-rules}

内联 SVG、Provider 图标和用量来源图标遵循相同的规则：

- 只有一个 `<svg>` 文档，大小不超过 64 KiB。
- 不含 `<script>`、`<style>` 或 `<foreignObject>` 元素。
- 不含 `onclick` 这类事件处理属性，也不含 `javascript:` URL。
- `href` 和 `xlink:href` 只能指向同一文档中的片段，例如 `#mark`。

#### 提供 SVG 标记 {#ship-svg-markup}

把标记放在一个客户端模块中：

```ts
// client/icons.ts
export const reviewIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M4 4h16v16H4z" />
</svg>`;
```

或者把一个 `.svg` 文件放进 `client/` 并导入它。插件编译器会把文件的标记打包为字符串。声明一次该模块，让 TypeScript 接受这个导入：

```ts
// client/svg.d.ts
declare module "*.svg" {
  const markup: string;
  export default markup;
}
```

```ts
// index.client.tsx
import reviewIcon from "./client/review.svg";

client.addWorkspacePanel({ id: "review", title: "Review", icon: { svg: reviewIcon } /* … */ });
```

#### 渲染图标 {#render-an-icon}

`@getpaseo/plugin/client/ui` 中的 `Icon` 用于在你自己的 UI 中绘制图标。插件包不导入 `lucide-react-native` 或 `react-native-svg`。

| 属性    | 类型         | 是否必填                | 行为                                                       |
| ------- | ------------ | ----------------------- | ---------------------------------------------------------- |
| `name`  | `string`     | `name` 或 `icon` 二选一 | Lucide 图标名称。                                          |
| `icon`  | `PluginIcon` | `name` 或 `icon` 二选一 | 上文任意一种图标形式。                                     |
| `size`  | `number`     | 否                      | 图标的宽度和高度。默认为 24。                              |
| `color` | `string`     | 否                      | 图标颜色，也是 SVG 的 `currentColor`。请使用插件主题令牌。 |

未知的名称或违反规则的 SVG 不会渲染任何内容。

## 时间线条目 {#timeline-items}

插件可以用自己的数据和 React Native 渲染器替换 Agent 时间线中的条目。两项注册都是客户端贡献。Paseo 在构建渲染模型时应用转换器，包括每一次实时的流式更新。

```tsx
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { z } from "zod";

const schema = z.object({ label: z.string() });

function Card({ item, theme }: PluginTimelineItemProps<z.output<typeof schema>>) {
  return <Text style={{ color: theme.colors.foreground }}>{item.data.label}</Text>;
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "command-card",
    query: { itemType: "tool_call" },
    transform({ item, phase }) {
      return {
        items: [
          {
            type: "plugin",
            kind: "command-card",
            version: 1,
            data: { label: item.name, phase },
          },
        ],
      };
    },
  });
  client.addTimelineRenderer({
    kind: "command-card",
    version: 1,
    schema,
    Component: Card,
  });
  return () => {};
}
```

`query.itemType` 是稳定的、粗粒度的选择器。请在 `transform` 中检查所选的条目，以识别特定的 Provider 或工具。返回 `undefined` 会保留原条目。返回 `items` 会替换它；空数组会移除它。条目的 `data` 必须兼容 JSON。对于实时的助手消息、运行中的工具调用和加载中的推理，`phase` 输入为 `"streaming"`；对于已提交或已获取的消息以及已完成的工具或推理，它为 `"complete"`。助手和推理回调在每次更新时都会收到完整的累计文本，包括段落分隔符。Paseo 会在拆分原生 Markdown 或在 Overview 中对工具分组之前调用转换器。被认领的助手消息在整个流式过程中始终是同一个来源条目；如果最初的文本不足以识别它，请在可以识别之前返回 `undefined`。每个替换项都可以设置一个可选的、插件内部的 `id`；否则 Paseo 使用它在该来源条目输出中的索引。

渲染器接收 `agentId`、`item`、`timestamp`、`theme`、`host` 和 `layout`。Paseo 在渲染之前用注册的 schema 校验 `item.data`。请让转换器保持同步且确定。Paseo 按来源条目的引用缓存结果，并从来源行推导替换项的标识，因此对某个流式条目的更新不会重新挂载它的渲染器。要让纯文本像 Paseo 的助手行那样逐步显示，请渲染 `@getpaseo/plugin/client/ui` 中的 `<StreamedText text={item.data.text} phase={item.data.phase} />`。它接受 React Native `Text` 的属性（包括 `style`），默认使用助手消息的字体排版和前景色。完成后会立即显示全文；流式输出期间由宿主控制显示节奏。需要 Paseo 0.13 或更高版本。

当查询同时匹配原始消息时，聊天查找（Ctrl 或 Cmd+F）会在替换行中查找并高亮文本。宿主会在原始提示词文本或去掉 Markdown 语法的助手回复中搜索，然后由应用在你的渲染器绘制的文本中统计匹配。只由你的渲染器添加的文本不会被单独索引。匹配不会跨越渲染出的块，查找会跳过按钮、图标以及任何带有 `aria-hidden="true"` 的内容。查找只在 Web 和桌面应用中可用。

### 从 daemon 追加时间线行 {#append-a-timeline-row-from-the-daemon}

服务端处理函数可以向标准历史记录中添加一行由插件拥有的内容：

```ts
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

async function publishReview(agentId: string, { paseo }: PluginHandlerContext) {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: "review",
    kind: "review-result",
    version: 1,
    data: { verdict: "ready" },
  });
}
```

| 字段      | 类型       | 是否必填 | 行为                                         |
| --------- | ---------- | -------- | -------------------------------------------- |
| `type`    | `"plugin"` | 是       | 选择插件时间线变体。                         |
| `id`      | `string`   | 是       | 稳定的、插件内部的标识。复用它会替换旧的行。 |
| `kind`    | `string`   | 是       | 选择已注册的渲染器。                         |
| `version` | 正整数     | 是       | 选择渲染器契约的版本。                       |
| `data`    | 兼容 JSON  | 是       | 渲染器负载，JSON 序列化后最多 64 KiB。       |

daemon 会根据发起调用的插件会话写入 `pluginId`，并拒绝来自非插件会话的此 RPC。该行会实时出现，在时间线重新获取后依然保留，并且对于同一插件和 `id` 只保留最新的值。如果它的渲染器缺失，Paseo 会显示现有的“不可用”行。daemon 会拒绝超过限制的 `data`，而不是截断它。支持此操作的 daemon 会声明 `server_info.features.pluginTimelineItems`。

## 主题与布局 {#theme-and-layout}

插件 UI 运行在桌面、浏览器、iOS 和 Android 上，适用于每一个 Paseo 主题。`theme` 是由当前宿主主题映射而来的带类型 `PluginTheme`。颜色和间距必须来自这些属性。写死的颜色和没有样式的 `Text` 会在宿主主题变化时出问题。

当 `theme` 或 `layout.compact` 变化时，请重新创建样式。

| 键                              | 必须用于           | 用于                            |
| ------------------------------- | ------------------ | ------------------------------- |
| `theme.colors.foreground`       | 每个主要的 `Text`  | 标题和正文                      |
| `theme.colors.foregroundMuted`  | 次要的 `Text`      | 标签和辅助文字                  |
| `theme.colors.surface0`         | 根视图             | 面板背景                        |
| `theme.colors.surface1`         | 凸起的表面         | 卡片和面板                      |
| `theme.colors.surface2`         | 控件表面           | 输入框和次要控件                |
| `theme.colors.border`           | 表面边界           | 边框和分隔线                    |
| `theme.colors.accent`           | 主要操作的填充     | 按钮和选中状态                  |
| `theme.colors.accentForeground` | 强调色填充上的文字 | 按钮标签                        |
| `theme.colors.statusSuccess`    | 成功反馈           | 成功消息和指示器                |
| `theme.colors.statusWarning`    | 警告反馈           | 警告消息和指示器                |
| `theme.colors.statusDanger`     | 失败文字           | 错误消息和破坏性操作的文字      |
| `layout.compact`                | 内边距和堆叠       | 在移动端和较窄的窗口中为 `true` |
| `layout.platform`               | 特定于平台的行为   | `ios`、`android` 或 `web`       |

不要写死 `#000`、`#fff` 或 React Native 的默认文字颜色。主要文字使用 `foreground`。标签使用 `foregroundMuted`。当 `layout.compact` 为 true 时，收紧内边距。

工作区面板和 Agent 面板接收同样的 `theme`、`layout` 以及可选的 `navigation` 字段。

## 贡献主题 {#contribute-a-theme}

`addTheme` 向 **设置 → 外观** 添加一个浅色或深色主题，按其 `name` 列在内置主题之下。主题是数据，因此不需要组件文件：

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  client.addTheme({
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      border: "#45475a",
      accent: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  });
  return () => {};
}
```

每种颜色都是十六进制字符串；其他格式会导致加载失败。Paseo 会把调色板扩展为内置深色主题所使用的完整令牌集合，因此贡献的主题无需逐一列出，就能覆盖面板、菜单、diff、状态颜色和终端。

| 颜色              | 用作                                              |
| ----------------- | ------------------------------------------------- |
| `background`      | 应用、工作区和终端的背景                          |
| `foreground`      | 主要文字、终端前景色和光标                        |
| `raised`          | 卡片、弹出框和悬停的行                            |
| `control`         | 输入框、次要填充以及浅色主题的侧边栏              |
| `border`          | 边框以及最高层凸起表面的色调                      |
| `accent`          | 按钮、选中和焦点。可选；省略时使用 `foreground`。 |
| `mutedForeground` | 次要文字                                          |
| `ring`            | 焦点环、滚动条以及终端的亮黑色                    |

`appearance` 为 `"light"` 或 `"dark"`。Paseo 用它选择对应的表面、状态、diff、语法高亮、终端和阴影的推导方式。

同一时间只有一个贡献的主题处于启用状态。选择一个主题会保存这项选择；如果之后插件被停用或移除，Paseo 会退回到默认主题，而不会让应用失去配色。

主题需要一个支持它们的宿主。在 `addTheme` 之前发布的客户端无法执行该客户端入口，并会报告 `client.addTheme is not a function`。请更新客户端。

## 设置界面 {#settings-screens}

在 `index.client.tsx` 中用 `client.addSettingsScreen({ id, title, icon, Component })` 注册一个组件。它会出现在该主机的 **设置 → 插件 → 你的插件** 下。`id` 在同一次安装中唯一；`icon` 可以是任意一种[图标](#icons)形式。注册返回一个幂等的移除函数，插件销毁时会移除剩余的界面。

调用 `client.openSettings(id)` 或 Command Center 回调中的 `openSettings(id)` 可以打开你自己的某个界面。即使多台主机安装了同一个插件，每次安装也有各自的值和路由。

该组件接收 `PluginSurfaceProps`。标题栏、返回导航、安全区域、滚动以及居中的设置栏由 Paseo 负责。紧凑的窗口会推入一个全屏的详情页；较宽的窗口会保留设置侧边栏。请在这个框架内用 React Native 组件渲染内容。被停用或移除的插件会留下一个“不可用”界面，其返回导航仍然可用。

### 具名 UI 组件 {#named-ui-components}

从 `@getpaseo/plugin/client/ui` 导入设置组件。它们可以配合你自己的状态和 RPC 使用；不需要表单包装或存储绑定。

```tsx
import { useState } from "react";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";

export function DisplaySettings() {
  const [visible, setVisible] = useState(true);
  return (
    <SettingsSection title="Display">
      <SettingsCard>
        <SettingsSwitch label="Show metadata" value={visible} onValueChange={setVisible} />
      </SettingsCard>
    </SettingsSection>
  );
}
```

| 组件              | 属性与行为                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SettingsSection` | 必填 `title`、`children`；可选 `info` 提示、`trailing` 内容、`testID`。负责分区的间距和标题。                                |
| `SettingsCard`    | `children`，可选 `testID`。负责卡片表面以及直接子元素之间的分隔线。请为映射生成的行提供稳定的 React key。                    |
| `SettingsRow`     | 必填 `label`；可选 `hint`、`error`、`children`、`testID`。用于包裹任何自定义控件或内容。                                     |
| `SettingsSwitch`  | 行属性，外加必填的 `value: boolean`、`onValueChange`；可选 `disabled`。                                                      |
| `SettingsSelect`  | 行属性，外加必填的字符串 `value`、`options: { label, value }[]`、`onValueChange`；可选 `disabled`。使用 Paseo 的自适应菜单。 |
| `SettingsInput`   | 行属性，外加必填的 `onChangeText`；可选 `initialValue`、`placeholder`、`disabled`、`secureTextEntry`、`ref`。                |
| `SettingsAction`  | 行属性，外加必填的 `actionLabel`、`onPress`；可选 `disabled`。                                                               |

`SettingsInput` 负责正在编辑中的文本。`initialValue` 在挂载时为它提供初始值。它的 ref 提供 `focus()`、`blur()`、`getText()` 和 `replaceText(text)`，用于显式的编程式修改。在用户保存之前，请把草稿文本保留在持久化值之外。自定义的预览和控件可以放在这些组件旁边或内部。

### 持久化的值 {#persisted-values}

在 `shared/` 中定义一个设置文档：

```ts
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ showMetadata: z.boolean().default(true) }),
});
```

在 `index.server.ts` 中、返回清理函数之前注册它。返回的句柄让服务端代码可以读取该文档并响应变化。使用自己数据的界面可以只保留在客户端。

```ts
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);

  settings.subscribe((next) => {
    if (next.status === "ready") {
      console.log("Settings changed", next.revision);
    }
  });

  return () => {};
}
```

| 定义字段                       | 契约                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `id`                           | 匹配 `[a-z][a-z0-9_-]*` 的小写标识符；在同一次安装中唯一。                                    |
| `scope`                        | 必须为 `"host"`。该主机所有获得授权的客户端共享这份文档。没有按用户、设备本地或跨主机的同步。 |
| `version`                      | 必填的正整数，描述 schema 的版本，与写入修订号无关。                                          |
| `schema`                       | JSON 值的 Zod schema。请提供默认值，使解析 `{}` 能得到一份完整的文档。                        |
| `migrate(values, fromVersion)` | 可选的同步或异步函数，从较旧的存储版本转换。它的输出必须通过当前的 schema。                   |

在任何贡献的组件中调用 `useSettings(preferences)`。它返回一个可区分的状态：

| `status`  | 可用的数据                                     |
| --------- | ---------------------------------------------- |
| `loading` | 读取尚未完成；不要把默认值当作已保存的值渲染。 |
| `ready`   | 带类型的 `values` 和一个不透明的 `revision`。  |
| `invalid` | `error` 和 `revision`；存储的数据会被保留。    |
| `error`   | 读取或连接产生的 `error`。                     |

服务端句柄提供 `read()` 和 `subscribe()`。`read()` 返回与客户端 hook 相同的 `ready` 或
`invalid` 状态，包括不透明的修订号。`subscribe()` 返回一个清理函数，并在每次成功保存、重置或迁移之后
收到新的 `ready` 状态。无效的写入和修订冲突不会通知订阅者。监听器的失败只会被记录，不会把已提交的写入
变成保存失败。

```ts
const current = await settings.read();
if (current.status === "ready") {
  // Use current.values and current.revision.
}
```

每种状态还提供 `saving`、`saveError` 以及以下操作：

- `save(values, revision): Promise<boolean>` 校验并保存一份完整的文档。校验失败、冲突或传输失败时，
  它返回 `false` 并设置 `saveError`；它不会抛出错误。
- `reset(): Promise<boolean>` 使用 hook 加载的修订号，显式地把文档替换为 schema 默认值。它可以用来
  从无效的存储数据中恢复。
- `reload(): Promise<void>` 清除保存错误并重新读取。草稿由你的组件负责；重新加载不会自动丢弃这份草稿。

对于即时生效的开关，把 `{ ...settings.values, showMetadata }` 和 `settings.revision` 传给 `save`。
对于草稿编辑器，在打开时同时记下值和修订号。在保存成功或用户放弃草稿之前，一直保留这个修订号。过期的
修订号会让保存被拒绝，草稿和更新后的已保存值都会被保留。

写入是原子的，并在主机上校验。已连接的客户端无需重新加载插件就能收到更新。这些值在 daemon 重启、插件
重新加载、停用和更新之后依然保留。移除一次安装会删除它的设置。重新安装同一个 ID 会从默认值开始。

缺失的文档使用 schema 默认值。无效的数据、失败的迁移以及不受支持的更新版本会产生 `invalid`，而不会
悄悄重置文件。成功的迁移只会持久化一次新版本。这些文档是普通的主机端 JSON，而不是凭据保险库。
设置相关的 RPC 使用现有的 `daemon.manage` 权限来执行插件。

完整的[设置示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/settings)
包含即时生效的控件、带校验的草稿编辑器、自定义内容以及 Command Center 导航。

## 工作区面板 {#workspace-panels}

为工作区或 Agent 上下文注册一个面板：

`client/review.tsx`：

```tsx
import { type PluginAgentPanelProps, useAgent, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function ReviewPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const workspaceName = useWorkspace(workspaceId, (workspace) => workspace.name);
  const agent = useAgent(agentId, ({ id, title }) => ({ id, title }));
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{workspaceName}</Text>
      <Text style={styles.detail}>{agent?.title ?? agent?.id}</Text>
    </View>
  );
}
```

`index.client.tsx`：

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/review";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "Scan",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: ReviewPanel,
  });
  return () => {};
}
```

`addWorkspacePanel` 的字段：

| 字段        | 是否必填 | 含义                                                |
| ----------- | -------- | --------------------------------------------------- |
| `id`        | 是       | 插件内部的面板 ID。                                 |
| `title`     | 是       | 工作区标签页的标题。                                |
| `icon`      | 是       | Lucide 名称、`{ svg }` 或组件。参见[图标](#icons)。 |
| `context`   | 是       | `workspace` 或 `agent`。                            |
| `locations` | 否       | `workspace` 和/或 `explorer`。默认为 `workspace`。  |
| `Component` | 是       | 与所选上下文的属性相匹配的 React Native 组件。      |

工作区面板接收 `PluginWorkspacePanelProps`：`context: "workspace"`、`theme`、`host`、`layout` 和 `workspaceId`。Agent 面板接收 `PluginAgentPanelProps`：`context: "agent"`、相同的通用字段和 `workspaceId`，外加 `agentId`。

用 `useWorkspace(workspaceId, selector)` 和 `useAgent(agentId, selector)` 读取缓存的状态。selector 是必填的。Paseo 对它的结果做浅比较，因此选择 `{ name, status }` 时，无关字段的变化不会触发重新渲染。在一次调用中选择组件渲染的所有字段；不要选择整个快照。

当记录不可用时，两个 hook 都返回 `null`。否则它们会针对规范化的客户端状态同步运行。快照 DTO 及其嵌套值都是深度只读的，并在运行时被冻结。不要调用插件 RPC 来获取当前的工作区或 Agent。可选的或特定于厂商的补充数据，请在组件渲染之后再获取。

工作区快照字段：

| 字段                 | 类型                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `id`                 | `string`                                                          |
| `projectId`          | `string`                                                          |
| `projectDisplayName` | `string`                                                          |
| `projectRootPath`    | `string`                                                          |
| `directory`          | `string`                                                          |
| `projectKind`        | `"git" \| "non_git" \| "directory"`                               |
| `kind`               | `"directory" \| "local_checkout" \| "checkout" \| "worktree"`     |
| `name`               | `string`                                                          |
| `title`              | `string \| null`                                                  |
| `status`             | `"needs_input" \| "failed" \| "running" \| "attention" \| "done"` |
| `statusEnteredAt`    | ISO 时间戳或 `null`                                               |
| `archivingAt`        | ISO 时间戳或 `null`                                               |
| `diffStat`           | `{ additions: number; deletions: number } \| null`                |

Agent 快照字段：

| 字段                | 类型                                                           |
| ------------------- | -------------------------------------------------------------- |
| `id`                | `string`                                                       |
| `workspaceId`       | `string`                                                       |
| `provider`          | `string`                                                       |
| `status`            | `"initializing" \| "idle" \| "running" \| "error" \| "closed"` |
| `createdAt`         | ISO 时间戳                                                     |
| `updatedAt`         | ISO 时间戳                                                     |
| `lastActivityAt`    | ISO 时间戳                                                     |
| `title`             | `string \| null`                                               |
| `cwd`               | `string`                                                       |
| `model`             | `string \| null`                                               |
| `currentModeId`     | `string \| null`                                               |
| `thinkingOptionId`  | `string \| null`                                               |
| `requiresAttention` | `boolean`                                                      |
| `attentionReason`   | `"finished" \| "error" \| "permission" \| null`                |
| `parentAgentId`     | `string \| null`                                               |
| `labels`            | `Record<string, string>`                                       |

标签页的焦点、拆分、关闭、持久化、查询状态、API/RPC Provider 以及渲染错误边界都由 Paseo 负责。如果恢复的标签页所对应的插件、面板、上下文、工作区或 Agent 不可用，该标签页会保持打开并显示“不可用”消息，而不会让工作区崩溃。

## 文件面板 {#file-panels}

注册一个组件，把文件渲染为文件标签页的主体。组件会收到所选主机上该文件的句柄，远程主机也一样。由组件读取文件、显示自己的加载状态，并在用户编辑时写回文件。标签页栏会显示面板切换器、溢出菜单，以及在面板报告有未保存更改时显示一个圆点。

```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PdfPanel } from "./client/pdf-panel";

export default function contribute(client: PluginClientContext) {
  return client.addFilePanel({
    id: "pdf",
    title: "PDF",
    icon: "FileText",
    files: { extensions: ["pdf"] },
    Component: PdfPanel,
  });
}
```

`addFilePanel` 接收一个 `PluginFilePanelContribution`，并返回一个幂等的清理函数。客户端入口被卸载时，Paseo 也会移除该注册。

| 字段        | 必填 | 含义                                                                 |
| ----------- | ---- | -------------------------------------------------------------------- |
| `id`        | 是   | 插件内唯一的 ID，匹配 `^[a-z][a-z0-9-]*$`。                          |
| `title`     | 是   | 显示在面板切换器、选择器和 **打开方式…** 菜单中的非空标签。          |
| `icon`      | 是   | Lucide 名称、`{ svg }` 或组件。参见[图标](#icons)。                  |
| `files`     | 是   | `{ extensions: readonly string[]; filenames?: readonly string[] }`。 |
| `Component` | 是   | 接收 `PluginFilePanelProps` 的组件。                                 |

扩展名不带前导点，匹配时不区分大小写。文件名按完整的 basename 匹配，区分大小写。选择器不包含路径、glob 或通配符。只按文件名选择时，请使用 `extensions: []`。至少需要一个扩展名或文件名。

### 文件面板属性 {#file-panel-props}

`PluginFilePanelProps` 包含[主题和布局](#theme-and-layout)中介绍的通用属性 `theme`、`host`、`layout` 和可选的 `navigation`，另外还有：

| 属性          | 类型                 | 含义                                                               |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| `workspaceId` | `string`             | 包含该文件标签页的工作区。                                         |
| `file`        | `PluginFile`         | 文件的句柄。标签页显示该文件期间保持不变。                         |
| `tab`         | `PluginFileTab`      | `setModified(modified)` 会显示标签页的未保存圆点，并在关闭前确认。 |
| `location`    | `PluginFileLocation` | `lineStart?`、`lineEnd?` 和 `revision`，后者在每次导航时递增。     |

Paseo 在知道文件存在及其大小后就会挂载你的面板，不会先读取文件。`file` 对象保持不变，它的 stat 字段保存 Paseo 已知的最新版本。请在渲染时读取这些字段；它们变化时不会重新渲染你的面板。面板要通过 `watch` 监听器，或 `useFileText`、`useFileBytes`、`useFileUrl` 引起的重新渲染，得知它们已变化：

| 成员                             | 含义                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `path`、`name`、`extension`      | 主机上的绝对路径、basename，以及不带点的小写扩展名（没有时为 `""`）。         |
| `size`、`modifiedAt`、`mimeType` | 以字节计的大小、修改时间戳，以及主机报告的 MIME 类型。                        |
| `readText()`                     | 以 UTF-8 读取文件。字节顺序标记（BOM）会被去掉，并由 `writeText` 写回。       |
| `readBytes()`                    | 读取文件的字节。                                                              |
| `url()`                          | 当前字节的本地 `blob:`（Web）或 `file:`（原生）URL，供 `DocumentFrame` 使用。 |
| `writeText(text, options?)`      | 如果文件在磁盘上自该句柄上次读取或写入后没有变化，则以 UTF-8 写入文本。       |
| `writeBytes(bytes, options?)`    | 与上面相同，但写入字节。                                                      |
| `watch(listener)`                | 用 `PluginFileEvent` 调用 `listener(event)`；返回取消订阅函数。               |

`PluginFileEvent` 是 `{ type: "changed" }` 或 `{ type: "deleted" }`。请根据 `type` 分支处理；以后的版本可能会增加字段。文件被删除时，你的面板保持挂载。`watch` 会在一次读取确认文件已不存在后报告 `{ type: "deleted" }`，因此某个程序删除文件后又写回时，只会报告 `{ type: "changed" }`。被删除的文件重新出现时，会报告 `{ type: "changed" }`。

如果文件在该句柄上次读取或写入后在磁盘上发生了变化，写入会以 `PluginFileConflictError` reject。传入 `{ force: true }` 可以强制写入。文件已不存在时，无论是否传入 `force`，写入都会以 `PluginFileDeletedError` reject。句柄自己的写入不会通知它的监听器。`url()` 返回的 URL 由 Paseo 管理：在更新版本的 URL 解析完成或标签页关闭之前，它一直有效。不要用 `file.path` 拼接 daemon URL；daemon 在远程时，本地 URL 同样可用。

### 读取文件 {#read-the-file}

大多数面板通过 hook 读取文件。每个 hook 在挂载时读取，在文件于磁盘上变化时重新读取，并在重新读取期间保留当前值：

| Hook                 | 就绪状态                                 |
| -------------------- | ---------------------------------------- |
| `useFileText(file)`  | `{ status: "ready", text: string }`      |
| `useFileBytes(file)` | `{ status: "ready", bytes: Uint8Array }` |
| `useFileUrl(file)`   | `{ status: "ready", url: string }`       |

在第一次读取之前，每个 hook 还会返回 `{ status: "loading" }`；读取失败时返回 `{ status: "error", error }`。文件已删除时，`error` 是 `PluginFileDeletedError`。在内容显示到屏幕上之前，请显示 `@getpaseo/plugin/client/ui` 中的 `Loading`；它会填满面板，所以可以把它渲染在仍在布局的内容之上。

```tsx
import { type PluginFilePanelProps, useFileUrl } from "@getpaseo/plugin/client";
import { DocumentFrame, Loading } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";

export function PdfPanel({ file, theme }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  if (url.status === "loading") return <Loading />;
  if (url.status === "error") {
    return <Text style={{ color: theme.colors.statusDanger }}>{url.error.message}</Text>;
  }
  return <DocumentFrame url={url.url} testID="pdf-panel" />;
}
```

### 编辑文件 {#edit-the-file}

hook 的重新读取会采用磁盘上的版本，因此下一次写入会覆盖那里发生的任何变化。持有未保存编辑的面板应只用 `readText()` 读取一次，然后自己处理 `watch`：

1. 用 `file.readText()` 读取并显示文本。
2. 每次编辑时，调用 `tab.setModified(true)`，并以防抖方式用 `file.writeText(text)` 写入。
3. 写入完成且没有更新的编辑等待写入时，调用 `tab.setModified(false)`。
4. 收到 `{ type: "changed" }` 且没有未保存内容时，重新读取。有未保存的编辑时，显示冲突，让用户重新加载或用 `{ force: true }` 覆盖。
5. 遇到 `PluginFileConflictError` 时，显示同样的冲突。
6. 收到 `{ type: "deleted" }` 或遇到 `PluginFileDeletedError` 时，告诉用户文件已不存在。

请在组件卸载之前写入待保存的编辑：切换面板或关闭标签页都会卸载它。如果面板报告有未保存的更改，Paseo 会在关闭标签页之前询问。[Markdown 面板](https://github.com/getpaseo/paseo/tree/main/plugin-examples/markdown-panel)示例实现了这些步骤。

### 选择与打开方式 {#selection-and-open-with}

插件面板是其选择器匹配的每个文件的候选面板，无论是文本还是二进制文件。内置面板要求主机报告的文件类型：Markdown、HTML 和 **源代码** 打开文本文件，**图片** 打开图片。候选面板的顺序是：内置的 Markdown、HTML 和图片面板，然后按主机目录顺序排列的插件面板，最后是每个文本文件都有的 **源代码**。只有没有其他面板认领文件时，源代码才会默认打开它。

记住的关联在其面板于当前主机上可用时选择该面板。否则 Paseo 打开第一个候选面板。当插件面板是多个候选面板之一且没有适用的关联时，Paseo 每次打开标签页时询问一次，询问显示在它已经打开的面板上方。只有内置面板时从不询问：Markdown 文件用 Markdown 打开，并在切换器中提供源代码。安装了一个 Markdown 插件后，选择器会提供 **Markdown — Paseo**、**Rich Markdown — markdown-panel** 和 **源代码 — Paseo**。认领文本扩展名的插件会与源代码竞争，所以第一次打开时会询问；单独认领某个二进制文件的插件会直接打开，不询问。

**不再询问** 会在此设备上为该扩展名记住这个选择。当某个候选面板匹配了确切的文件名时，该选择改为应用于那个 basename。不可用的关联在该主机上会被忽略，并为安装了其面板的主机保留。

用户可以用栏中的面板切换器切换当前标签页：它并排显示最多三个面板（手机上为两个），更多的面板放在菜单中；也可以用标签页菜单中的 **打开方式…**。对于这个标签页，该选择优先于记住的关联，直到标签页被重新定向。栏的溢出菜单和打开方式中的 **始终用于** 会记住当前显示的面板。从链接或搜索结果在某一行打开文件时，标签页会切换到源代码。没有候选面板的文件显示 **二进制预览不可用**；二进制文件没有源代码面板。

### DocumentFrame {#documentframe}

从 `@getpaseo/plugin/client/ui` 导入 `DocumentFrame`，用来显示 `file.url()` 或 `useFileUrl` 返回的本地文件 URL：

| 属性     | 必填 | 含义                                                                 |
| -------- | ---- | -------------------------------------------------------------------- |
| `url`    | 是   | 本地文件 URL；Web 上为 `blob:`，原生上为 `file:`。其他协议会被拒绝。 |
| `testID` | 否   | 该框架的测试标识。                                                   |

在 Web 上，挂载 iframe 之前会先检查本地 URL 的媒体类型。PDF 使用浏览器的 PDF 查看器，不加沙箱；其他所有类型，包括 HTML 和未知类型，都保持完整沙箱，不允许脚本或同源访问。原生平台使用禁用了 JavaScript、存储和后续导航的 WebView。在平台无法内联显示文档的地方，例如 Android 上的 PDF，`DocumentFrame` 会改为显示一条说明文件类型的消息，因此请在所有平台上渲染它。

内联 PDF 渲染需要 Paseo 0.13.0 或更高版本的 daemon；更早的 daemon 会把 PDF 报告为 `application/octet-stream`。

### 版本要求与示例 {#version-requirement-and-examples}

文件面板、`DocumentFrame` 和 `Loading` 需要 Paseo 0.13.0 或更高版本。请在 `paseo-plugin.json` 中声明 `"requirements": { "paseo": ">=0.13.0" }`。daemon 和应用都会检查[版本要求](#requirements)；更早的应用会在执行客户端包之前跳过它。用 `writeBytes` 写入需要 Paseo 0.13.0 或更高版本的 daemon。

完整的目录示例：

- [PDF 面板](https://github.com/getpaseo/paseo/tree/main/plugin-examples/pdf-panel)：`useFileUrl` 搭配 `Loading` 和 `DocumentFrame`。
- [Markdown 面板](https://github.com/getpaseo/paseo/tree/main/plugin-examples/markdown-panel)：打包的 CodeMirror 编辑器，只读取一次、用 `writeText` 保存并处理冲突，在原生平台上显示只读文本。

## Command Center 条目 {#command-center-items}

在 macOS 上按 **⌘K**，在 Windows 和 Linux 上按 **Ctrl+K** 打开 Command Center，然后搜索条目标题。

注册一个操作，并在回调中打开一个面板：

```tsx
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const refreshReview = defineRpc({
  name: "review.refresh",
  input: z.object({ agentId: z.string(), scope: z.string().optional() }),
  output: z.object({ refreshed: z.boolean() }),
});

client.addCommandCenterItem({
  id: "open-review",
  title: "Open review",
  icon: "Scan",
  keywords: ["inspect"],
  context: "agent",
  async onSelect({ paseo, rpc, workspace, agent, openPanel }) {
    await paseo.workspaces.ref(workspace.id).setTitle(`Review ${agent.id}`);
    await rpc(refreshReview, { agentId: agent.id });
    openPanel("review");
  },
});
```

`addCommandCenterItem` 的字段：

| 字段       | 是否必填 | 含义                                                |
| ---------- | -------- | --------------------------------------------------- |
| `id`       | 是       | 插件内部的条目 ID。                                 |
| `title`    | 是       | 搜索结果的标题。                                    |
| `icon`     | 是       | Lucide 名称、`{ svg }` 或组件。参见[图标](#icons)。 |
| `keywords` | 否       | 额外的 Command Center 搜索词。                      |
| `context`  | 是       | `global`、`workspace` 或 `agent`。                  |
| `onSelect` | 是       | 对应上下文的客户端回调。                            |

全局条目出现在该安装所选择的主机上。只有当该主机有一个处于活动状态的缓存工作区时，工作区条目才会出现。只有当获得焦点的工作区标签页是一个 Agent，或者是一个缓存记录属于该工作区的 Agent 上下文插件面板时，Agent 条目才会出现。缺少上下文时条目会被移除，而不是调用插件去获取上下文。

每个回调都会收到：

| 字段                      | 上下文         | 含义                                                                                            |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `context`                 | 全部           | 对应的判别字段。                                                                                |
| `paseo`                   | 全部           | 所选主机现有的 `PaseoApi`。                                                                     |
| `rpc(contract, input)`    | 全部           | 对此安装的 daemon 端插件处理函数的带类型调用。                                                  |
| `openScreen(input)`       | 全部           | 打开此插件注册的某个界面：`{ screenId, params? }`。                                             |
| `workspace`               | 工作区和 Agent | 同步的工作区快照。                                                                              |
| `agent`                   | Agent          | 同步的、与之匹配的 Agent 快照。                                                                 |
| `openPanel(id, options?)` | 工作区和 Agent | 在回调当前的上下文中打开一个已注册的面板。传入 `{ location: "explorer" }` 可以打开到 Explorer。 |

Agent 回调可以打开 Agent 面板或工作区面板。工作区回调只能打开工作区面板。未知的界面和面板 ID 会明确报错。普通的工作区、Agent、Provider 和 daemon 配置操作请使用 `paseo`。插件特有的文件系统、凭据、厂商或 daemon 本地工作请使用 `rpc`。

## 斜杠命令 {#slash-commands}

注册一个命令，当用户在消息 Composer 中提交 `/name args` 时，它会在 Paseo 客户端中运行。这段文本
永远不会发送给 Agent：

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent",
  async onSubmit({ args, agent, rpc, openPanel }) {
    await rpc(refreshReview, { agentId: agent.id, scope: args });
    openPanel("review");
  },
});
```

| 字段           | 是否必填 | 含义                               |
| -------------- | -------- | ---------------------------------- |
| `name`         | 是       | 不带前导斜杠的命令名称。           |
| `description`  | 是       | Composer 自动补全中的描述。        |
| `argumentHint` | 是       | 显示在命令名称之后的简短用法提示。 |
| `context`      | 是       | `"workspace"` 或 `"agent"`。       |
| `onSubmit`     | 是       | 对应上下文的客户端回调。           |

`onSubmit` 接收对应的 Command Center 回调上下文以及 `args`。对于 `/review src`，`args` 是
`"src"`；Paseo 只去掉剩余部分首尾的空白，解析留给插件。自动补全行、清空输入框和错误 toast 由
Paseo 负责。它不会等待 `onSubmit`，也不会显示进行中的状态；如需显示，请使用 Composer 胶囊或面板。

优先级依次是内置客户端命令、插件命令、Provider 命令。优先级较低的冲突命令会被省略。内置别名也会占用
它们的名称。插件之间发生冲突时，按稳定的目录顺序排在前面的插件胜出。Composer 中有附件时，命令不会运行。

## 标题栏按钮 {#header-buttons}

试试[按钮示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/buttons)，它在标题栏和
Composer 中演示了操作、菜单、自定义图标和内容以及可见性更新。它会在几种模式之间切换一个标题栏按钮；
其他操作放在一个名为 Tools 的菜单中。

`client.addHeaderButton({ id, workspaceId, button })` 在工作区标题栏右侧的内置操作之前添加一个按钮。
它返回一个带有 `update(patch)` 和 `remove()` 的注册对象。

```tsx
const review = client.addHeaderButton({
  id: "review",
  workspaceId,
  button: {
    title: "Open review",
    icon: "Scan",
    label: "Review",
    behavior: {
      kind: "action",
      onPress() {
        client.openPanel("review", { workspaceId });
      },
    },
  },
});

review.update({ label: "Review · 3" });
review.update({ visible: false });
review.update({ visible: true });
review.remove();
```

省略 `label` 即为只有图标的标题栏按钮。在宽布局中，菜单和弹出框会显示一个 V 形箭头。紧凑布局中的标题栏
按钮只使用图标，没有标签和箭头。Paseo 会把多出来的贡献移入一个共享的溢出菜单。位置和溢出由宿主决定。

## Composer 胶囊 {#composer-pills}

`client.addComposerPill({ id, workspaceId, agentId, button })` 使用同样的[按钮描述符](#button-descriptor)，
并返回同样的注册对象。它面向某个 Agent 的 Composer 栏，与 Tasks 和 Subagents 并列。Composer 胶囊始终
显示图标和 `label`（省略 `label` 时显示 `title`）。它们从不显示箭头，菜单和弹出框也一样。

```tsx
const pill = client.addComposerPill({
  id: "review",
  workspaceId,
  agentId,
  button: {
    title: "Open review",
    icon: "Scan",
    label: "Review",
    behavior: {
      kind: "action",
      onPress() {
        client.openPanel("review", { workspaceId, agentId });
      },
    },
  },
});
```

对于随 Agent 目录变化的胶囊，请使用显式的[自有列表订阅](/docs/sdk/events#follow-one-agents-status)。
[本地插件示例](https://github.com/getpaseo/paseo/blob/main/plugin-examples/local-plugin/client/main.tsx)
会在每次快照时替换注册，并在入口清理时中止观察，包括尚未完成的引导过程。

## 按钮描述符 {#button-descriptor}

这些契约从 `@getpaseo/plugin/client` 导出。

| 字段       | 是否必填 | 含义                                                               |
| ---------- | -------- | ------------------------------------------------------------------ |
| `title`    | 是       | 非空的无障碍标签、提示文字和底部面板标题。                         |
| `icon`     | 是       | Lucide 名称、`{ svg }` 或 `ComponentType<PluginButtonIconProps>`。 |
| `label`    | 否       | 非空的显示文字。省略时使用该位置的默认值。                         |
| `visible`  | 否       | 默认为 `true`。为 false 时移除触发器及其占用的布局空间。           |
| `disabled` | 否       | 默认为 `false`。按钮保持可见，但无法交互。                         |
| `behavior` | 是       | 下面三种形式之一。                                                 |

```tsx
type PluginButtonBehavior =
  | { kind: "action"; onPress(): void | Promise<void> }
  | { kind: "menu"; items: readonly PluginButtonMenuEntry[] }
  | { kind: "popover"; Content: React.ComponentType<PluginButtonContentProps> };
```

操作在客户端运行。在 promise 完成之前，Paseo 会把按钮标记为忙碌，阻止重复按下，并用 toast 显示失败。
失败的操作可以重试。普通操作请使用客户端的 `paseo`，插件特有的后端工作请使用 `rpc`。

菜单和弹出框在宽布局中以锚定的浮层打开，在紧凑布局中以底部面板打开。按下整个触发器都会打开浮层；没有
分体按钮的行为。

### 菜单项 {#menu-entries}

菜单包含条目和分隔线。ID 由小写字母、数字和连字符组成，以字母开头，并且在该菜单内唯一。

```tsx
const behavior: PluginButtonBehavior = {
  kind: "menu",
  items: [
    {
      kind: "item",
      id: "refresh",
      title: "Refresh review",
      icon: "RefreshCw",
      behavior: { kind: "action", onPress: refreshReview },
    },
    { kind: "separator", id: "details-divider" },
    {
      kind: "item",
      id: "details",
      title: "Review details",
      behavior: { kind: "popover", Content: ReviewDetails },
    },
  ],
};
```

条目需要 `kind: "item"`、`id`、`title` 和 `behavior`。它可选的 `icon`、`visible` 和 `disabled`
遵循按钮的规则。分隔线只包含 `kind: "separator"` 和 `id`。在过滤掉隐藏的条目之后，Paseo 会移除开头、
结尾和连续的分隔线。

条目可以使用全部三种行为。嵌套菜单在宽布局中以弹出子菜单打开，在紧凑布局中则以同一个底部面板内带返回
导航的页面打开。自定义内容页面在选中时打开，不会在悬停时打开。选择一个操作会关闭菜单；打开另一个页面
则让菜单保持打开。

### 自定义图标和弹出框内容 {#custom-icons-and-popover-content}

`PluginButtonIconProps` 包含 `theme`、`host`、`layout`、`size`、`color` 以及目标上下文。请在给定的
尺寸内渲染一个 React Native 图标或指示器。图标槽的边界和所有指针交互都由 Paseo 负责。图标组件可以使用
插件 hook。

`PluginButtonContentProps` 包含 `theme`、`host`、`layout`、目标上下文以及 `close()`。只渲染主体；锚定、
滚动、内边距和底部面板的呈现由 Paseo 负责。内容可以使用 `usePaseo`、`useRpc`、`useWorkspace`、
`useAgent` 以及该安装的 React Query 缓存。

目标上下文是以下之一：

```ts
{ context: "workspace", workspaceId: string } // Header button
{ context: "agent", workspaceId: string, agentId: string } // Composer pill
```

### 更新与生命周期 {#updates-and-lifecycle}

每个注册都属于一个插件安装、一个位置、一个工作区，以及（对于胶囊）一个 Agent。`id` 在该目标内是插件
内部的，格式与菜单 ID 相同。同一个 ID 可以用于不同的目标或位置。在同一目标中重复注册会抛出错误。

`update(patch: Partial<PluginButton>)` 原地修改描述符，保留其标识和顺序。修改 `behavior` 时，请提供
完整的新 behavior 对象。无效的更新会抛出错误，并且不会改变现有按钮。订阅你自己的模型或客户端 API，并
调用 `update` 来发布响应式的变化；修改最初的描述符不会更新 UI。

隐藏或禁用按钮会关闭它的浮层。更新它的 behavior 也会关闭浮层。隐藏会保留注册，因此再次显示时会恢复它
原来的位置。它不会取消已经在进行中的操作。

`remove()` 是幂等的。移除之后的更新不起作用。当插件安装或主机连接被拆除时，Paseo 会移除尚存的按钮。
请从客户端入口返回清理函数，用来释放你的订阅、定时器和其他资源。

## 使用 Paseo SDK {#use-the-paseo-sdk}

在界面中执行普通的 Paseo 操作请使用 `usePaseo()`。它借用所选主机现有的连接；不要再创建一个客户端。

`usePaseo()` 是你的插件唯一的 Paseo 客户端，在每个界面中都与 setup 收到的 `client.paseo` 相同。
请在清理函数中释放你订阅的内容；当插件被停用、重新加载或移除，或者它的主机消失时，Paseo 会销毁该客户端，
并结束所有仍然打开的订阅。

```tsx
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text } from "react-native";

function ProjectChanges() {
  const paseo = usePaseo();
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const observation = paseo.observeEvents(["project.update"]);
    observation.subscribe({ snapshot() {}, update: () => setChanges((count) => count + 1) });
    return () => void observation.release();
  }, [paseo]);
  return <Text>{changes} project changes</Text>;
}
```

```tsx
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";

function PullRequestAction({ theme }: PluginSurfaceProps) {
  const paseo = usePaseo();

  async function createReviewWorkspace() {
    const workspace = await paseo.workspaces.create({
      title: "Review PR 42",
      source: {
        kind: "worktree",
        cwd: "/absolute/path/to/repository",
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number: 42 },
      },
    });
    await workspace.agents.create({
      config: { provider: "codex/gpt-5.5" },
      prompt: "Review PR #42.",
    });
  }

  return (
    <Pressable accessibilityRole="button" onPress={() => void createReviewWorkspace()}>
      <Text style={{ color: theme.colors.foreground }}>Create review workspace</Text>
    </Pressable>
  );
}
```

返回的 API 涵盖项目、工作区、Agent、终端、Provider 和 daemon 配置。其方法请参阅 [SDK API 参考](/docs/sdk/reference)。这里刻意没有连接生命周期方法，因为连接由 Paseo 负责。

### 发现主机并指定另一台主机 {#discover-hosts-and-target-another-host}

使用 `useHosts()` 显示已配置的主机，并在操作回调中使用 `getPaseoClient(serverId)` 对其中一台主机
执行 SDK 操作：

```tsx
import { getPaseoClient, useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";

export function HostAgents({ theme }: Pick<PluginSurfaceProps, "theme">): ReactElement {
  const hosts = useHosts();
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const [result, setResult] = useState("");

  async function listAgents(serverId: string): Promise<void> {
    try {
      const { entries } = await getPaseoClient(serverId).agents.list();
      setResult(`${entries.length} agents`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }

  const rows = hosts.map((host) => ({
    host,
    onPress() {
      void listAgents(host.serverId);
    },
  }));

  return (
    <View>
      {rows.map(({ host, onPress }) => (
        <Pressable key={host.serverId} accessibilityRole="button" onPress={onPress}>
          <Text style={textStyle}>
            {host.label}: {host.status}
          </Text>
        </Pressable>
      ))}
      <Text style={textStyle}>{result}</Text>
    </View>
  );
}
```

`useHosts(): readonly PluginHostSummary[]` 包括离线的主机，并在主机、标签或状态变化时更新。

| 摘要字段   | 类型或取值                                                   | 含义                                          |
| ---------- | ------------------------------------------------------------ | --------------------------------------------- |
| `serverId` | `string`                                                     | 传给 `getPaseoClient` 的 ID。                 |
| `label`    | `string`                                                     | 主机的显示名称。                              |
| `status`   | `"idle"`、`"connecting"`、`"online"`、`"offline"`、`"error"` | 当前应用的连接状态。SDK 调用需要 `"online"`。 |

`getPaseoClient(serverId: string): PaseoApi` 借用该主机已认证的应用连接。请在客户端入口代码或回调中
调用它；它不会打开 socket，也不要求目标 daemon 上安装了该插件。在执行操作时再获取 API，以便使用当前的
连接。
| 事件或条件 | 结果与调用方的处理 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 未知的主机 ID | 抛出 `Unknown Paseo host: <id>`；永远不会转到另一台主机。 |
| 主机不在线 | 抛出 `Paseo host is disconnected: <id>`，通过保留的 API 发起的调用也是如此。请在主机上线后重试。 |
| 同一连接重新连接 | 保留的 API 在重新连接后仍然可用；观察会自动恢复。 |
| 连接设置变化，或应用切换了连接（包括自动故障转移） | 旧的 API 被释放。请再次调用 `getPaseoClient(serverId)` 并重新创建订阅。 |
| 主机被移除 | 它的 API 被释放；被移除的 ID 变为未知。 |
| `client.dispose()` | 释放该 API 及其观察。之后再调用获取函数会返回一个基于应用连接的新 API。再次销毁旧的 API 不会影响新 API 的使用。 |
| 发起调用的插件被卸载 | 它借用的所有 API 和观察都会被释放，包括指向其他主机的那些。保留的句柄不能比该安装存活得更久。 |
| 界面的主机选择发生变化 | `usePaseo()` 跟随所选的主机。显式获取的 API 保持其原来的目标。 |

你也可以通过普通的 SDK API 释放单个订阅。

插件是受信任的应用代码；跨主机访问是有意设计的。摘要中不包含连接 URL 或凭据，借用的 API 也不提供连接
生命周期控制。请参阅[主机 Agent 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/hosts)。

## 添加插件特有的后端行为 {#add-plugin-specific-backend-behavior}

插件 RPC 只用于不属于普通 Paseo 操作的工作：读取厂商 API、访问 daemon 本地资源，或者让凭据不经过客户端。

用 Zod 定义一个契约，在子进程中处理它，并从界面中调用它：

`shared/greeting.ts`：

```ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

`client/greeting.tsx`：

```tsx
import { useRpc } from "@getpaseo/plugin/client";
import { greeting } from "../shared/greeting";

export function GreetingButton() {
  const createGreeting = useRpc(greeting);
  // Call createGreeting({ name: "Ada" }) from an event or query.
  return null;
}
```

`server/greeting.ts`：

```ts
import type { RpcInput } from "@getpaseo/plugin";
import { greeting } from "../shared/greeting";

export function createGreeting({ name }: RpcInput<typeof greeting>) {
  return { message: `Hello, ${name}` };
}
```

`index.client.tsx`：

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GreetingButton } from "./client/greeting";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Greeting", Component: GreetingButton });
  return () => {};
}
```

`index.server.ts`：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greeting } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greeting, createGreeting);
  return () => {};
}
```

输入和输出在两端都会校验。RPC 名称以小写字母开头，由小写字母、数字、点、连字符或下划线组成。`useRpc()` 返回一个带类型的异步函数。请求状态、缓存和变更请使用 TanStack Query。

后端处理函数以 `{ paseo }` 的形式收到同样的 `PaseoApi`。它们的连接属于子进程，并在插件停止时关闭。在插件代码订阅之前，它不会订阅时间线或目录事件。清理和时间线替换请遵循 [SDK 事件契约](/docs/sdk/events)。后端代码可以使用 Node API 以及安装在插件目录中的依赖。

## 调试后端输出 {#debug-backend-output}

后端贡献可以用普通的 Node 日志写入 stdout 和 stderr：

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

当插件开始加载、就绪、开始停止以及已经停止时，Paseo 会添加 `[paseo]` 条目。它把编译和加载失败记录为
stderr 条目，包括在插件子进程启动之前发生的失败。Paseo 还会捕获初始化、RPC 处理函数、清理以及进程失败
期间产生的输出。协议通信使用单独的通道，因此 `console.log()` 不会破坏插件 RPC。

打开该插件的 **设置 → 插件 → Logs**，或者通过 daemon CLI 查看同一份最近的日志尾部：

```bash
paseo plugin logs my-plugin
paseo plugin logs my-plugin --json
paseo --host <url> plugin logs my-plugin
```

该命令返回的是一份快照，而不会持续跟随实时输出。要查看更新的条目，请刷新设置视图或再次运行该命令。每个
条目都包含时间戳、stdout 或 stderr 流、序号和消息。

Paseo 在内存中为每个插件最多保留 500 个条目和 256 KiB。单行最多 16 KiB。重新加载、停用、编译失败、
初始化失败和进程失败都会保留日志尾部。移除插件会清空它，daemon 重启则会开始新的日志尾部。结构化的副本
也会写入位于 `$PASEO_HOME/daemon.log` 的 daemon 日志。

只有 daemon 端的输出会被捕获。客户端界面的日志留在应用运行时中。不要记录凭据、访问令牌或其他机密：已连接
的用户可以读取保留的日志尾部，而 daemon 日志会把它持久保存。

## 添加 Composer 附件来源 {#add-a-composer-attachment-source}

附件来源搜索外部资源，并为 Agent 提示词返回一份稳定的文本快照。请把凭据和厂商调用放在后端处理函数中。

`shared/issues.ts`：

```ts
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const searchIssues = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});
```

`server/issues.ts`：

```ts
import type { RpcInput } from "@getpaseo/plugin";
import { searchIssues } from "../shared/issues";

export function search({ query }: RpcInput<typeof searchIssues>) {
  return searchAcmeIssues(query);
}
```

`index.client.tsx`：

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

`index.server.ts`：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { search } from "./server/issues";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, search);
  return () => {};
}
```

Composer 菜单、搜索选择器、选中后的胶囊、草稿状态和提交都由 Paseo 负责。`text` 的值就是发送给 Agent 的完整快照。`icon` 是 Lucide 名称或 `{ svg }`；参见[图标](#icons)。

## 主机与生命周期 {#hosts-and-lifecycle}

插件按 daemon 安装。当同一个贡献存在于多台已连接的主机上时，Paseo 只显示一个侧边栏项，并添加一个主机选择器。所选的主机提供插件包、Paseo API、RPC 传输以及查询缓存。当所选主机离线时，调用永远不会转到另一台主机。

附件来源仍然限定在各个 Composer 所在的主机上。

工作区面板和 Command Center 条目仍然限定在当前活动的主机和确切的缓存上下文中。重新加载会替换它们的
注册。停用、移除、主机断开和求值失败会移除 Command Center 条目，并清除该安装的查询状态。已经恢复的面板
标签页会保持“不可用”状态，直到与之匹配的贡献重新出现或用户关闭它。面板的渲染失败会被限制在插件的错误
边界内。

重新加载会排在 daemon 的其他插件工作之后，例如正在运行的安装或准备命令；当插件再次运行或失败时，daemon
才会给出响应。插件的状态不能当作重新加载的结果来读取：在重新加载排队期间，`plugin ls`、设置和日志
显示的是插件之前的状态；而在 daemon 停止并启动插件期间，读取状态会得到 `failed`，因为在启动完成之前插件
不在运行时目录中。

## 插件来源 {#plugin-sources}

把以下来源标识之一粘贴到 **设置 → 插件** 中，或者传给 `paseo plugin install`。
`paseo plugin add <source>` 和 `paseo plugin install <source>` 互为别名。CLI 从你当前的工作目录解析
相对目录路径，并把 `~` 展开为你本地的主目录，同时保留任何 `:plugin/path` 后缀。使用 `--host` 时，请使用
daemon 主机上存在的绝对路径；插件文件在那台主机上读取，CLI 永远不会上传它们。在设置中输入的路径相对于
daemon 的工作目录解析，`~` 会展开为 daemon 的主目录。

| 来源               | 接受的形式                                                  | 示例                                          |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| 插件注册表         | `owner/slug` 或 `host/owner/slug`                           | `acme/review`                                 |
| 主机目录           | daemon 主机上的绝对或相对路径                               | `/srv/paseo/plugins/review`                   |
| GitHub 仓库        | `git:owner/repository` 或 `github:owner/repository`         | `github:acme/paseo-review`                    |
| Git 仓库           | `git:<URL 或 SCP 来源>`；对于 URL 和 SCP 来源，前缀可以省略 | `git:https://git.example.com/acme/review.git` |
| npm 包             | `npm:<name>[@<版本、标签或范围>]`；`npm:` 可以省略          | `npm:@acme/paseo-review@^1.2.0`               |
| 来源根目录下的插件 | 在目录、Git 或 npm 来源后追加 `:relative/plugin/path`       | `github:acme/monorepo:plugins/review`         |

Git URL 使用 `https://`、`http://`、`ssh://`、`git://` 或 `file://`。SCP 来源使用 `user@host:path`。
`file://` 选择的是 Git 获取方式，而不是目录安装。

npm 名称是小写的无作用域 `name` 或有作用域的 `@scope/name`。每个部分以字母或数字开头，之后由字母、数字、
`.`、`_` 或 `-` 组成。在包名之后，可选的 `@` 引出一个确切版本、发布标签或 npm semver 范围。省略它表示
`latest`。包含空格或比较运算符的 shell 参数请加引号。npm 别名、tarball URL 和 npm 的 `file:` 规格都不是
插件来源标识；对于这些位置，请使用目录或 Git 来源。如果一个无作用域的包同时带有选择器和子目录，请使用
`npm:` 前缀（`npm:review@1.2.0:nested`）；没有前缀时，`user@host:path` 是一个 SCP Git 来源。所选的版本、
标签或范围由包注册表校验。

Paseo 按以下顺序解析标识：

1. 裸的 `owner/slug` 是注册表 ID；本地目录来源是 `.` 或 `..`，或者以 `./`、`../`、`.\`、`..\`、`/`、`~`、Windows 盘符（`C:\` 或 `C:/`）或 UNC（`\\server\share`）前缀开头。
2. 否则，在解析子目录后缀之前，先识别 `npm:`、`github:` 或 `git:`。
   `git://` 是 Git URL 的 scheme。显式的前缀会选择对应类型的获取方式。
3. 只有当末尾的 `:relative/plugin/path` 后缀不包含空的、`.` 或 `..` 段时，才把它识别为后缀。单独的
   `.` 选择来源根目录。`/` 和 `\` 都可以分隔后缀中的段；跨主机时请使用 `/`。URL 端口和 SCP 来源中的
   分隔符仍属于来源本身。不满足这些规则的后缀仍属于标识的一部分。
4. 裸的 `owner/slug` 通过默认插件注册表解析，`host/owner/slug` 通过该注册表主机解析。Git URL 和 SCP
   来源按 Git 解析。`github:` 要求 `owner/repository` 简写；`git:` 既接受简写，也接受 URL 和 SCP 来源。
5. 剩下的 npm 包名及其可选的选择器通过主机的注册表解析。其他任何内容都会被拒绝。

默认注册表是 `https://plugins.paseo.sh`。浏览[已发布的插件](https://paseo.sh/plugins)，并用
`paseo plugin add owner/slug` 安装。注册表记录决定修订版本和插件路径。显式的 GitHub 简写请使用
`git:owner/repository`，或者使用完整的 Git URL。设置 `PASEO_PLUGIN_REGISTRY` 可以使用自托管的默认 URL，
包括路径前缀。私有注册表的凭据在 daemon 配置中使用
`pluginRegistries: { "host": { "authorization": "Bearer token" } }`。修改这些启动设置后请重启 daemon。
凭据只会发送给该注册表，永远不会发送给制品主机或重定向目标。当默认值变化时，已安装的插件保留它们记录的
来源和注册表 URL。

目录查找在 daemon 主机上进行。应用使用 `paseo-plugin.json` 中的 ID；CLI 接受 `--id <runtime-id>` 来覆盖它。
已存在的安装 ID 会被拒绝，并且不会改变它的启用状态或文件。

```bash
paseo plugin install /srv/paseo/plugins/review
paseo plugin install github:acme/paseo-review
paseo plugin install git:https://git.example.com:8443/acme/monorepo.git:plugins/review --ref main
paseo plugin install git@git.example.com:acme/review.git
paseo plugin install file:///srv/repos/monorepo:plugins/review
paseo plugin install npm:paseo-review@1.2.0
paseo plugin install npm:@acme/paseo-review@next
paseo plugin install 'npm:@acme/paseo-review@>=1.2.0 <2.0.0' --id review-staging
paseo plugin install npm:@acme/plugins@^1.2.0:plugins/review
```

`--ref` 只适用于 Git，接受用于这次安装的分支、标签或提交。没有它时，Paseo 安装远程的默认 HEAD。安装时的
选择器不会约束之后的更新。旧版的 `--path relative/plugin/path` 选项等同于子目录后缀，对 npm 也是如此。

### npm 安装与发布 {#npm-installation-and-publishing}

在 **daemon 主机**上安装带有 npm 的 Node.js，并让 `npm` 出现在 daemon 的 `PATH` 中。daemon 使用该主机的
npm 用户/全局配置和环境来选择注册表和进行认证，包括特定作用域的注册表。客户端不会下载包，也不会运行 npm。
加载、启用和重新加载已安装的插件都不需要 npm。

daemon 在一个隔离的目录中安装每个候选包及其生产依赖。激活时，它会保留完整的依赖树和 `package-lock.json`。
已安装的包和 lockfile 提供它的当前版本和制品完整性。版本、标签或范围只为这一次安装选择内容。

已安装的 lockfile 记录了这次安装解析出的结果。提交带有运行时依赖的 npm 插件的作者还必须附带
[发布锁](/docs/plugins/publishing#2-lock-installed-dependencies)。关于包的内容、准备和提交，请参阅
[发布插件](/docs/plugins/publishing)。

下载、依赖安装、manifest 检查、准备命令、编译或激活中的任何一步失败，都会丢弃候选包。其他已安装的插件继续
运行。移除 npm 插件会删除它的托管文件；移除目录插件则会保留你的源目录。

## CLI 参考 {#cli-reference}

```bash
paseo plugin init /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin add owner/slug
paseo plugin add git:owner/repository
paseo plugin add https://git.example.com/owner/repository.git --ref main
paseo plugin add git:owner/monorepo:plugins/review
paseo plugin ls [id]
paseo plugin update <id>
paseo plugin update --all --check
paseo plugin update --all --yes
paseo plugin update my-plugin --version 1.2.0
paseo plugin update my-plugin --ref v2
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

`ls` 和设置页面显示来源标识和当前安装的修订版本，而不会联系远程。标识包含所选的子目录，不包含安装时的
选择器。

`update <id>` 检查更新，显示当前和拟更新的修订版本以及可用的审查链接，并请求批准。拒绝则保持已安装的内容
不变。

- npm 检查包的 `latest` 版本。它只会提供更新的版本；比 latest 更新的已安装版本会保持安装状态。解析由主机的
  npm 注册表/认证配置决定。
- Git 检查远程当前的默认 HEAD，不论安装时选择的是哪个分支、标签或提交。
- 目录插件会被跳过；请编辑目录并使用 `reload`。

`--check` 只做预览，即使提供了显式目标或 `--yes` 也是如此。`--yes` 跳过询问。`--all` 检查每个已配置的插件，
并分别报告结果；一个失败不会阻止其他插件。这两个标志都不允许普通的 npm 降级。

`--version <version|tag|range>` 或 `--ref <branch|tag|commit>` 为某个匹配的插件选择更新内容，并在不再询问
的情况下应用它。显式的 npm 版本可以更旧。下一次普通更新会再次检查 latest。显式目标不能与 `--all` 一起使用。
JSON 模式和非交互的普通更新需要 `--yes`。

批准后会获取被审查的那个确切提交或 npm 制品。如果它不可用，或者在审查期间已安装的插件发生了变化，更新会失败
并要求你重新检查。准备或激活失败会保留之前的安装。目前还不支持在应用中手动审查更新。

当目标不是 CLI 的默认 daemon 时，请把 `--host <url>` 放在管理命令之前。`remove` 永远不会删除目录来源；对于
Git 和 npm 来源，它会删除托管文件。安装时的 `--id` 就是运行时 ID，允许同一个目录或仓库被安装多次。

> **信任你添加的每一个插件。** `paseo plugin add` 和 `paseo plugin install` 的意思是“我信任这个代码库”。服务端代码和准备命令在 daemon 主机上以 daemon 用户的权限在沙箱外运行；客户端贡献在 Paseo 内部运行。依赖和未来的更新也属于这个决定的一部分。使用全局 `--host` 选项时，命令在远程 daemon 主机上运行。

大多数插件应省略 `build`。只有当暂存的检出必须安装 Paseo 未提供的依赖、生成源代码或资源，或者执行其他必需的
准备步骤时，才使用它：

```json
{
  "id": "review",
  "requirements": { "paseo": ">=0.8.0" },
  "build": [["npm", "ci", "--omit=dev"]]
}
```

`build` 是一个由非空 argv 数组组成的列表。在解析出确切的提交和 manifest 之后，Paseo 从暂存的插件目录中直接
运行每个可执行文件，不经过 shell。它永远不会从 lockfile 推断包管理器或命令。安装和更新都会在校验、编译、激活
或替换之前运行 `build`。失败的命令会报告其输出、丢弃候选包，并保持已安装/正在运行的版本不变。daemon 日志会
记录每条命令及其输出；使用全局 `--host` 选项时，命令在该 daemon 主机上执行。

在安装或重新加载之前运行 `npm run typecheck`。请用 CLI 或设置页面管理插件来源条目；安装语法请参阅
[插件来源](#plugin-sources)。

daemon 级别的 **启用插件** 开关位于 **设置 → 插件** 下。只有当这个开关和插件自身的启用状态都打开时，已配置的插件才会运行，否则它会保持 `disabled`。

这个开关是 `config.json` 中根级的 `pluginsEnabled` 字段。修改后请运行 `paseo reload --json`。启用会启动所有自身 `enabled` 值不为 `false` 的已配置插件；停用会拆除所有插件。不需要重启 daemon。手动编辑的插件来源条目不会被重新加载；这些请使用插件生命周期命令。

## 加载失败 {#load-failures}

使用 `paseo plugin ls` 读取当前的状态和错误。

| 症状                                                                  | 检查                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `This plugin was made for an older version of Paseo`                  | 目录中只有 `index.ts` 入口。请按照[迁移指南](/docs/plugins/migration)操作。                                                    |
| `Plugin entry points are missing`                                     | 不存在名称完全一致的 `index.client.tsx` 或 `index.server.ts`。                                                                 |
| `server-only module cannot be imported into the plugin client bundle` | 客户端代码导入了 `server/`。把这部分工作移到 RPC 之后，并从 `shared/` 导入它的契约。                                           |
| `client-only module cannot be imported into the plugin server bundle` | 服务端代码导入了 `client/`。改为从 `index.client.tsx` 注册该贡献。                                                             |
| `Node module cannot be imported into the plugin client bundle`        | 客户端代码导入了 `node:*`。把该操作移到 `server/`，并通过 RPC 调用它。                                                         |
| 侧边栏项缺失                                                          | 确认插件处于 `running` 状态，该项没有在 **设置 → 侧边栏** 中被隐藏，它的组件没有抛出错误，并且客户端连接的是该安装所在的主机。 |
| 客户端模块不可用                                                      | 只导入上面列出的、由宿主提供的客户端模块。                                                                                     |
| RPC 被拒绝                                                            | 检查两个 Zod schema 以及 daemon 端处理函数的错误。                                                                             |
| 修改后的代码没有生效                                                  | 运行 `npm run typecheck`，然后运行 `paseo plugin reload <id>`。                                                                |
| 重新加载失败                                                          | 读取 `paseo plugin ls` 和 `paseo plugin logs <id>`，修复源代码错误后再重新加载；Paseo 不会恢复之前的插件包。                   |
| 插件意外退出                                                          | 读取 `paseo plugin logs <id>`，查看保留的初始化、清理、stderr 以及最终崩溃的输出。                                             |
