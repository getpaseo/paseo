---
title: Hub 公开 API
description: 使用组织凭据安装触发器、管理旧版配置、发起运行和注册 daemon。
nav: 公开 API
---

# Hub 公开 API {#hub-public-api}

Hub 公开 API 让自动化可以操作一个组织中的触发器、项目和 daemon。下文用 `PASEO_HUB_URL` 表示 Hub 的地址，例如 `https://hub.example.com`。

## API 参考 {#api-reference}

- [交互式 API 参考](https://hub.paseo.sh/api/reference)
- [OpenAPI 3.1 文档](https://hub.paseo.sh/api/openapi.json)

这些是托管版 Paseo Hub 的标准参考端点。自托管的 Hub 在它自己的地址上提供相同的 `/api/reference` 和 `/api/openapi.json` 路径。

## 身份验证 {#authentication}

运行 `paseo hub login [origin]` 获得交互式的 CLI 访问权限。在浏览器中批准后，Paseo 会在 `PASEO_HOME` 下为这个确切的地址保存一个持久、可撤销的组织凭据。未显式指定地址时，CLI 依次使用 `PASEO_HUB_URL`、当前保存的登录，然后是 `https://hub.paseo.sh`。

用于自动化时，请在 Hub 控制台的 **API keys** 下创建组织 API 密钥。两种凭据都是 bearer token：

```http
Authorization: Bearer paseo_pk_...
Content-Type: application/json
```

API 密钥的作用域是组织。拥有该密钥的组织决定了它能访问哪些项目和 daemon 注册令牌；这些请求中不需要添加组织 ID。通过该密钥无法访问其他组织的项目 slug。

每个密钥有一个或多个可选的权限范围：

| 权限范围                 | 操作                                    |
| ------------------------ | --------------------------------------- |
| `projects:read`          | 列出组织中的活动项目。                  |
| `configuration:validate` | 校验触发器或旧版配置，不改变 Hub 状态。 |
| `configuration:install`  | 安装触发器，或替换旧版项目的配置。      |
| `runs:dispatch`          | 为项目发起一个已配置的手动触发器。      |
| `daemons:enroll`         | 签发一个短期有效的 daemon 注册令牌。    |

API 密钥不授予控制台访问权限。它们不能管理连接、项目或组织成员。

CLI 凭据拥有当前 CLI 操作所需的权限范围，并且可以独立于 daemon 关系单独撤销。`paseo hub logout` 会删除当前的本地 CLI 凭据；它不会撤销或断开 daemon 身份。

API 失败时使用 RFC 9457 问题详情格式。缺失、无效或已撤销的凭据返回 `401`，类型为 `application/problem+json`：

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

有效但缺少端点所需权限范围的密钥会以相同格式返回 `403`。

## 触发器校验和安装 {#trigger-validation-and-installation}

`paseo hub deploy --dry-run` 通过 `POST /api/v1/triggers/validate` 校验每个 `.paseo/triggers/*.yml` 文件。`paseo hub deploy` 先校验所有文件，再通过 `POST /api/v1/triggers/install` 逐个安装。

两个端点都接受一份自包含的文档：

```json
{
  "yaml": "name: manual-task\nenabled: true\non:\n  manual.run: {}\nrun:\n  target: { daemon: my-macbook, cwd: /workspace }\n  agent: { provider: codex, model: gpt-5, mode: full-access }\n  prompt: Complete the task and call hub.finish_execution.\n  max_runtime: 1h\n  idle_timeout: 5m\n"
}
```

请使用你的组织中可用的 daemon slug 和 Agent 运行时。两个操作都会请指定的 daemon 检查 Agent，因此它必须已连接并持有 `hub.execute`；它无法运行的 Agent 会作为字段问题报告，而不是在第一次运行时失败。见[保存时会对照 daemon 检查 Agent](/docs/hub/triggers#saving-checks-the-agent-against-the-daemon)。校验需要 `configuration:validate`，并返回 `200` 和 `{ "name": "manual-task", "valid": true }`。

安装需要 `configuration:install`。它按 YAML 中的 `name` 创建或更新组织的触发器，并返回 `201`：

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001",
  "name": "manual-task",
  "revisionId": "00000000-0000-4000-8000-000000000002",
  "version": 1,
  "active": true
}
```

无效的 YAML 或未知的组织资源会返回 `422` 及字段问题。每次安装都是独立的请求；后面的失败不会撤销前面已成功的安装。见[从 CLI 部署](/docs/hub/configuration#deploy-from-the-cli)。

## 项目列表 {#project-list}

`GET /api/v1/projects` 返回 bearer 凭据所属组织中的活动项目。`paseo hub projects` 以表格形式显示项目。使用 `--json` 时，它返回 `{ "origin": "...", "projects": [...] }`，因此即使结果为空，也会记录解析出的 Hub。

```json
{
  "projects": [
    {
      "id": "00000000-0000-4000-8000-000000000000",
      "slug": "my-project",
      "name": "My project"
    }
  ]
}
```

## 旧版配置校验 {#legacy-configuration-validation}

`POST /api/v1/configurations/validate` 接受与配置安装相同的 `projectSlug` 和完整的 `files` 文件包。它执行相同的编译和资源解析，但不会记录修订，也不会改变当前生效的配置。

成功时，Hub 返回 `200`：

```json
{
  "projectSlug": "my-project",
  "valid": true
}
```

`paseo hub deploy --project <slug> --dry-run` 会用与实际部署完全相同的、在本地解析出的请求体调用此端点。

## 旧版配置安装 {#legacy-configuration-install}

`configuration:install` 会校验提供的标准文件包，原样保存编写的文件，并激活一个新的修订。

```http
POST /api/v1/configurations/install
```

请求体：

```json
{
  "projectSlug": "my-project",
  "files": [
    {
      "path": ".paseo/hub.yml",
      "content": "environments:\n  production:\n    kind: daemon\n    daemon: build-server\n    cwd: /workspace\nagents:\n  codex:\n    provider: codex\n"
    },
    {
      "path": ".paseo/workflows/deploy.yml",
      "content": "name: deploy\non: manual.run\nmax_runtime: 2h\nfilters:\n  from_users: [automation]\nsteps:\n  - id: deploy\n    environment: production\n    max_runtime: 90m\n    idle_timeout: 10m\n    agent: codex\n    prompt:\n      - include: partials/safety.md\n"
    },
    {
      "path": ".paseo/workflows/partials/safety.md",
      "content": "Follow the safety checklist."
    }
  ]
}
```

`projectSlug` 选择目标项目；bearer 凭据确定组织。`files` 包含 `.paseo/hub.yml`、每个直接位于目录下的 workflow `.yml`，以及每个被引用的 workflow 片段。Hub 会拒绝缺失、多余、重复、不安全或非标准的路径。

限制：

- 文件包：最多 100 个文件。
- 文件路径：最多 512 个字符。
- 文件内容：最多 1,000,000 个字符。
- 提示词片段：每个最多 1,000,000 字节，总计最多 5,000,000 字节。

成功时，Hub 返回 `201`：

```json
{
  "projectSlug": "my-project",
  "versionId": "00000000-0000-4000-8000-000000000000",
  "version": 3,
  "active": true
}
```

常见的响应有：请求体缺失或格式错误时返回 `400`，密钥所属组织中的项目不活动或未知时返回 `404`，YAML 无效或配置无效时返回 `422`。校验的问题详情包含字段问题。安装失败不会替换当前生效的修订。

示例：

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/configurations/install" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data @configuration-install.json
```

`paseo hub deploy -p <project>` 会用在本地发现的文件包调用这个旧版端点。在没有参数和环境变量凭据时，该命令使用与地址完全匹配的已保存登录。见[从 CLI 部署](/docs/hub/configuration#deploy-from-the-cli)。

## 发起手动运行 {#manual-run-dispatch}

`runs:dispatch` 为项目发起一个已配置的 `manual.run` 触发器。该触发器必须存在于当前生效的配置中，并且 `actor` 必须列在该触发器的 `filters.from_users` 白名单中。

```http
POST /api/v1/manual-runs
```

请求体：

```json
{
  "projectSlug": "my-project",
  "expectedVersionId": "00000000-0000-4000-8000-000000000000",
  "trigger": "deploy",
  "actor": "automation",
  "deliveryKey": "deploy-2026-08-04-001",
  "input": "repo=project investigate the failed sync"
}
```

- `expectedVersionId` 是可选的。提供时，如果该修订已不再生效，Hub 会拒绝这次发起。
- `input` 与 Provider 消息使用的字符串相同：开头的 `key=value` 标记会被解析为声明的输入，其余部分成为 `${{ paseo.prompt }}`。
- `deliveryKey` 对每次发起都应唯一且稳定。Hub 用它进行持久化去重，但不保证恰好发起一次，也不保证重放之前的响应。

成功时，Hub 返回 `200`：

```json
{
  "deliveryKey": "deploy-2026-08-04-001",
  "providerEventReceiptId": "00000000-0000-4000-8000-000000000000",
  "triggerRunId": "00000000-0000-4000-8000-000000000000",
  "configuredTriggerName": "deploy",
  "workflowStatus": "running"
}
```

常见的响应有：请求无效时返回 `400`，触发器不允许该 actor 时返回 `403`，项目、配置或触发器未知时返回 `404`，daemon 离线、预期的配置已不是当前配置或发起冲突时返回 `409`。它们都使用上面的问题详情格式。

示例：

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/manual-runs" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "projectSlug": "my-project",
    "trigger": "deploy",
    "actor": "automation",
    "deliveryKey": "deploy-2026-08-04-001",
    "input": "repo=project investigate the failed sync"
  }'
```

输入类型、默认值、可选值、被拒绝的输入以及手动调用示例，见 [Hub workflow](/docs/hub/workflows)。

## 注册 daemon {#daemon-enrollment}

`daemons:enroll` 为 daemon 签发一个短期有效的注册令牌。这个令牌由 API 密钥签发；它不是 daemon 的长期凭据，也不得当作长期凭据使用。

```http
POST /api/v1/daemons/enrollment-tokens
```

不需要请求体。成功时，Hub 返回 `201`：

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-08-04T12:10:00.000Z"
}
```

令牌在 10 分钟后过期，并在 daemon 注册时被消耗。

`paseo hub connect [origin]` 会使用 `--api-key`、`PASEO_HUB_API_KEY` 或匹配的已保存登录执行此请求，然后把这个一次性令牌传给 daemon 的注册操作。daemon 会生成并保存它自己的关系凭据。

```bash
curl --fail-with-body -sS -X POST \
  "$PASEO_HUB_URL/api/v1/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY"
```

直接使用 API 的调用方可以把返回的令牌传给 daemon 注册协议。Paseo CLI 有意不接受原始注册令牌；`connect` 负责完整的、经过身份验证的单一交换流程。

注册令牌不能重复使用。撤销 API 密钥会立即拒绝之后的 API 请求，并使该密钥签发的所有未消耗的注册令牌过期。撤销与签发之间的竞争会在新令牌被保存之前由 Hub 解决。

## 密钥、权限范围和审计信息 {#keys-scopes-and-audit-information}

完整的 API 密钥只在创建后立即显示一次。请把它保存到你的部署所用的密钥管理器中；Hub 不会再次显示它。控制台只保留密钥的前缀，并显示它所选的权限范围、创建时间、最后使用时间和状态。

密钥在一次有权限范围的 API 操作中成功通过身份验证后，Hub 会更新 `last used`。API 操作会在 Hub 的审计记录中保留密钥归属，因此配置修订、手动发起和 daemon 注册令牌都可以追溯到创建它们的组织密钥。
