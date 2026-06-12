# PRD: GitHub PR Review Comments → Fix with Agent

## 1. 背景

Paseo 当前 PR pane 已经能展示 PR 状态、checks、reviews 和 conversation comments，但还不能展示 GitHub PR 中锚定到具体文件和行号的 inline review threads。用户在收到 code review 后，仍需要打开 GitHub、找到每条 inline comment、复制文件路径/行号/评论内容，再手动转述给 agent。

本需求要把这段机械流程产品化：Paseo 从 GitHub 拉取 PR inline review comments，在 PR pane 中让用户选择需要处理的评论，并将结构化上下文派发给 agent 去修改当前 worktree。

原始 issue：https://github.com/getpaseo/paseo/issues/1447

GitHub GraphQL `PullRequestThread` 官方字段说明：https://docs.github.com/en/graphql/reference/objects

GitHub CLI 官方站点：https://cli.github.com/

GitHub CLI 登录命令文档：https://cli.github.com/manual/gh_auth_login

Paseo RPC 命名规范：`docs/rpc-namespacing.md`

## 2. Why

### 2.1 用户问题

当 PR reviewer 或 bot 在 GitHub 上留下 inline review comments 时，用户当前流程是：

1. 打开 GitHub PR。
2. 逐条阅读 inline review comments。
3. 回到 Paseo，在对应文件里定位路径和行号。
4. 把 reviewer 的评论、文件路径、行号和相关 diff 手动写进 agent prompt。
5. 等 agent 修改后，再手动回 GitHub 回复或 resolve。

这部分工作低价值、重复、容易漏上下文，正是 Paseo 应该自动化的“agent 工作派发”场景。

### 2.2 为什么不直接让 app 调 `gh`

底层应该使用 `gh` CLI，但执行位置必须在 daemon，而不是 app：

- app 运行在 iOS、Android、browser web、Electron web 等环境，不都具备本机 shell 执行能力。
- `gh auth`、repo remote、当前 worktree `cwd` 都属于 host/daemon 环境。
- Paseo 架构中，本地能力通过 daemon WebSocket RPC 暴露给 app，app 不直接执行本机 CLI。
- server 已有 `github-service.ts` 通过 `gh api graphql` 拉 PR 数据，应复用该模式。

结论：**daemon 内部直接用 `gh` CLI；app 只调用结构化 RPC。**

### 2.3 为什么不做 Octokit/token fallback

v1 不引入 Octokit 或 Paseo 自己管理 GitHub token：

- 避免新增 token 存储、刷新、权限申请和安全 UI。
- 避免出现 `gh` auth 与 Paseo token auth 两套状态。
- 与现有 GitHub 功能保持一致，继续依赖 host 上的 `gh` 登录状态。
- 缺失 `gh` 或未登录时，给用户明确可执行的修复路径。

## 3. What

### 3.1 用户可见能力

在 PR pane 中新增 **Review comments** 区块：

- 展示当前 PR 的 GitHub inline review threads。
- 默认只展示 unresolved 且 current 的 threads。
- resolved 或 outdated threads 不进入默认 actionable list。
- 按文件路径分组，每个文件组标题提供 per-file 全选入口。
- 每条 thread 展示：
  - 文件路径。
  - 行号或行号范围。
  - reviewer。
  - 最新评论正文。
  - reply count。
  - 锚定 diff hunk 预览（syntax-highlighted）。
- 用户可以选择一条或多条 threads（具体选择交互模式由实现决定）。
- 底部 sticky 全局 action bar 显示：`Fix N comment(s) with agent`。
- 点击后将选中 threads 格式化为 prompt，注入当前 workspace 的活跃 agent；用户可选择手动新开 agent。

### 3.2 Agent prompt 格式

单条 thread：

````markdown
[PR review comment]
File: <relative-file-path>
Lines: <start>–<end>
Reviewer: <author>

```<language>
<diffHunk verbatim>
```

<reviewer's comment text>
````

多条 threads：

````markdown
Address the following <N> PR review comments:

[PR review comment]
File: <relative-file-path>
Lines: <start>–<end>
Reviewer: <author>

```<language>
<diffHunk verbatim>
```

<reviewer's comment text>

[PR review comment]
...
````

### 3.3 Server RPC

新增 dotted RPC（遵循 `docs/rpc-namespacing.md`：Domain → Provider → Operation → Direction）：

- `pr.github.get_review_threads.request`
- `pr.github.get_review_threads.response`

命名理由：

- Domain: `pr`（PR 相关操作）。
- Provider: `github`（GitHub 实现；未来 GitLab 为 `pr.gitlab.*`）。
- Operation: `get_review_threads`（动词，规范要求 operation segment 使用动词而非名词）。

Request：

```ts
{
  type: "pr.github.get_review_threads.request";
  cwd: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  requestId: string;
}
```

Response：

```ts
{
  type: "pr.github.get_review_threads.response";
  payload: {
    cwd: string;
    prNumber: number;
    threads: PullRequestReviewThread[];
    error: PullRequestReviewThreadsError | null;
    requestId: string;
    githubFeaturesEnabled: boolean;
  };
}
```

Thread shape：

```ts
interface PullRequestReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: PullRequestReviewThreadComment[];
}

interface PullRequestReviewThreadComment {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: number;
}
```

### 3.4 Capability gate

在 `server_info.features` 增加：

```ts
prReviewThreads: boolean;
```

带兼容注释：

```ts
// COMPAT(prReviewThreads): added in v0.1.X, drop the gate when floor >= v0.1.X.
```

客户端行为：

- flag 为 true：启用 review comments 查询和 UI。
- flag 缺失或 false：不发 RPC，请用户更新 host。
- 不用旧 timeline RPC 模拟 inline comments。

### 3.5 GitHub service

在 `packages/server/src/services/github-service.ts` 新增：

- GraphQL query：`PULL_REQUEST_REVIEW_THREADS_QUERY`。
- 方法：`getPullRequestReviewThreads()`。
- Zod parser：defensive parse GitHub response。
- 错误映射：将 CLI 缺失、未登录、权限不足、PR 不存在、未知错误映射为结构化错误。

GraphQL 字段：

```graphql
query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          startLine
          diffHunk
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              body
              url
              createdAt
              author {
                login
                url
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
}
```

v1 若超过 100 条 threads 或 comments，可设置 `truncated: true` 或后续补分页；若实现成本可控，优先实现分页。

## 4. For

### 4.1 For 用户

- 在一个 PR pane 内看到 actionable review comments。
- 选择多条评论后一次派发给 agent。
- 不需要复制 GitHub 评论、文件路径、行号、diff hunk。
- 修改仍发生在当前 workspace/worktree，用户保留 review、commit、push、reply 的控制权。

### 4.2 For agent

agent 获取结构化、可定位上下文：

- 文件路径。
- 绝对行号或行号范围。
- reviewer 身份。
- 原始 diff hunk。
- 评论正文。

这比“用户自然语言转述”更稳定，降低误改文件或漏处理评论的概率。

### 4.3 For 产品边界

v1 只做：

- GitHub only。
- Inline review threads only。
- Read-only GitHub fetch。
- Manual selection。
- Dispatch one new agent for selected threads。

v1 不做：

- GitLab / Bitbucket。
- GitHub write-back。
- Reply comments。
- Resolve threads。
- Auto commit。
- Auto push。
- Batch across PRs。
- Persist review thread state。

## 5. 兜底和错误处理

### 5.1 旧 daemon

条件：`server_info.features.prReviewThreads` 缺失或 false。

行为：

- app 不发送 `github.pr.get_review_threads.request`。
- PR pane 显示：`Update the host to use PR review comments.`

原因：旧 daemon 没有新 RPC，不能用 timeline 模拟 inline review threads。

### 5.2 缺少 `gh` CLI

条件：daemon 找不到 GitHub CLI。

Server error：

```ts
{ kind: "missing_cli", message: string }
```

UI 文案：

`GitHub CLI is required to pull PR review comments. Install gh on the host, then retry.`

链接：https://cli.github.com/

### 5.3 `gh` 未登录

条件：`gh` 存在，但 GitHub 认证失败。

Server error：

```ts
{ kind: "auth_required", message: string }
```

UI 文案：

`GitHub CLI is not authenticated. Run gh auth login on the host, then retry.`

链接：https://cli.github.com/manual/gh_auth_login

### 5.4 权限不足

条件：GitHub 返回 forbidden 或 repository 不可访问。

Server error：

```ts
{ kind: "forbidden", message: string }
```

UI 文案：

`GitHub CLI cannot access this PR. Check repository permissions.`

### 5.5 PR 不存在或身份无效

Server error：

```ts
{ kind: "not_found", message: string }
```

或：

```ts
{ kind: "invalid_identity", message: string }
```

UI 文案：

`PR review comments could not be loaded for this workspace.`

### 5.6 临时错误

Server error：

```ts
{ kind: "unknown", message: string }
```

UI 行为：

- 显示 retry。
- 不 fallback 到 PR timeline。
- 不自动重试无限次。

## 6. UX 细节

### 6.1 空状态

没有 actionable threads 时：

`No unresolved review comments.`

### 6.2 Loading 状态

首次加载：

`Loading review comments…`

刷新：

保留旧数据，显示 subtle refresh indicator。

### 6.3 Selection

- selection key 使用 thread id。
- 数据刷新后尽量保留仍存在的 thread selection。
- thread resolved/outdated 后从 actionable list 消失，并从 selection 中移除。

### 6.4 Dispatch 行为

v1 默认将 prompt 注入当前 workspace 的活跃 agent。用户可选择手动新开 agent。

原因：

- 复用活跃 agent 减少上下文切换，agent 已有 workspace 文件理解。
- 用户想隔离时随时可手动新开，保留控制权。
- 与 issue 原始倾向一致。

## 7. 实现计划

### 7.1 Protocol

- 新增 request schema。
- 新增 response schema。
- 新增 error schema。
- 新增 exported types。
- 新增 `server_info.features.prReviewThreads`。
- 新增协议 schema tests。

### 7.2 Server

- 在 GitHub service 中新增 GraphQL query。
- 新增 parser 和 mapper。
- 新增 `getPullRequestReviewThreads()`。
- 新增 session dispatch case。
- 新增 handler：验证 PR identity、验证 auth、调用 service、emit response。
- 新增 unit tests。

### 7.3 Client

- daemon client 新增 `pullRequestReviewThreads()`。
- 新增 client test，确认 request/response type、timeout、requestId。

### 7.4 App data

- 新增 `use-pr-review-threads-query.ts`。
- 复用 PR identity 抽取逻辑。
- 集中处理 capability gate。
- 新增 hook tests。

### 7.5 App UI

- PR pane 新增 Review comments section。
- 新增 grouped view。
- 新增 selection state。
- 新增 action bar。
- 新增 prompt builder。
- 调用 `createAgent()` 派发。
- 新增 component/prompt tests。

## 8. 验收标准

- PR pane 显示 Review comments section。
- 默认只展示 unresolved 且非 outdated 的 inline review threads。
- 按文件路径分组，每个文件组提供 per-file 全选入口。
- 每条 thread 展示 file path、line range、syntax-highlighted diff hunk、reviewer、comment body。
- 用户可以选择一条或多条 threads。
- 底部 sticky 全局 action bar 显示 `Fix N comment(s) with agent`。
- 点击后将选中 threads 的结构化 prompt 注入当前 workspace 的活跃 agent；用户可选择手动新开 agent。
- prompt 包含所有选中 threads 的 file path、line range、reviewer、diff hunk、comment text。
- client 无 PR identity 时不发送 RPC，不显示 review comments section。
- 旧 daemon 显示升级 host 提示，不发送新 RPC。
- 缺少 `gh` CLI 时显示安装提示。
- `gh` 未登录时显示 `gh auth login` 提示。
- 不发生 GitHub write-back。
- 不 commit、不 push。
- tests 覆盖协议、service parser、client RPC、hook gate、prompt builder、selection UI。

## 9. 可证明依据

- issue 原始需求：https://github.com/getpaseo/paseo/issues/1447
- GitHub `PullRequestThread` 官方字段：https://docs.github.com/en/graphql/reference/objects
- GitHub CLI 官方安装入口：https://cli.github.com/
- GitHub CLI 登录文档：https://cli.github.com/manual/gh_auth_login
- Paseo RPC 命名规范：`docs/rpc-namespacing.md`
- 现有 GitHub service 使用 `gh api graphql` 的实现位置：`packages/server/src/services/github-service.ts`
- 现有 daemon client 创建 agent 入口：`packages/client/src/daemon-client.ts`

## 10. 无法证明但已明确标注

- Superconductor 内部 review-thread 存储和派发实现不可从当前 worktree 中证明。
- 本 PRD 只参考 Superconductor CLI 暴露出的产品心智：review item 具有 file、line range、author/provider、status，并可作为 agent 工作输入。
