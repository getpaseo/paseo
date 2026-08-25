# Android

## 应用变体

由 `packages/app/app.config.js` 中的 `APP_VARIANT` 控制（原生 Expo，无自定义 Gradle 插件）：

| 变体          | 应用名称    | 包 ID            |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

EAS 配置文件：`packages/app/eas.json` 中的 `development`、`production` 和 `production-apk`。

`development` 使用 Android `debug`。

## 本地构建 + 安装

从仓库根目录：

```bash
npm run android:development    # Debug 构建
npm run android:production     # Release 构建
npm run android:clear          # 移除生成的 Android 项目
```

或从 `packages/app`：

```bash
# Debug
npx cross-env APP_VARIANT=development expo prebuild --platform android --non-interactive
npx cross-env APP_VARIANT=development expo run:android --variant=debug

# Release
npx cross-env APP_VARIANT=production expo prebuild --platform android --non-interactive
npx cross-env APP_VARIANT=production expo run:android --variant=release

# 清除生成的 Android 项目
rm -rf android
```

### React 版本同步

将 `react` 和 `react-dom` 锁定到当前 `react-native` 版本内嵌的 React 版本。React Native `0.81.x` 内嵌 `react-native-renderer` `19.1.0`，因此 `packages/app` 必须使用 React `19.1.0`。将 React 升级到更新的补丁版本可能构建成功，但在 Android 上 JS 启动时会因 `Incompatible React versions` 崩溃，使应用卡在原生的启动画面上。

## 截图

```bash
adb exec-out screencap -p > screenshot.png
```

## 云构建 + 提交（EAS）

像 `v0.1.0` 这样的稳定标签推送会触发：

- Expo 服务器上的 EAS GitHub 应用（iOS + Android 生产构建 + 商店提交）。本仓库中没有对应的工作流文件。
- GitHub Actions 上的 `.github/workflows/android-apk-release.yml`（GitHub Release 上的 APK 资产）。

iOS 通过 Fastlane lane 在 EAS 上传到 TestFlight 后自动提交到 App Store 审核。Android 通过 EAS 管理的凭证自动提交到 Play Store。

像 `v0.1.1-beta.1` 这样的 Beta 标签只触发 GitHub APK 工作流。它们发布一个 GitHub 预发布 APK 用于测试，不提交到商店。

`android-v*` 标签也只触发 GitHub APK 工作流——当你希望发布 APK 而不经过商店时很有用。GitHub APK 工作流支持带有现有 `tag` 输入的 `workflow_dispatch`，因此你可以在不创建新标签的情况下重新构建。

### 常用命令

```bash
cd packages/app

# 最近的构建
npx eas build:list --limit 10 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# 检查构建（打印的 `Logs` URL 打开构建的 Expo 仪表板页面，
# 其中有一个 Submissions 部分显示到 Play Store 的自动提交）。
npx eas build:view <build-id>
```

Play Console（Internal testing → Production tracks）是二进制文件已到达商店的最终确认。

参见 [docs/release.md](release.md) 了解完整的移动端构建守护流程。
