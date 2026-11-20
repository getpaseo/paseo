---
title: 入站 webhook
description: 通过已认证的 HTTP POST，从任意外部服务、告警工具或脚本启动 Hub Agent。
nav: Webhook
---

# 入站 webhook {#inbound-webhooks}

入站 webhook 允许任意外部服务、CI 任务、监控告警或脚本向 Hub 发送已认证的 HTTP `POST` 请求，从而在你的 daemon 上启动 Agent。

在自托管 Hub 上，请先配置[公开 HTTPS 地址](/docs/hub/self-hosting#public-addresses)，让外部服务能够访问 webhook 端点。

## 创建 webhook 触发器 {#create-a-webhook-trigger}

在 Hub 控制台触发器编辑器中选择 **Webhook received**，或保存 `.paseo/triggers/alert-handler.yml` 并运行 `paseo hub deploy`：

```yaml
name: alert-handler
enabled: true
on:
  webhook.received: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: new
  max_runtime: 1h
  idle_timeout: 10m
  prompt: |
    Investigate this alert, identify the root cause, and call finish_execution with your summary.
```

`webhook.received` 不接受 `connection` 或 `filters`。webhook 触发器不能声明 `required: true` 的输入。

## 创建或轮换 webhook 密钥 {#create-or-rotate-the-webhook-secret}

保存 webhook 触发器后，Hub 会分配一个形如 `/webhooks/wh_<32-char-id>` 的随机端点路径。

通过以下两种方式之一创建它的 Bearer 密钥：

1. 在 Hub 控制台中打开已保存的触发器，选择 **Create secret**（之后可选择 **Rotate secret**）。请立即复制密钥，Hub 只会显示一次。
2. 通过公开 API，使用具备 `configuration:install` 权限的组织凭据向 `POST /api/v1/triggers/webhook-secret` 发送 `{"triggerId":"<trigger-id>"}`。Hub 返回 `{ "path": "/webhooks/wh_...", "secret": "whsec_..." }`。

轮换密钥会立即使旧密钥失效。使用 `paseo hub deploy` 重新部署同名且包含 `webhook.received` 的触发器时，端点路径和现有密钥都会保留。

## 发送 webhook 请求 {#send-a-webhook-request}

在 `Authorization: Bearer` 请求头中带上密钥并发送 HTTP `POST` 请求：

```sh
curl -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: alert-123" \
  -d '{"alert":"Disk usage over 95%","host":"prod-01"}'
```

成功后，Hub 会保存投递记录、将运行入队，并返回 HTTP `202`：

```json
{
  "status": "accepted",
  "runId": "00000000-0000-4000-8000-000000000000"
}
```

运行记录会以 `webhook.received` 来源出现在 [Activity](/docs/hub/activity) 中。

## 请求限制与响应 {#request-limits-and-responses}

- Hub 接受最大 32 KiB 的 UTF-8 文本请求体，并拒绝包含字面 NUL 字符的请求。
- 当 `Content-Type` 为 `application/json` 或以 `+json` 结尾时，Hub 会校验请求体是否为合法 JSON。省略 `Content-Type` 时默认为 `text/plain`。
- 可传入可选的 `Idempotency-Key` 请求头（最多 200 个不含空格的可打印 ASCII 字符），让重试返回原始 `runId` 而不是启动重复运行。该键按端点隔离。
- 每个端点每分钟最多接受 60 次新投递。

| 状态码 | 含义                                                          |
| ------ | ------------------------------------------------------------- |
| `202`  | 已接受投递并排队运行（`{ "status": "accepted", "runId" }`）。 |
| `400`  | 请求体、`Content-Type`、NUL 字符或幂等键无效。                |
| `401`  | 未知端点，或缺少/无效的 Bearer 密钥。                         |
| `403`  | 组织已用完本月执行额度。                                      |
| `409`  | 触发器已禁用。                                                |
| `413`  | 请求体超过 32 KiB。                                           |
| `429`  | 端点在当前 1 分钟窗口内超过了 60 次新投递。                   |

## 负载如何传递给 Agent {#how-the-payload-reaches-the-agent}

Hub 会将 webhook 请求体和投递元数据（`contentType` 和 `receivedAt`）作为不可信外部数据进行包装。

如果你的 `run.prompt` 没有包含 `${{ paseo.prompt }}`，Hub 会自动将包装后的 webhook 负载追加到指令末尾。如需控制负载在提示词中的位置，在目标位置插入 `${{ paseo.prompt }}` 即可。

如果还需要结构化的 `webhook` 元数据对象（`contentType` 和 `receivedAt`），请包含 `${{ paseo.context }}`。如需将分析结果发送到 Slack 或 Discord，请添加[集成工具](/docs/hub/tools)。
