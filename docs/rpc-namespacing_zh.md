# RPC 命名空间

新的 WebSocket 会话 RPC 使用点分隔名称，方向作为最后一段：

```ts
checkout.github.set_auto_merge.request;
checkout.github.set_auto_merge.response;
```

命名空间从左到右阅读：

- 领域：`checkout`
- 提供方或子系统：`github`
- 操作：`set_auto_merge`；此段是动词，而非名词。如果你会将 RPC 命名为 `noun.request`，那就改为 `get_noun.request`。
- 方向：`request` 或 `response`

使用点，而非斜杠。点是协议命名空间；斜杠暗示路径或传输路由。

## 请求/响应对

对于普通的关联 RPC，`.request` 有一个相同前缀的匹配 `.response`。守护进程客户端可以机械地推导响应类型：

```ts
checkout.github.set_auto_merge.request;
// -> checkout.github.set_auto_merge.response
```

大多数新 RPC 应遵循此形态。如果请求没有一对一的响应，请在 schema 附近的代码中明确指出。

## 消息形态

请求将其参数放在顶层：

```ts
{
  type: "checkout.github.set_auto_merge.request",
  cwd: "/repo",
  enabled: true,
  mergeMethod: "squash",
  requestId: "req_123"
}
```

响应将关联的结果数据放在 `payload` 下：

```ts
{
  type: "checkout.github.set_auto_merge.response",
  payload: {
    cwd: "/repo",
    enabled: true,
    success: true,
    error: null,
    requestId: "req_123"
  }
}
```

在请求和响应载荷中都保留 `requestId`。它是关联键。

## 提供方命名空间

提供方特定的行为归属于提供方段下：

- `checkout.github.*` 用于 GitHub 特定的 checkout 操作
- `checkout.gitlab.*` 用于未来的 GitLab 特定的 checkout 操作

不要将 GitHub 特定的枚举或语义放入通用的 checkout RPC 名称中。通用 RPC 只应在行为真正是提供方无关时才存在。

## 兼容性

现有的扁平 RPC 名称在被有意迁移之前仍然是协议的一部分：

```ts
checkout_pr_merge_request;
checkout_pr_merge_response;
```

不要添加新的扁平名称。迁移旧 RPC 时，请注意协议兼容性规则：

- 先添加新名称。
- 当旧宿主机无法支持时，通过 `server_info.features.*` 来门控新功能行为。
- 在兼容窗口到期之前，保留接受旧名称。
- 用 `COMPAT(...)` 和移除日期标记兼容层。
