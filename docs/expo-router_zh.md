# Expo Router

Paseo 的移动路由树是脆弱的，因为当嵌套的原生路由挂载在错误的布局下时，Expo Router 和 React Navigation 不会大声失败。通常的症状是白屏或空白原生屏幕，没有 JavaScript 崩溃。

在修改 `packages/app/src/app`、启动路由、记住的工作区恢复或活动工作区选择之前，请阅读本文。

## 所有权

每个布局只拥有直接在其目录内的路由。

- 根布局注册 `h/[serverId]`。
- 根布局不注册宿主叶子路由，如 `h/[serverId]/workspace/[workspaceId]`、`h/[serverId]/open-project` 或 `h/[serverId]/index`。
- `packages/app/src/app/h/[serverId]/_layout.tsx` 使用相对屏幕名称拥有宿主叶子路由：`index`、`workspace/[workspaceId]/index`、`agent/[agentId]`、`sessions`、`open-project` 和 `settings`。

当布局注册孙子路由时，Expo Router 会发出 `[Layout children]: No route named ...` 警告。将该警告视为路由树 bug。在原生端，这种结构可能会让嵌套的 index 路由在没有其本地动态参数的情况下挂载，并渲染空白屏幕。

## 启动

根 `/` 路由选择一个宿主边界。它不会直接跳入宿主叶子路由。

- 正确：`/` -> `/h/[serverId]`
- 错误：`/` -> `/h/[serverId]/workspace/[workspaceId]`

`/h/[serverId]` 是宿主主页路由。宿主 index 在记住的选择已水合且工作区尚未被证明缺失后，恢复该宿主的最后记住的工作区。如果没有可恢复的工作区，它转到全局 `/open-project`。

此恢复基于最后导航到的工作区，而不是当前连接状态。不要仅仅因为记住的宿主仍在连接中或离线就重定向到另一个在线宿主；工作区屏幕拥有该离线/加载状态。

这种拆分是故意的。宿主布局必须先挂载，这样原生本地动态参数才能在任何嵌套工作区叶子被选中之前存在。

## 应用级路由跳转

当应用级路由如 `/new`、`/settings` 或 `/sessions` 导航回宿主工作区时，只使用 `navigateToWorkspace()` 表达目的地。不要让调用者根据其当前路由进行分支。

根堆栈拥有 `h/[serverId]`；宿主堆栈拥有 `workspace/[workspaceId]/index`。重复的全局路由跳转必须在宿主路由已经挂载时 `POP_TO` 到根宿主路由并传递嵌套工作区屏幕，否则 Expo Router 可能会追加额外的隐藏工作区 deck 条目。工作区导航辅助函数检查已挂载的导航状态来做出该决定；如果没有宿主路由挂载，它回退到普通路由导航。

那些隐藏条目并非无害：编辑器浮动面板可能针对错误的 deck 进行测量并在屏幕外消失。

隐藏的宿主路由可能在应用级路由在前台时保留其本地参数。活动工作区观察者必须优先选择当前路径名，仅在冷挂载（`/` 或空路径名）期间使用本地参数回退，否则隐藏的工作区可能在设置或历史记录返回之前覆盖记住的工作区。

## 参数

必需的动态参数属于匹配的路由。

不要通过在叶子中读取全局参数来掩盖缺失的必需参数。如果 `useLocalSearchParams()` 缺少必需参数，请修复布局所有权或启动路由结构。

在 `h/[serverId]/_layout.tsx` 匹配后，对于需要宿主 ID 的宿主拥有的叶子，使用宿主路由上下文。不要让叶子通过猜测全局状态来从未匹配的树中恢复。

## App 目录

将非路由模块排除在 `src/app` 之外。Expo Router 将那里的普通 `.ts` 和 `.tsx` 文件视为路由，这会产生 `missing the required default export` 警告并污染路由树。

将共享的路由策略放在 `src/navigation`、`src/utils`、stores 或其他非路由目录中。

## 原生堆栈

将工作区标识和保留排除在原生堆栈的 `getId` 和 `dangerouslySingular` 之外。Expo Router 将 `dangerouslySingular` 映射到 React Navigation 的 `getId`，而 `getId` 通过重新排序已经挂载的工作区屏幕破坏了 Android 原生堆栈/Fabric。

## 回归形状

纯辅助函数测试有用但不够。此处的失败模式是原生路由树状态，因此真正的回归应该使用种子持久化状态启动原生端：

1. 用有效的 `{ serverId, workspaceId }` 种子化 `paseo:last-workspace-route-selection`。
2. 冷启动原生应用。
3. 断言真实屏幕可见，而不是空白树。
4. 断言没有 `[Layout children]` 警告出现。

纯策略测试仍应强制边界拆分：

- 带有已保存工作区的根启动返回 `/h/[serverId]`；
- 带有相同已保存工作区的宿主 index 返回 `/h/[serverId]/workspace/[workspaceId]`；
- 没有可恢复工作区的宿主 index 返回 `/open-project`。

## 检查清单

在落地路由更改之前：

- [ ] 你是否修改了 `packages/app/src/app`？重新阅读本文。
- [ ] 你是否触碰了记住的工作区恢复？保持根路由在 `/h/[serverId]`。
- [ ] 是否有路由返回到工作区？使用 `navigateToWorkspace()`。
- [ ] 你是否添加了路由？在直接拥有它的布局中注册它。
- [ ] `useLocalSearchParams()` 是否丢失了必需参数？修复路由树。
- [ ] 原生端在没有崩溃的情况下显示了空白屏幕？在怀疑 stores、主题或渲染之前，先怀疑路由所有权。
