# Agent 生命周期

Agent 如何被创建、运行、成为子 agent、被归档以及从 UI 中消失。此模型涵盖 daemon（生命周期、归档）和客户端（标签页、子 agent 轨道）。

## 状态

```
initializing → idle → running → idle（或 error → closed）
                 ↑        │
                 └────────┘  （agent 完成一个轮次，等待下一个提示）
```

`AgentManager` 中的每个 agent 携带 `lastStatus`：`initializing`、`idle`、`running`、`error` 或 `closed`。状态转换持久化到磁盘并通过 WebSocket 流式传输给订阅的客户端。

## 关系

Agent 可以通过 agent 作用域的 `create_agent` MCP 工具启动其他 agent。Agent 作用域的创建始终是异步的。`relationship` 和 `workspace` 是独立的决定：

- `relationship` 决定新 agent 是否归属于调用者。
- `workspace` 决定新 agent 驻留在哪里以及是否创建新的工作区/worktree。

`relationship: { kind: "subagent" }` 将创建的 agent 标记上 `paseo.parent-agent-id`，指向创建 agent。客户端将其显示为 `agent.parentAgentId`。这需要一个 agent 作用域的 MCP 会话。

`relationship: { kind: "detached" }` 创建一个兄弟/根 agent（例如交接、即发即忘的委托）。Daemon 可能仍然使用创建 agent 进行 cwd/config 继承，但它不会写入 `paseo.parent-agent-id`。

- **子 agent** —— 作为创建 agent 工作的一部分存在，出现在该 agent 的子 agent 轨道中，并随其一起归档。
- **分离的 agent** —— 独立存在，不出现在创建 agent 的子 agent 轨道中，不随其一起归档。

`workspace: { kind: "current" }` 使用调用者的工作区，可以选择性地覆盖运行时 cwd。它需要一个 agent 作用域的 MCP 会话。`workspace: { kind: "create", source: { kind: "directory" | "worktree", ... } }` 为新 agent 创建一个新工作区；worktree 创建通过 Paseo worktree 工作流进行，并用该新工作区 ID 标记 agent。

用户也可以从子 agent 轨道分离现有的子 agent。分离只移除 `paseo.parent-agent-id` 标签：它不会停止、归档、移动或重启 agent。Agent 保持其当前的 `cwd` 和 `workspaceId`，离开前父级的轨道，并且在标签页关闭、工作区活动和未来的父级归档方面表现得像根 agent。

`notifyOnFinish` 对于 agent 作用域的创建和后台提示后续操作默认为 `true`，因为大多数委托的工作需要向创建 agent 报告。仅对真正的即发即忘 agent 或提示将其设置为 `false`。

## 归档

归档是一种**软删除**：agent 记录保留在磁盘上，`archivedAt` 已设置，运行时已关闭，agent 从活动列表中消失。归档是**全局的**——它驻留在服务器上，并传播到每个连接的客户端。

`create_agent_request` 可以选择让 agent 进入 `autoArchive`。在该模式下，daemon 在第一个终端轮次事件（`turn_completed`、`turn_failed` 或 `turn_canceled`）后归档 agent。如果同一请求通过其 `worktree` 字段创建了 Paseo worktree，auto-archive 也会归档该 worktree，这将移除 worktree 内的 agent 记录。

归档通过 `AgentManager.archiveAgent`（`packages/server/src/server/agent/agent-manager.ts`）运行：

1. 将当前会话快照到注册表
2. 设置 `archivedAt` 并将 `lastStatus` 从 `running`/`initializing` 规范化
3. 通知订阅者
4. 关闭运行时（如果仍在运行则终止进程）
5. **级联归档子 agent** —— 任何 `paseo.parent-agent-id` 标签匹配已归档 agent 的 agent 也被归档，递归地

级联是为了防止子 agent 舰队在其编排者之后继续存活。

## 标签页 vs 归档

这是两个曾经被混淆的不同概念：

| 概念                       | 范围     | 触发器               |
| -------------------------- | -------- | -------------------- |
| **标签页**（工作区布局）   | 每客户端 | 用户打开/关闭视图    |
| **归档**（生命周期）       | 全局     | 明确的生命周期操作   |

关闭**根 agent** 的标签页仍然会归档——标签页是 agent 的家，所以关闭它意味着"我不再需要这个 agent 了"。确认对话框防止意外归档正在运行的 agent。

关闭**子 agent**（任何带有 `parentAgentId` 的 agent）的标签页**仅影响布局**。Agent 保持未归档状态，并保留在其父级的轨道中。用户可以随时从轨道重新打开标签页。这在 `handleCloseAgentTab`（`packages/app/src/screens/workspace/workspace-screen.tsx`）中实现。

这种不对称是故意的：子 agent 的家是父级的轨道，而不是标签页。标签页是临时的查看槽位；轨道是父级子元素的持久记录。

## 工作区活动

Agent 生命周期状态保持字面意义：即使子 agent 正在运行，父 agent 在自己的轮次空闲时仍然是 `idle`。

工作区状态是一个聚合的活动信号，按**每个 `workspaceId`** 计算：工作区的状态只反映那些 `workspaceId === workspace.id` 的记录。所有权永远不会从 `cwd` 推导——多个工作区可能共享一个目录，同 `cwd` 的兄弟 agent 不会聚集在一个状态下。根 agent 仅将其正常状态桶贡献给它所属的工作区。正在运行的子 agent 为其根父级所属的工作区贡献 `running`（通过父 agent 的 `workspaceId`），而不是子 agent 当前的 `cwd` 或 worktree。非运行中的子 agent 的注意力、权限和错误状态保留在父级的子 agent 轨道中，不会升级工作区桶。

## 子 Agent 轨道

Agent 面板中编辑器上方的可折叠轨道（`packages/app/src/subagents/track.tsx`）。成员规则（`packages/app/src/subagents/select.ts`）：

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

已归档的子 agent 按设计从轨道中消失。要在不关闭标签页的情况下从轨道中移除子 agent，使用行上的**归档按钮（X）**——它打开确认对话框并在确认时归档子 agent。同样的归档操作会使子 agent 在每个连接的客户端上离开轨道。

要保持 agent 存活但将其从父级轨道中移除，使用**分离**。Daemon 清除父级标签，发出正常的 agent 更新，每个客户端根据该更新后的快照将 agent 从子 agent 重新分类为根/兄弟 agent。

## 为什么是这种形式

决定是**仅为子 agent 解耦"关闭标签页"和"归档"**，而不是普遍地：

- **关闭根 agent 的标签页仍然归档**——保留用户已习惯的现有 UX
- **关闭子 agent 的标签页仅影响布局**——修复了"点击阅读，关闭以取消视图，丢失行"的损失性流程
- **轨道行上的归档按钮**——在其主界面中给子 agent 一个明确的生命周期操作
- **轨道行上的分离按钮**——让子 agent 在不终止其工作的情况下独立继续
- **父级归档时的级联归档**——防止子 agent 在父级归档时泄漏

我们考虑了普遍解耦（没有标签页关闭会归档，归档始终是明确的），但拒绝了它：它改变了一个根 agent 用户依赖的行为。

## 限制

### 长期父级下的子 agent 累积

生成许多子 agent 的父级会看到轨道增长。对于已完成的子 agent 没有自动清理——用户通过每行上的归档按钮来修剪。如果这成为真正的问题，可以稍后添加批量操作（例如"归档所有空闲子 agent"）。

### 跨客户端标签页关闭

在一个客户端上关闭子 agent 的标签页不会影响其他客户端的布局。这是解耦标签页的预期行为，与布局一直以来的工作方式一致。归档仍然是跨客户端清理的全局操作。

## 存储

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` 从 agent 的文件系统 `cwd` 派生。它不是工作区 ID；agent 存储保持以 cwd 为键，而工作区标识是不透明的工作区 ID。

每个 agent 是一个单独的 JSON 文件。与本文档相关的字段：

| 字段                               | 类型          | 含义                                                                                  |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `id`                               | `string`      | 稳定标识符                                                                            |
| `archivedAt`                       | `string?`     | 软删除时间戳（ISO 8601）                                                              |
| `labels["paseo.parent-agent-id"]`  | `string?`     | 父 agent ID，由 `create_agent` 在 `relationship.kind === "subagent"` 时自动设置       |
| `lastStatus`                       | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                              |

参见 [`docs/data-model.md`](./data-model.md) 了解完整的 agent 记录。
