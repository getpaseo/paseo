# 构建侧边栏视图 {#build-a-sidebar-view}

侧边栏视图替换 Paseo 页眉与页脚之间的内容。插件接收主题令牌、当前实体引用和导航方法，使用 React Native 绘制自己的界面。安装[侧边栏视图示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/sidebar-views)，体验项目列表、按任务分组的 Agent、嵌套 Agent、标签文件夹和已打开的标签页。

## 注册视图 {#register-a-view}

```tsx
import type {
  PluginClientContext,
  PluginSidebarViewProps,
  WorkspaceRef,
} from "@getpaseo/plugin/client";
import { useWorkspaces, useWorkspace } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, Text } from "react-native";

function WorkspaceRow({
  reference,
  navigation,
  theme,
}: {
  reference: WorkspaceRef;
  navigation: PluginSidebarViewProps["navigation"];
  theme: PluginSidebarViewProps["theme"];
}) {
  const workspace = useWorkspace(reference);
  if (!workspace) return null;
  return (
    <Pressable onPress={() => navigation.openWorkspace(reference)}>
      <Text style={{ color: theme.colors.foreground }}>{workspace.title ?? workspace.name}</Text>
    </Pressable>
  );
}
function Workspaces({ navigation, theme }: PluginSidebarViewProps) {
  const workspaces = useWorkspaces({ orderBy: "name" });
  return (
    <ScrollView>
      {workspaces.map((reference) => (
        <WorkspaceRow
          key={reference.key}
          reference={reference}
          navigation={navigation}
          theme={theme}
        />
      ))}
    </ScrollView>
  );
}
export default function contribute(client: PluginClientContext) {
  return client.addSidebarView({ id: "workspaces", title: "My workspaces", Component: Workspaces });
}
```

注册后，用户可以在**设置 → 侧边栏 → 侧边栏视图**中选择该视图。安装插件不会切换当前视图。页眉导航、插件页眉项、提示区域和页脚保持可见。所选视图缺失或被禁用时，显示默认视图。视图抛出异常时，显示带有**使用默认视图**按钮的占位界面。

视图同时展示所有已连接主机的数据。`active.workspace` 和 `active.agent` 是引用或 `null`。将引用传给 `navigation.openWorkspace`、`openAgent`、`openTerminal` 或 `openProject`；`openProject` 打开新建工作区流程。导航会关闭紧凑布局的侧边栏。如果插件自行执行导航，完成后调用 `dismiss()`。

## 查询引用，逐行读取 {#query-refs-read-each-row}

`useWorkspaces`、`useAgents`、`useProjects` 和 `useTerminals` 返回不可变的引用数组。引用包含 `kind`、`hostId`、`id` 和跨主机唯一的 `key`。在一次应用会话中，同一实体使用同一个冻结引用。在行组件内将它传给 `useWorkspace`、`useAgent`、`useProject` 或 `useTerminal`。实体删除后返回 `null`。

```tsx
const projects = useProjects({ orderBy: "displayName" }); // Includes empty projects.
const agents = useAgents({
  hosts: [hostId],
  where: (agent) => agent.workspace.key === workspaceRef.key,
  orderBy: ["lastActivityAt", "desc"],
});
const folders = useWorkspaces({
  groupBy: (workspace) => workspace.labels, // A workspace can appear in several folders.
});
```

每个查询都支持 `hosts`（服务器 ID）、`where`、`orderBy` 和 `groupBy`。省略 `hosts` 时查询所有已连接主机。`orderBy` 接受快照字段、`[field, "asc" | "desc"]` 或比较函数。空值排在最后。比较函数会在数据变化时执行，应保持开销较小。

`groupBy` 返回字符串、`{ key, title?, color? }` 或这些值组成的数组。分组结果包含 `key`、`title`、`color` 和 `items`。分组按排序后首次出现的顺序排列；重复的键使用第一个标题。返回空数组表示该项不属于任何分组。

引用序列不变时，数组对象保持不变。分组的元数据和项序列不变时，分组对象保持不变。工作区状态变化只更新对应行，不会重新渲染整个列表。分组变化会更新受影响的分组。查询对象和函数可以内联编写，无需自行管理订阅。

实体钩子支持选择器和可选的相等比较函数：

```tsx
const workspace = useWorkspace(ref); // Interned snapshot, compared by identity.
const name = useWorkspace(ref, (item) => ({ title: item.title })); // Shallow equality.
const selected = useWorkspace(ref, selector, equals);
```

没有选择器时，自定义相等比较函数接收快照；有选择器时接收选择结果。现有工作区面板仍可向 `useWorkspace` 和 `useAgent` 传入主机本地的字符串 ID。跨主机视图应使用引用。`useHosts()` 保留现有的 `serverId`、`label` 和连接 `status` 字段。

工作区快照包含 `project`、`pinnedAt`、`labels`、`background`、`branch`、`lastPromptAt`、`parentAgent` 和 `createdAt`（旧主机上为 null）。使用 `indicator` 和本地化的 `indicatorLabel` 显示 Paseo 的状态。`status` 保持 daemon 原始状态。Agent 快照包含工作区和父 Agent 引用、`background` 和 `backgroundWork.count`。项目快照提供 `displayName`、`rootPath`、`kind` 和 `iconRevision`。

## 列出终端 {#list-terminals}

终端示例支持选择主机、列出终端、聚焦终端标签页，以及通过句柄关闭终端。`useTerminals({ hosts: [hostId] })` 要求主机声明 `terminalCollection` 能力。查询不支持该能力的主机时，终端读取会抛出要求更新主机的错误；其他实体钩子继续工作。将主机选择器放在错误边界之外，方便用户切换主机。省略 `hosts` 时，所有已连接主机都必须支持该能力。

终端快照包含 `workspace`、`title`、`isScript` 和 `createdAt`。在时间戳跟踪引入前启动的 worker 所保留的终端，其 `createdAt` 为 null。脚本归属来自工作区脚本运行时条目。主机观察跟踪终端创建、关闭、标题变化和重新连接，并在最后一个终端读取订阅者离开时释放。

## 显示已打开的标签页和子 Agent {#show-open-tabs-and-subagents}

`useWorkspaceTabs(workspaceRef)` 返回此设备上该工作区已打开的标签页，按窗格及标签栏顺序排列，并返回 `activeTabId`，即打开工作区时显示的标签页。标签页是应用状态，其他设备各有自己的标签页。资源管理器中的“文件”和“更改”标签页不包含在内。每个标签页包含 `id`、`kind`，以及它显示的 `agent`、`terminalId`、`providerSubagent` 或 `path`。未变化的标签页保留同一对象，未变化的列表保留同一引用。

```tsx
function TabRow({ tab, view }: { tab: PluginWorkspaceTab; view: PluginSidebarViewProps }) {
  return (
    <WorkspaceTabPresentation tab={tab}>
      {(presentation) => (
        <Pressable onPress={() => view.navigation.openTab(tab)}>
          <presentation.Icon size={14} color={view.theme.colors.foregroundMuted} />
          <Text>{presentation.label}</Text>
          <WorkspaceTabMenu tab={tab} label={presentation.label} />
        </Pressable>
      )}
    </WorkspaceTabPresentation>
  );
}
```

`WorkspaceTabPresentation` 解析应用标签栏显示的标签、副标题、图标、未保存状态和状态 `indicator`。`navigation.openTab` 打开工作区并聚焦该标签页。`WorkspaceTabMenu` 是应用自带的标签页菜单：复制、重新加载、重命名和关闭，并使用应用的确认对话框和重命名对话框。SDK 不提供命令式关闭，因此有未保存内容的标签页总会先询问。

`useSubagents(tab.agent)` 按创建时间从早到晚列出 Agent 的子 Agent：它启动的 Paseo Agent（`kind: "agent"`，用 `useAgent` 读取），以及提供方自己的子 Agent（`kind: "provider"`，包含 `title`、`description`、`status` 和 `requiresAttention`）。主机支持时，读取会获取提供方的列表。传入 `{ parentSubagentId }` 可读取提供方子 Agent 的子级。`useSubagentPresentation` 提供行的标签、图标、状态和信息行。`navigation.openSubagent(subagent, { parentTab })` 按子 Agent 轨道的方式打开它：在父标签页旁边，若子 Agent 有自己的工作区则在该工作区中打开。`SubagentMenu` 在标签页操作之外增加分离和归档。

Hook 从 `@getpaseo/plugin/client` 导入，组件从 `@getpaseo/plugin/client/ui` 导入。示例中的 `tabs` 视图列出每个工作区的标签页及其子 Agent。

## 通过引用执行操作 {#act-on-a-ref}

`usePaseo()` 将基于引用的操作发送到引用所属的主机：

```tsx
const paseo = usePaseo();
await paseo.workspaces.ref(workspaceRef).setPinned(true);
await paseo.workspaces.ref(workspaceRef).setLabel("Later", { assigned: true });
await paseo.workspaces.ref(workspaceRef).setLabel("Inbox", { assigned: false });
paseo.projects.ref(projectRef).open();
await paseo.projects.ref(projectRef).createWorkspace();
paseo.terminals.ref(terminalRef).focus();
await paseo.terminals.ref(terminalRef).kill();
```

工作区和 Agent 句柄保留现有方法。分配新标签会创建该标签；分配已有标签会保留其颜色。标签文件夹示例先添加目标标签，再移除源标签，因此分配失败时仍保留原文件夹。插件负责移动手势和错误显示。

## 在设备上保存布局选择 {#keep-layout-choices-on-the-device}

定义 `scope: "device"` 的[设置文档](reference.md#settings-screens)，保存折叠文件夹或手动排序。`useSettings` 通过与主机设置相同的修订版本 API 读取和写入。设备文档属于插件安装和设置 ID，在应用重启后保留，并由该安装的客户端界面共享。它们不会同步到其他设备。需要由客户端通过 daemon 共享的数据使用 `scope: "host"`。

## 匹配应用的信息密度 {#match-the-apps-density}

使用 React Native 原语绘制界面。除标签页呈现和菜单外，SDK 不导出侧边栏视图的行、分区、列表、徽标或拖拽辅助组件。现有页眉和页脚组件包属于独立界面。

紧凑行的最小高度为 28，水平内边距为 12；主标签字号为 12、行高为 16，次标签字号为 11。使用以下主题令牌：

| 行元素           | 主题令牌                 |
| ---------------- | ------------------------ |
| 主标签           | `colors.foreground`      |
| 次标签、分区标题 | `colors.foregroundMuted` |
| 选中行背景       | `colors.surface2`        |
| 分隔线           | `colors.border`          |
| 操作或焦点强调色 | `colors.accent`          |
| 成功指示         | `colors.statusSuccess`   |
| 需要输入指示     | `colors.statusWarning`   |
| 失败指示         | `colors.statusDanger`    |

为可点击行提供无障碍标签，并在触摸布局中显示操作控件。示例仅使用插件自己的组件和传给视图的主题令牌。
