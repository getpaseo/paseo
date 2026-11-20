---
title: Hub 公开 API
description: 使用组织凭据校验和安装触发器、轮换 webhook 密钥、派发手动运行并注册 daemon。
nav: 公开 API
---

# Hub 公开 API {#hub-public-api}

Hub 公开 API 让脚本和 CI 流水线能够管理一个组织的触发器、webhook 密钥、手动运行和 daemon 注册。请将 `PASEO_HUB_URL` 设为你的 Hub 地址，例如 `https://hub.example.com`。

## API 参考 {#api-reference}

- [交互式 API 参考](https://hub.paseo.sh/api/reference)
- [OpenAPI 3.1 文档](https://hub.paseo.sh/api/openapi.json)

自托管 Hub 在自己的地址下提供相同的 `/api/reference` 和 `/api/openapi.json` 端点。

## 认证 {#authentication}

交互式 CLI 访问请运行 `paseo hub login [origin]`。Paseo 会在 `PASEO_HOME` 下为该精确地址保存一个可撤销的组织凭据。

自动化场景请在 Hub 的 **Settings → API keys** 下创建组织 API 密钥。两种凭据都作为 Bearer 令牌发送：

```http
Authorization: Bearer paseo_pk_...
Content-Type: application/json
```

API 密钥限定在单个组织内，并绑定所选的一个或多个权限范围：

| 权限范围                 | 允许的操作                                      |
| ------------------------ | ----------------------------------------------- |
| `configuration:validate` | 列出触发器、列出可解析资源并校验触发器。        |
| `configuration:install`  | 安装触发器，以及创建或轮换触发器 webhook 密钥。 |
| `runs:dispatch`          | 派发已配置的 `manual.run` 触发器。              |
| `daemons:enroll`         | 签发短期 daemon 注册令牌。                      |
| `projects:read`          | 列出组织中的项目。                              |

API 密钥不能用于登录控制台，也不能管理集成或组织成员。

API 错误返回 RFC 9457 `application/problem+json` 格式并带有 `X-Request-ID` 响应头。缺少、无效或已撤销的凭据返回 `401` 和 `WWW-Authenticate: Bearer`：

```json
{
  "type": "https://paseo.sh/problems/unauthorized",
  "title": "Authentication required",
  "status": 401,
  "detail": "Provide an active Paseo organization credential in the Authorization: Bearer header.",
  "code": "unauthorized",
  "requestId": "5e967c44-fc22-4f6d-8fc5-1bbff33121af"
}
```

有效凭据但缺少所需权限范围时，以相同格式返回 `403`。

## 触发器列表、校验与安装 {#trigger-list-validation-and-installation}

- `GET /api/v1/triggers`（`configuration:validate`）列出组织的活动触发器及其可部署的 YAML 文档。
- `POST /api/v1/triggers/validate`（`configuration:validate`）校验单个自包含触发器 YAML 文档，不修改 Hub 状态。
- `POST /api/v1/triggers/install`（`configuration:install`）校验并安装单个触发器，按其 YAML `name` 创建或更新。

`POST /api/v1/triggers/validate` 和 `POST /api/v1/triggers/install` 接受相同的 JSON 请求体：

```json
{
  "yaml": "name: manual-task\nenabled: true\non:\n  manual.run: {}\nrun:\n  target: { daemon: my-macbook, cwd: /workspace }\n  agent: { provider: codex, mode: full-access }\n  prompt: |\n    Complete the task and call finish_execution.\n    ${{ paseo.prompt }}\n  max_runtime: 1h\n  idle_timeout: 5m\n"
}
```

两个端点都会请目标 daemon 校验 `run.agent`，因此该 daemon 必须在线且持有 `hub.execute`。校验成功返回 `200` 和 `{ "name": "manual-task", "valid": true }`。安装成功返回 `201`：

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001",
  "name": "manual-task",
  "revisionId": "00000000-0000-4000-8000-000000000002",
  "version": 1,
  "active": true
}
```

无效 YAML、未知集成或被拒绝的 Agent 设置会返回 `422` 及字段级错误详情。`paseo hub deploy --dry-run` 和 `paseo hub deploy` 会针对 `.paseo/triggers/*.yml` 调用这两个端点。

## Webhook 密钥 {#webhook-secrets}

`POST /api/v1/triggers/webhook-secret`（`configuration:install`）为已保存的 `webhook.received` 触发器创建或轮换 Bearer 密钥。

请求体：

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001"
}
```

成功后 Hub 返回 `200` 及 `Cache-Control: no-store`：

```json
{
  "path": "/webhooks/wh_0123456789abcdef0123456789abcdef",
  "secret": "whsec_..."
}
```

每次调用都会立即替换旧密钥，并且新密钥仅显示一次。向 `/webhooks/wh_...` 发送投递的方式见[入站 webhook](/docs/hub/triggers/webhooks)。

## 手动运行派发 {#manual-run-dispatch}

`POST /api/v1/manual-runs`（`runs:dispatch`）启动一个已配置的 `manual.run` 触发器。`actor` 必须匹配该触发器的 `filters.from_users` 白名单（省略时为 `*`）。

```json
{
  "projectSlug": "default",
  "trigger": "manual-task",
  "actor": "automation",
  "deliveryKey": "manual-task-2026-09-09-001",
  "input": "repo=project investigate the failed sync"
}
```

- `deliveryKey` 提供限定在组织和项目内的持久去重。
- `input` 接受以声明的 `inputs` 对应的 `key=value` 头部开头，后接提示词文本。
- `expectedVersionId` 为可选项，当该版本不再处于激活状态时拒绝派发。

成功后 Hub 返回 `200`：

```json
{
  "deliveryKey": "manual-task-2026-09-09-001",
  "providerEventReceiptId": "00000000-0000-4000-8000-000000000000",
  "triggerRunId": "00000000-0000-4000-8000-000000000000",
  "configuredTriggerName": "manual-task",
  "workflowStatus": "running"
}
```

示例：

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/manual-runs" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "projectSlug": "default",
    "trigger": "manual-task",
    "actor": "automation",
    "deliveryKey": "manual-task-2026-09-09-001",
    "input": "investigate the failed sync"
  }'
```

## Daemon 注册 {#daemon-enrollment}

`POST /api/v1/daemons/enrollment-tokens`（`daemons:enroll`）签发一个 10 分钟后过期的一次性注册令牌。不需要请求体。

```bash
curl --fail-with-body -sS -X POST \
  "$PASEO_HUB_URL/api/v1/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY"
```

响应（`201`）：

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-09-09T12:10:00.000Z"
}
```

`paseo hub connect [origin]` 会自动调用此端点，并用令牌换取 daemon 自己的长期关系凭据。撤销 API 密钥会立即阻止新的 API 调用，并使该密钥签发的未消耗注册令牌失效。

## 密钥与审计记录 {#keys-and-audit-trails}

Hub 仅在创建时显示一次 API 密钥内容。控制台只保留密钥前缀、权限范围、创建时间、最近使用时间和撤销状态。Hub 会在触发器安装、webhook 轮换、手动派发和 daemon 注册令牌中保留密钥归属记录。
