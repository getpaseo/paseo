# 发布

所有工作区共享同一个版本号，一起发布。

## 两个步骤

一次发布恰好包含两个步骤。代理完成第一个步骤，用户授权第二个步骤。

**准备阶段**（本地操作，可撤销——由代理完成）：

- 格式化、lint、类型检查全部通过
- 使用 `npm run acp:version-drift:check` 检查 ACP 提供商目录漂移；
  如果过时的 package-runner 版本是预期的，请明确说明，否则运行
  `npm run acp:version-drift:update` 并提交更新后的目录
- 草拟更新日志，展示给用户，等待审核
- 运行发布前健全性检查，将发现的问题提交给用户
- 确认 CI 通过

**执行阶段**（用户说"开始吧"/"go ahead"）：

- 提交已获批准的更新日志
- 运行发布

两个步骤都适用的规则：

- 最后一刻的更改始终需要批准。无一例外。
- 不要在更新日志提交或发布提交中捆绑代码改动。代码补丁放在自己的提交中，独立审查。
- 健全性检查的发现是信息，不是指令。代理将其提交给用户；用户做决定。
- 调用发布技能表示有意开始流程，而非全面授权发布。
- 如果用户要求发布预览，展示预期的更新日志/发布内容并回答问题，但不要提交、打标签、发布或运行发布命令，直到用户明确授权发布。

## 两条路径

从 `main` 分支发布有两种受支持的方式：

1. **直接稳定版发布**：你准备好将当前的 `main` 提交立即发布给所有人。
2. **Beta 流程**：在 `beta` 频道上发布候选版本。Beta 版本会有一个原地更新的更新日志条目（beta 用户会查阅它），仅在明确的 `beta` dist-tag 上发布到 npm，并且永远不会将网站下载目标从最新稳定版移开。

## 标准发布（补丁版本）

在运行任何稳定版补丁发布命令之前：

- 确保预期的发布提交已提交到 `main` 并且工作区是干净的。
- **在启动任何 `release:*` 命令之前，先运行 `npm run format`、`npm run lint` 和 `npm run typecheck`，并提交所有结果更改。** `release:check` 在 `release:prepare` 过程中会运行 `npm install --workspaces --include-workspace-root`，这可能会修改 `package-lock.json`（例如在可选依赖上更改 `"dev": true` 标记）。下一步 `version:all:*` 运行 `npm version`，当工作区有脏文件时会中止。如果这种情况在发布中途发生，你必须在重试之前提交 lockfile 的变动——而提交前的格式化钩子会拒绝仅包含 lockfile 的提交，因为 oxfmt 内部跳过了 `package-lock.json`，但 lefthook 的 glob 依然会匹配到它。通过先运行格式化/lint/类型检查，然后单独运行一次 `release:prepare` 来将任何 lockfile 变动吸收到正常的提交中，再启动发布，来避免这整个麻烦。
- 不要使用 `npm run release:patch` 作为检查当前提交是否真正就绪的替代手段。

```bash
npm run release:patch
```

这会跨所有工作区递增版本号，运行检查，发布到 npm，并推送分支和标签。标签推送会触发 GitHub Actions 上的 `Desktop Release`、`Android APK Release`、`Docker` 和 `Release Notes Sync`。EAS 通过 EAS GitHub 应用检测到相同的标签，并并行启动 iOS 和 Android 商店构建（参见下文的"移动端构建（EAS）"）——此仓库中没有 `release-mobile.yml`。

Docker 工作流在拉取请求和 `main` 分支上从检出的源代码树构建镜像，作为非发布性检查。稳定版 `vX.Y.Z` 标签推送会发布 `ghcr.io/getpaseo/paseo:X.Y.Z` 和 `ghcr.io/getpaseo/paseo:latest`；beta 版 `vX.Y.Z-beta.N` 标签推送仅发布 `ghcr.io/getpaseo/paseo:X.Y.Z-beta.N`，永远不会移动 `latest`。

**发布始终是补丁版本。**"发布 paseo"、"发布稳定版"、"发布正式版"及类似说法始终意味着相对于上一个稳定版的补丁版本号递增。永远不要通过递增次版本号或主版本号来触发构建——次版本号和主版本号递增保留给真正更大的产品版本，并且需要用户明确指示，包含"minor"或"major"字样。如果你发现自己在用 `release:minor` 来重新触发失败的构建，你走错了方向——请改用重试标签（参见下文的"修复失败的发布构建"）。

**稳定版就是稳定版。** 如果用户说"稳定版"或"发布正式版"，不要问他们是否想先发 beta。他们选择了稳定版；将其视为直接的稳定版发布。只有在用户明确说"beta"时才运行 beta 流程。

## 手动分步操作

```bash
npm run typecheck            # 验证你打算发布的确切提交
npm run release:check        # 类型检查、构建、干运行打包
npm run version:all:patch    # 递增版本号，创建提交和标签
npm run release:publish      # 发布到 npm
npm run release:push         # 推送 HEAD 和标签（触发 CI 工作流）
```

## Beta 流程

```bash
npm run release:beta:patch       # 递增到 X.Y.Z-beta.1，发布 npm beta 版，推送提交和标签
# ... 从 GitHub Releases 测试桌面和 APK 预发布资产 ...
npm run release:beta:next        # 可选：发布 X.Y.Z-beta.2、beta.3 等
npm run release:promote          # 将 X.Y.Z-beta.N 提升为稳定版 X.Y.Z
```

- Beta 标签作为 GitHub 预发布发布，例如 `v0.1.41-beta.1`
- Beta 版本使用 `--tag beta` 发布 npm 包，因此 `npm install @getpaseo/cli@beta` 可选择性加入，而普通的 `npm install @getpaseo/cli` 仍然获取 `latest`
- Beta 版本发布桌面资产和 APK 用于测试，但不会触发生产环境的 web/移动端发布流程
- `release:promote` 创建一个新的稳定标签，例如 `v0.1.41`；最终发布绝不会重用 beta 标签
- 桌面资产现在来自 `packages/desktop` 中的 Electron 包
- Beta 版本使用 Electron 的 `beta` 更新频道。稳定频道上的用户仅接收稳定版；beta 频道上的用户接收 beta 版本以及最终发布的稳定版。
- **Beta 版本携带更新日志条目。** Beta 用户会阅读发布说明，因此每个 beta 版会在 `CHANGELOG.md` 中原地更新一条条目（`## X.Y.Z-beta.N`），`Release Notes Sync` 在标签推送时将其镜像到预发布正文中。该条目是过渡性的：提升时会原地覆盖为最终的稳定版条目，因此不会留下任何 `-beta.N` 标题。参见更新日志策略部分。

在以下情况下使用 beta 路径：

- 在向所有人推广之前自己先冒烟测试构建
- 在 Linux 或 Windows 虚拟机中手动测试构建
- 将构建发送给遇到特定问题的用户
- 在决定广泛发布之前迭代 `beta.1`、`beta.2`、`beta.3` 等

## 分阶段发布（稳定频道）

稳定版桌面发布通过基于时间的线性滚动发布进行自动更新检查：更新清单出现时准入率为 0%，36 小时后准入率为 100%，中间线性递增。手动检查绕过滚动发布，因此用户点击**检查**时可以立即安装。Beta 版本完全绕过滚动发布——beta 用户始终立即收到更新。

滚动发布由 `desktop-release.yml` 中的 `finalize-rollout` 作业写入 GitHub Release 清单（`latest-mac.yml`、`latest-linux.yml`、`latest.yml`）的 `rolloutHours` 字段驱动。

桌面发布构建现在分两个阶段发布：

- 平台构建作业将安装程序/包（`.dmg`、`.zip`、`.exe`、`.AppImage` 等）上传到 GitHub release。
- 最终作业合并/标记清单，并在所有 `.yml` 文件已包含最终的 `releaseDate` 和 `rolloutHours` 后上传它们。

更新客户端只能通过这些 `.yml` 清单发现发布，因此在滚动发布元数据出现之前不存在静默的 100% 准入窗口。

### 默认行为

`npm run release:patch` → 标签推送 → 36 小时渐进。无需额外操作。

`desktop-release.yml` 上的 `rollout_hours` 输入**仅在 `workflow_dispatch` 时读取**——标签推送运行始终默认为 36。要在新发布上使用其他滚动时长，请使用下文的发布后切换。

### 即时准入发布（发布时 rollout_hours=0）

对于应立即向所有人开放的发布（低风险更改、仅文档、热修复，或只是你想要快速发布的版本），正常发布并在之后立即排队切换：

```bash
# 1. 发布并推送（标签推送默认 36 小时渐进）。
npm run release:patch

# 2. 立即排队切换——在 finalize-rollout 完成后立即运行。
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.64 \
  -f rollout_hours=0
```

**为什么这没有间隙：** `desktop-release.yml` 的 `finalize-rollout` 作业和 `desktop-rollout.yml` 共享并发组 `desktop-rollout-<tag>`。在标签推送流水线仍在运行时触发 `desktop-rollout.yml` 会安全地将其排在 `finalize-rollout` 之后。首先公开的清单携带 `rolloutHours=36`，然后 `desktop-rollout.yml` 很快将其切换为 `rolloutHours=0`。渲染器每 30 分钟轮询一次，因此活跃的稳定版用户在下一次检查时会获取新清单。

在 `release:patch` 返回后立即运行 dispatch。不要等到标签推送 CI 完成。

### 调整已发布的版本

要更改已发布的版本的滚动时长——例如将热修复切换为即时准入，或减慢发布——请使用专用的 `desktop-rollout.yml` 工作流。它在 GitHub release 上原地编辑清单，不重新构建任何内容。它只重写 `rolloutHours`；`releaseDate` 会被保留，因此滚动时钟从原始发布时间开始继续计时。

**热修复（即时准入）已发布的版本：**

```bash
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.42 \
  -f rollout_hours=0
```

`rollout_hours=0` 在稳定版用户的下一次更新检查时（活跃客户端约 30 分钟内）向 100% 的用户开放。

**减慢发布**（例如将总时长从原始发布起延长到 72 小时）：

```bash
gh workflow run desktop-rollout.yml \
  -f tag=v0.1.42 \
  -f rollout_hours=72
```

`rollout_hours` 是**自原始发布日期起的总时长**，而不是"从现在起再延长 N 小时"。如果 `v0.1.42` 在 2 小时前发布，并且你设置 `rollout_hours=72`，则渐进从现在起 70 小时后结束。

该 dispatch 是幂等的，并与 `desktop-release.yml` 的 `finalize-rollout` 作业共享 `desktop-rollout-<tag>` 并发组，因此它可以安全地与针对同一版本的进行中的标签推送流水线串行化。

### 手动触发构建的自定义渐进

`desktop-release.yml` 仅在 `workflow_dispatch` 时接受 `rollout_hours`，该路径用于**重建现有标签**（重试失败的发布，在不同的引用上强制重建）。当你走这条路时，可以直接标记非默认的渐进：

```bash
gh workflow run desktop-release.yml \
  -f tag=v0.1.43 \
  -f rollout_hours=6
```

这**不**适用于通过 `npm run release:patch` 发布的新版本——该路径始终进行标签推送并标记 36。对于需要自定义渐进的新发布，正常发布然后 dispatch `desktop-rollout.yml`（与上述即时准入流程相同的模式，使用你选择的 `rollout_hours`）。

### 在活跃的滚动发布期间发布

如果你在 N 版本仍在渐进时发布 N+1，N+1 从其自己的发布时间戳开始新的滚动。N 的滚动实际上结束——更新的清单会取代它。

如果 N+1 是 N 版本中某个 bug 的热修复，在 N+1 发布之后 dispatch `desktop-rollout.yml -f tag=v0.1.<N+1> -f rollout_hours=0`，以便已收到 N 版本的用户快速到达修复。

### 限制

- **没有暂停/终止开关。** 一旦稳定版用户被准入，他们将在下次退出时安装更新（`autoInstallOnAppQuit = true`）。要停止新的准入，发布一个取代版本。要"召回"已被准入的用户，发布一个 `+1` 补丁的热修复。
- **没有回滚。** `allowDowngrade = false`。糟糕的发布 = 发布热修复。
- **引导注意事项。** 运行早于滚动发布功能的构建的客户端会忽略 `rolloutHours` 并立即准入。滚动发布保护仅适用于运行支持滚动的版本或更高版本的客户端。
- **最多约 30 分钟的自动准入延迟。** 渲染器每 30 分钟轮询一次，因此稳定版用户可能需要最多这么长时间才能根据滚动窗口进行评估。点击**检查**是手动的，绕过滚动准入。

## 移动端构建（EAS）

iOS 和 Android 商店构建不在 `.github/workflows` 中。它们在 `v*` 标签推送的瞬间由 EAS GitHub 应用触发：

- **Android（Play Store）**——EAS 使用 `production` 配置文件构建，并通过 `eas submit` 自动提交到 Play Store（EAS 管理的凭据，无 Fastlane）。
- **iOS（TestFlight + App Store）**——EAS 使用 `production` 配置文件构建，上传到 TestFlight，然后 Fastlane lane 将构建提交 App Store 审核。
- **Android APK（GitHub Release 资产）**——单独的，通过 `.github/workflows/android-apk-release.yml`。这是本仓库中唯一与 Android 相关的工作流。

此仓库中没有 `release-mobile.yml`。本文档的早期版本曾引用过它——该工作流已被移除，EAS GitHub 应用直接处理标签触发。

### 从终端监控移动端构建

在 `packages/app/` 中使用 EAS CLI：

```bash
cd packages/app

# 最近的构建（最新的在前）。通过管道传给 jq 仅查看状态。
npx eas build:list --limit 8 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# 最近的 EAS 工作流运行。这是提交/审核作业的信息来源。
npx eas workflow:runs --json | jq '.[] | {status, workflowName, trigger, gitCommitHash, startedAt, finishedAt}'

# 按平台过滤。
npx eas build:list --platform ios --limit 5 --non-interactive --json
npx eas build:list --platform android --limit 5 --non-interactive --json

# 检查特定构建。
npx eas build:view <build-id>

# 检查完整的发布工作流，包括 submit_ios、submit_android
# 和 submit_ios_for_review。
npx eas workflow:view <workflow-run-id> --json

# 读取失败的提交/审核作业日志。
npx eas workflow:logs <workflow-job-id> --all-steps --non-interactive

# 流式传输构建日志。
npx eas build:view <build-id> --json | jq '.logFiles[]'
```

构建的 `gitCommitHash` 必须与发布标签提交匹配。`status` 依次经过 `NEW` → `IN_QUEUE` → `IN_PROGRESS` → `FINISHED`（或 `ERRORED`/`CANCELED`）。EAS 工作流运行的 `gitCommitHash` 和 `trigger` 也必须与发布标签匹配。

一旦构建 `FINISHED`，EAS 仍有发布关键工作要做：Android 必须提交到 Play Store，iOS 必须上传到 TestFlight **并**提交构建进行 App Store 审核。在所有平台都进入商店流程之前，发布不算完成。

对于 `Release Mobile` EAS 工作流，以下作业必须通过：

- `build_ios`——iOS 二进制文件已构建
- `submit_ios`——iOS 二进制文件已上传到 App Store Connect/TestFlight
- `submit_ios_for_review`——iOS 构建已通过 Fastlane 提交 App Store 审核
- `build_android`——Android 商店二进制文件已构建
- `submit_android`——Android 二进制文件已提交到 Play Store

不要将 `build_ios: SUCCESS` 或 `submit_ios: SUCCESS` 视为 iOS 发布已完成。`submit_ios_for_review: FAILURE` 意味着即使构建在 TestFlight 中可见，iOS 发布也被阻塞。

要确认提交已落地，使用 `npx eas workflow:view <workflow-run-id> --json` 检查 EAS 工作流。App Store Connect（匹配版本/构建的审核状态）和 Play Console 跟踪是最终的真实来源。

### 发布后照看移动端

用户很少打开 Expo 面板。失败的 EAS 构建或提交/审核作业可能一直静默存在，直到用户抱怨版本过时。在每次稳定版发布之后，设置一个长延迟的照看，重新检查 GitHub Actions、EAS 构建和发布标签的 EAS `Release Mobile` 工作流。如果任何构建是 `ERRORED`/`CANCELED`，任何工作流是 `FAILURE`，或任何必需的提交/审核作业失败，立即报告。如果所有构建都 `FINISHED` 且所有必需的提交/审核作业都 `SUCCESS`，确认并停止。

**对于发布照看，使用 `create_heartbeat`，永远不要使用 `create_schedule`。** 照看会以唤醒提示的形式回调到当前对话中。`create_schedule` 启动一个新的代理，用户需要去找并阅读它；`create_heartbeat` 在拥有该发布的对话中以内联方式展示构建状态，不可能错过。如果你发现自己在为发布照看使用 `create_schedule`，你即将把状态报告发送到虚空。

模式：

```jsonc
// mcp__paseo__create_heartbeat 参数
{
  "name": "vX.Y.Z 发布照看心跳",
  "cron": "*/15 * * * *",
  "maxRuns": 8, // 覆盖约 2 小时的构建和商店提交窗口
  "prompt": "心跳：检查 vX.Y.Z 发布。运行 gh run list、eas build:list、eas workflow:runs 和 eas workflow:view 查看匹配的 Release Mobile 运行。简洁报告。在桌面/APK 工作流通过、EAS 构建 FINISHED、Android submit_android SUCCESS、iOS submit_ios + submit_ios_for_review SUCCESS 之前，发布不算完成。对任何 ERRORED/FAILED/CANCELED/FAILURE 大声报告。",
}
```

有意设置紧密的节奏。第一次运行立即触发，在对话关闭前提供近乎实时的状态检查。后续每 15 分钟运行一次，快速捕获过渡：+20 分钟时 EAS 构建失败或 App Store 审核提交失败不应等到 +50 分钟才被发现。保持提示简短——心跳是状态探测，不是研究任务——并且一旦每个平台实际上都在其商店路径中，就立即退出，以免剩余的运行产生噪音。

## GitHub 上的发布说明

GitHub Release 正文由 `Release Notes Sync` 工作流（`.github/workflows/release-notes-sync.yml`）自动填充。它在每次 `v*` 标签推送时以及每次推送到 `main` 并触碰 `CHANGELOG.md` 时触发，然后运行 `scripts/sync-release-notes-from-changelog.mjs` 将匹配的更新日志条目镜像到发布正文中。你无需在 GitHub 上手动撰写发布说明——保持 `CHANGELOG.md` 正确，工作流会同步它。要强制重新同步，使用标签输入 dispatch 该工作流。

## 网站行为

- 网站下载页面指向 GitHub 最新发布的**稳定版**。
- 已发布的 beta 预发布在 GitHub Releases 上是公开的，但它们**不**会成为网站下载目标。
- 下载目标仅在你发布最终稳定版标签（如 `v0.1.41`）时移动。
- 公共 `/changelog` 页面按原样渲染 `CHANGELOG.md`，因此进行中的 `-beta.N` 条目一旦落在 `main` 上就会在那里显示——这是有意的，这就是 beta 用户查看即将到来的内容的地方。只有**下载目标**保持在最新稳定版上；下载链接读取 GitHub 的 releases API，而非更新日志，因此顶部的 `-beta.N` 标题永远不会影响它们。
- 网站本身由 `Deploy Website`（Cloudflare Workers）部署，在非预发布的 `release: published` 事件以及推送到 `main` 并触碰 `CHANGELOG.md` 或 `packages/website/**` 时重新部署。

## 修复失败的发布构建

**永远不要通过递增版本号来修复构建问题。** 新版本号保留给有意义的产品更改（功能、修复、改进）。构建/CI 失败在当前版本上修复。

**不要依赖 `workflow_dispatch` 来修复标记的代码。** `workflow_dispatch` 触发器从默认分支运行工作流文件，但从标签引用检出代码（`ref: ${{ inputs.tag }}`）。这意味着提交到 `main` 的修复不会更改正在构建的标记源代码树。`workflow_dispatch` 仅在修复存在于工作流文件本身时有效。

对于仅 Docker 的重试，**不要推送或强制推送 `v*` 发布标签**。
`v*` 标签推送会重建桌面资产、Android APK、Docker、发布说明
和 EAS 移动端发布构建。请改用 Docker 工作流 dispatch：

```bash
gh workflow run docker.yml \
  --ref main \
  -f paseo_version=X.Y.Z-beta.N \
  -f publish=true
```

这会原地替换 `ghcr.io/getpaseo/paseo:X.Y.Z-beta.N`，而不触碰
桌面、APK 或 EAS 发布构建器。Docker 例外是安全的，因为
dispatch 从 `--ref main` 运行并使用明确的 `paseo_version`；它
不会检出或移动 `v*` 发布标签。

要重试失败的非 Docker 发布工作流，在你想要构建的提交上推送一个重试标签。
重用相同的标签名称是预期行为：使用
`git tag -f ...` 移动它并使用 `--force` 推送，以便工作流重建你
实际想要的提交。

在重建桌面或 APK 发布资产时，优先使用标签推送而非 `workflow_dispatch`。
在仅重建 Docker 镜像时，优先使用 Docker 工作流 dispatch。

下面的重试标签模式仍然有效，并且仍然是重建特定发布目标的支持方式：

```bash
# 桌面（所有平台）
git tag -f desktop-v0.1.28 HEAD && git push origin desktop-v0.1.28 --force

# 桌面（单个平台）
git tag -f desktop-macos-v0.1.28 HEAD && git push origin desktop-macos-v0.1.28 --force
git tag -f desktop-linux-v0.1.28 HEAD && git push origin desktop-linux-v0.1.28 --force
git tag -f desktop-windows-v0.1.28 HEAD && git push origin desktop-windows-v0.1.28 --force

# Android APK
git tag -f android-v0.1.28 HEAD && git push origin android-v0.1.28 --force

# Beta
git tag -f v0.1.29-beta.2 HEAD && git push origin v0.1.29-beta.2 --force
```

这确保检出的引用与 `main` 上包含修复的实际代码匹配。

- `vX.Y.Z` 或 `vX.Y.Z-beta.N` 重建完整的标记发布
- `desktop-vX.Y.Z` 仅为所有桌面平台重建桌面
- `desktop-macos-vX.Y.Z`、`desktop-linux-vX.Y.Z` 和 `desktop-windows-vX.Y.Z` 仅重建该桌面平台
- `android-vX.Y.Z` 仅重建 Android APK 发布

## 注意事项

- `version:all:*` 递增根版本号并同步工作区版本和 `@getpaseo/*` 依赖版本
- `release:prepare` 刷新工作区 `node_modules` 链接以防止过时类型
- `npm run dev:desktop` 和 `npm run build:desktop` 目标为 `packages/desktop` 中的 Electron 桌面包
- 如果 `release:publish` 部分失败，重新运行它——npm 跳过已发布的版本
- 如果 `release:publish:beta` 部分失败，重新运行它——npm 跳过已发布的版本，并通过每次发布使用 `--tag beta` 使预发布版本远离 `latest`
- 网站使用 GitHub 的最新发布 API 获取下载链接，因此已发布的 beta 预发布不会取代稳定版下载目标。

## 更新日志格式

发布说明依赖于更新日志标题格式。标题**必须**严格遵循：

```
## X.Y.Z - YYYY-MM-DD
## X.Y.Z-beta.N - YYYY-MM-DD
```

没有前缀（`v`），没有多余文本。`Release Notes Sync` 匹配推送标签的 `## X.Y.Z`（或 `## X.Y.Z-beta.N`）行以提取版本。格式错误的标题会破坏该标签的发布说明同步。

## 更新日志策略

- `CHANGELOG.md` 包含稳定版发布和当前的 beta 行。
- 版本的第一个 beta 插入一条顶部条目，如 `## 0.1.60-beta.1 - YYYY-MM-DD`。
- 每个后续 beta 原地更新同一条顶部条目——递增标题（`0.1.60-beta.1` → `0.1.60-beta.2`）并加入其他所有新内容。
- 稳定版提升最后一次原地更新同一条条目：标题改为 `0.1.60`，日期改为提升日。
- 每个版本行一条条目。`-beta.N` 标题是过渡性的——覆盖它，从不追加。不要留下过时的 `-beta.N` 条目，也不要为每个 beta 创建重复条目。
- 它始终涵盖从上一个稳定标签起的完整差异，无论中间发布过多少 beta 版本。

## 更新日志所有权

- **运行发布的代理撰写更新日志条目——beta 或稳定版。** 不要将更新日志交给其他模型或代理。发布代理拥有发布上下文并拥有最终的措辞。
- 从上一个稳定版到 `HEAD` 的差异草拟条目，根据下面的更新日志策略审查它，展示给用户，并在提交前等待批准。每个 beta 刷新同一条条目；提升时从完整的上一个稳定版到 `HEAD` 的差异最后一次刷新它。

## 更新日志语气

更新日志显示在 Paseo 主页上。为**最终用户**撰写，而非开发者。

- **从用户的角度框定一切。** 描述应用中发生了什么变化，而不是代码中发生了什么变化。用户关心的是"工作区立即加载"——而不是组件不再重新挂载。
- **绝不要提及组件名称、内部模块或实现细节。** 不要提 `WorkingIndicator`、`accumulatedUsage`、`reconcileAndEmitWorkspaceUpdates`。也不要提"虚拟化列表"、"重新挂载"、"记忆化"、"防抖"、"模糊排序"、"受控输入"、"非受控输入"——这些是伪装成面向用户文案的实现词汇。
- **具体的错误 → 正确示例**（来自以往发布的真实错误）：

  | 错误（面向实现）                                           | 正确（面向用户）                           |
  | ---------------------------------------------------------- | ------------------------------------------ |
  | 切换布局不再重新挂载活跃代理                               | 分割窗格不再丢失滚动位置                   |
  | 模型、模式和思考选择器——带模糊排序的可搜索虚拟化列表       | 移动端模型选择器更快更直观                 |
  | 移动端表单中的文本输入在快速输入时不再闪烁                 | 移动端表单中输入不再闪烁                   |
  | 紧凑型 web 表单在滑动关闭时不再崩溃                        | 移动端 web 表单在滑动关闭时不再崩溃        |
  | 减少了代理列表中的重新渲染                                 | 代理列表滚动流畅                           |
  | 为搜索输入添加了防抖                                       | 搜索结果不再滞后于输入                     |

  测试：非开发者读者在使用应用时能识别出什么改变了吗？如果他们需要工程师来翻译（"什么是重新挂载？"），那么该条目仍然是面向实现的——将其改写为用户感受到的症状。

- **折叠内部迭代。** 如果在同一版本中添加了某个功能，然后又进行了修复，只需将该功能列为可正常使用。用户从未见过有问题的版本。
- **仅列出相对于上一个稳定版的更改。** 差异是 `v(previous)..HEAD`。如果某些内容在这两个标签之间被引入并修复，它从未发布过——不要提及修复。
  - **常见陷阱：** 从 `git log` 草拟时，每个提交看起来都像是独立的条目——包括在同一发布窗口内落在全新功能之上的"修复 X"提交。在列出 Fixed 条目之前，检查被修复的内容是否本身是本次发布中新增的。如果是，删除该修复项并将其合并到功能条目中。
  - **示例：** 如果发布添加了一个应用内浏览器，并且还包含一个提交 "fix: browser pane keyboard handling no longer steals shortcuts"，**不要**在 Fixed 下列出键盘修复。浏览器是首次发布，因此用户只会看到正常工作的版本。Added 条目已经涵盖它。
- **删除低价值条目。** "工具栏按钮大小一致"太细了。合并小的润色项或删除它们。

## 更新日志简洁性

每个条目必须可在一瞥间扫描。更新日志不是发布文档——它是一个列表。

- **每个条目最多一句话。** 如果一个条目包含两句话，第二句做了应该属于产品文档而非更新日志的工作。删除它。
- **没有结尾句号。** 条目是列表项，不是散文。删除每个条目末尾的句号，包括任何加粗引导词内的句号。`**可配置的终端回滚**` 而不是 `**可配置的终端回滚。**`。
- **每个条目一行。** 如果一个条目在窄列中换行到三行，它太长了。
- **拆分包含多个独立更改的条目。** 如果一个条目使用"和"、"加上"、逗号列表或破折号来串联多个独立的改进，将它们拆分为单独的条目——即使它们共享一个主题或作者。一个条目 = 一个面向用户的更改。
- **修剪限定从句。** 删除"当……时显示提示"、"与 CLI 行为匹配"、"跨常见安装形式"。如果细节不会改变用户是否关心，删除它。
- **以用户能做什么开头，而非机制。** 读者关心能力，不关心它底层如何运作。不要解释 LAN 与 WAN、TLS 握手、IPC、守护进程-中继拓扑或任何用户没有询问的内部概念。"自托管中继可以为公共端点使用不同的 TLS 设置"——而不是"自托管中继支持为公共端点使用单独的 TLS 设置，以便守护进程可以通过 LAN 访问中继，而手机通过公共安全地址访问中继"。如果某个功能确实需要背景知识才能理解，它应属于产品文档，在更新日志中用一行预告。
- **以结果开头。** "Windows：代理从 npm `.cmd` shim 可靠启动……"比"Windows：代理在常见安装形式中可靠启动。Claude、Codex 和 OpenCode 现在正确启动……"更好。
- **归属跟随拆分。** 当你拆分一个密集条目时，将每个 PR/作者移动到其所属的条目。绝不要跨多个条目重复相同的 PR。

## 更新日志归属

每个更新日志条目必须注明贡献者并链接到交付更改的 PR。这不是一行一个 PR——一个条目描述一个面向用户的更改，可能引用多个 PR。

格式：在每个条目末尾附加 `([#123](https://github.com/getpaseo/paseo/pull/123) by [@user](https://github.com/user))`。对于跨多个 PR 或贡献者的更改：

```markdown
- 语音模式现可在平板电脑上正常工作，并具有正确的麦克风权限。([#210](https://github.com/getpaseo/paseo/pull/210), [#215](https://github.com/getpaseo/paseo/pull/215) by [@alice](https://github.com/alice), [@bob](https://github.com/bob))
```

规则：

- **始终链接 PR 编号** 为 `[#N](https://github.com/getpaseo/paseo/pull/N)`。
- **始终链接贡献者的 GitHub 个人资料** 为 `[@user](https://github.com/user)`。
- **一个条目 = 一个面向用户的更改**，无论涉及多少个 PR。将相关 PR 归入同一条目。
- **去重贡献者。** 如果同一个人在一个条目中创作了多个 PR，只列出一次。
- **仅标注外部贡献者。** 跳过 [@boudra](https://github.com/boudra) 的归属。更新日志标注社区贡献——核心团队工作是默认的。
- **标注提交作者，而非 PR 开启者。** 维护者经常开启一个 PR，其中包含其他人创作的工作（cherry-pick、贡献者分支的 rebase、从堆叠 PR 中手动提取）。squash 提交保留原始提交的作者，但 `gh pr view N --json author` 返回的是 PR 开启者——使用该字段会默默地将工作错误归属给维护者（然后"跳过 @boudra"规则会完全删除归属）。始终从提交作者解决问题。

  使用此命令获取每个 PR 的 GitHub 登录名：

  ```bash
  gh pr view N --json commits --jq '[.commits[].authors[].login] | unique | .[]'
  ```

  这会返回 PR 中创作或共同创作提交的每个不同的 GitHub 登录名。使用这些登录名进行归属。仅当 commits 命令没有返回任何内容时（对于已合并的 PR 不应发生），才回退到 `gh pr view N --json author`。

  在列出 PR 编号时，`git log --format='%H %s' v<previous>..HEAD | grep -E '\(#[0-9]+\)$'` 从 squash 提交主题中提取 PR 编号。

## 更新日志排序

每个部分（Added、Improved、Fixed）内的条目按用户影响排序：

1. **面向用户的功能和更改优先**——用户会注意到的、想要尝试的或改变他们工作流程的内容。
2. **体验质量改进**——润色、性能、更流畅的交互。
3. **内部/基础设施更改最后**——仅在有切实用户收益时才包含（例如"更快的启动速度"是面向用户的，即使修复是内部的）。

## 发布前健全性检查

在发布**稳定版**之前，发布代理审查差异作为发布 bug 的最后一道防线。对 beta 版本跳过此步骤——beta 本身就是冒烟测试，在每次 beta 发布时用代码审查作为门槛违背了将 beta 作为快速发布候选的初衷。

审查最新发布标签和 `HEAD` 之间的差异。重点关注：

1. **破坏性更改**——特别是在 WebSocket 协议、代理生命周期和任何服务端↔客户端合约中。
2. **向后兼容性**——重要的方向是旧应用客户端与更新的守护进程通信。用户先更新桌面和守护进程，然后继续使用旧应用一段时间。标记任何破坏旧客户端与新守护进程通信或需要双方同步更新的内容。
3. **回归**——任何可能破坏现有功能的内容。

使用 `git diff <latest-release-tag>..HEAD` 作为审查输入。这是一个深度健全性检查，而非完整的代码审查。如果任何内容看起来有风险，在继续之前进行调查并将发现提交给用户。

## 更新日志范围

更新日志始终覆盖**上一个稳定版到 `HEAD`**，beta 和稳定版都是如此：

- **Beta 发布**：条目覆盖 `previous stable tag → HEAD`。更新当前的原地 beta 条目；不要为每个 beta 创建新条目。
- **稳定版提升**：同一条目原地提升。它仍然捕获从上一个稳定版起的完整差异，而不仅仅是自上一个 beta 以来的变化。

Beta 是沿途的检查点；条目是从一个稳定版到下一个稳定版的单一记录，而 beta 用户在此期间阅读它。

## 完成检查清单

### Beta 发布

- [ ] 工作区干净且预期提交在 `main` 上
- [ ] 在 `CHANGELOG.md` 中更新原地 beta 条目（标题 `## X.Y.Z-beta.N - YYYY-MM-DD`），根据更新日志策略审查它，获得批准，并在发布前提交
- [ ] `npm run release:beta:patch`（或 `:next`）成功完成
- [ ] npm 在 `beta` dist-tag 下显示版本，而非 `latest`
- [ ] `v*-beta.N` 标签的 GitHub `Desktop Release` 工作流通过
- [ ] 同一标签的 GitHub `Android APK Release` 工作流通过
- [ ] GitHub `Release Notes Sync` 将 beta 条目镜像到预发布正文

### 稳定版发布（或提升）

- [ ] 运行发布前健全性检查（参见上文）并处理任何发现
- [ ] 在运行任何 `release:*` patch/promote 命令之前，确保预期发布提交已提交且 git 工作区干净
- [ ] 在运行任何 `release:*` patch/promote 命令之前，确保本地 `npm run typecheck` 在该确切提交上通过
- [ ] 使用面向用户的发布说明更新 `CHANGELOG.md`（功能、修复——而非重构）。从 beta 提升时，原地覆盖现有的 `## X.Y.Z-beta.N` 标题（标题 → `X.Y.Z`，日期 → 提升日）——不要在 beta 条目之上添加新条目
- [ ] 验证更新日志标题遵循严格的 `## X.Y.Z - YYYY-MM-DD` 格式
- [ ] `npm run release:patch` 或 `npm run release:promote` 成功完成
- [ ] `v*` 标签的 GitHub `Desktop Release` 工作流通过
- [ ] 同一标签的 GitHub `Android APK Release` 工作流通过
- [ ] 同一标签的 EAS `Release Mobile` 工作流通过
- [ ] 同一标签的 EAS iOS `build_ios` 完成
- [ ] EAS iOS `submit_ios` 成功，将构建上传到 App Store Connect/TestFlight
- [ ] EAS iOS `submit_ios_for_review` 成功，将构建提交 App Store 审核
- [ ] 同一标签的 EAS Android `build_android` 完成
- [ ] EAS Android `submit_android` 成功，将构建放到其 Play Store 轨道上
