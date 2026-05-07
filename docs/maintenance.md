# Paseo 本地维护指南

本地开发维护流程——拉取上游代码、合并、构建、安装、重启。

## 问题根源

Paseo daemon 运行在 **npm 安装的包** (`~/.npm-packages/...`) 中，而不是直接从源码运行。新代码变更必须先构建并将编译产物复制到 npm 包位置才能生效。

**症状：**

- `~/.claude/settings.json` 中配置的自定义模型不出现在模型列表中
- 模型列表显示旧版本（没有 `claude-opus-4-7` 等）
- `getClaudeModels()` 是同步函数而不是异步
- 新功能/修复在 `npm run dev` 后不生效

## 维护流程

### 1. 拉取 & 合并

```bash
# 拉取上游变更（使用 rebase 保持历史整洁）
git fetch origin
git pull --rebase origin main

# 如有冲突，解决后：
git add <files>
git rebase --continue

# 确认分支干净
git status
```

### 2. 构建 Daemon

```bash
npm run build:daemon
# 等价于依次构建：
#   npm run build --workspace=@getpaseo/highlight
#   npm run build --workspace=@getpaseo/relay
#   npm run build --workspace=@getpaseo/server
#   npm run build --workspace=@getpaseo/cli
```

### 3. 安装到 npm 包

```bash
cp -r packages/server/dist/* ~/.npm-packages/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/
```

### 4. 验证

```bash
# 确认新代码已生效
grep -c "readCustomModelFromSettings" ~/.npm-packages/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/providers/claude/claude-models.js
# 应返回 2（函数定义 + 调用点）
```

### 5. 重启 Daemon

```bash
# 重启
kill $(lsof -ti :6767) 2>/dev/null
npm run dev --workspace=@getpaseo/server
```

## 快捷命令

```bash
# 一键执行：拉取 + 构建 + 安装 + 重启
git pull --rebase origin main && npm run build:daemon && cp -r packages/server/dist/* ~/.npm-packages/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/ && kill $(lsof -ti :6767) 2>/dev/null && echo "Done"
```

## 故障排查

### 模型列表仍显示旧模型

- 确认 daemon 进程已完全终止：`kill -9 $(lsof -ti :6767)`
- 等待几秒后重新启动

### 构建失败

- 查看错误：`npm run build:daemon 2>&1 | grep -A3 "error TS"`
- 修复源码后重试

### 端口冲突

- 检查端口：`lsof -i :6767`
- 强制终止：`kill -9 $(lsof -ti :6767)`

### iOS 连接超时 — Cloudflare 回源 TLS 剥离

**症状：** 其他设备能连上，iOS 始终超时（10s 无响应）

**根因：** Cloudflare 回源策略配置为"剥离 TLS"（即 origin → Cloudflare 使用 `ws://`），导致：
- 旧 daemon 使用 `wss://`（端口 443 自动省略）— 正常工作
- 新 daemon 使用 `ws://`（端口 443 强制保留）— URL 格式不匹配，relay 返回 400

**修复：**

1. 在 `config.json` 中显式设置 `useTls: true`：
   ```json
   {
     "daemon": {
       "relay": {
         "endpoint": "relay.065739.xyz:443",
         "publicEndpoint": "relay.065739.xyz:443",
         "useTls": true
       }
     }
   }
   ```

2. 如果 Cloudflare 回源策略剥离了 TLS，需要调整 endpoint 格式：
   - 保持 `endpoint` 包含 `:443`（确保 URL 格式一致）
   - `useTls: true` 使 daemon 使用 `wss://`（即使端口号被自动省略）

3. 重启 daemon 验证：
   ```bash
   kill $(lsof -ti :6767) 2>/dev/null
   npm run dev --workspace=@getpaseo/server
   # 检查 daemon.log 确认使用 wss://
   ```

### Relay 连接反复 400 错误

**症状：** daemon.log 中 `relay_control_disconnected` 反复出现，URL 为 `ws://`

**原因：** `useTls` 未显式设置时，自定义 endpoint（非 `relay.paseo.sh`）的 `useTls` 默认为 `false`

**排查：**
```bash
grep "relay_control" ~/.paseo/daemon.log | tail -5
# 对比 URL 是否为 wss://
```

## 重连优化（v0.1.70+）

iOS 客户端断线重连后，daemon 需要：
1. 缓冲断线期间的 agent 事件（`pendingEvents`）
2. 重连时批量刷新事件（`flushReconnectEvents`）
3. 唤醒所有运行中的 agent（`handleReconnectWakeUp`）

**v0.1.70+ 重连 Bug 修复：**

- **Bug 1: 心跳未正确触发重连刷新** — heartbeat 中 `reconnectingAgents` 为空导致 `flushReconnectEvents` 直接返回
  - **修复：** heartbeat 中强制将所有 agent 加入 `reconnectingAgents`，确保 flush 对全部 agent 生效
- **Bug 2: closed agent 被过滤** — `handleReconnectWakeUp` 中 `lifecycle !== "closed"` 排除了 closed agent
  - **修复：** 移除 closed 过滤，closed agent 也可被消息激活

**测试：**
```bash
npx vitest run packages/server/src/server/session.reconnect.test.ts
```

## 自定义模型配置

在 `~/.claude/settings.json` 中配置自定义模型后，daemon 的 `getClaudeModels()` 会自动读取并合并：

```json
{
  "model": "claude-opus-4-7"
}
```

自定义模型会出现在模型列表首位。如果模型 ID 已存在，则不会重复添加。
