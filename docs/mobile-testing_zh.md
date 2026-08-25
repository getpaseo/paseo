# 移动端测试

## Maestro

Maestro 流程文件位于 `packages/app/maestro/`。可复用的子流程位于 `packages/app/maestro/flows/`。

运行一个流程：

```bash
maestro test packages/app/maestro/my-flow.yaml
```

### 屏幕截图

`takeScreenshot` 写入到**当前工作目录**——无法在 YAML 中配置输出路径。要将截图排除在检出目录之外，请 `cd` 到一个临时目录并使用流程文件的绝对路径：

```bash
FLOW="$(pwd)/packages/app/maestro/my-flow.yaml"
mkdir -p /tmp/maestro-out
cd /tmp/maestro-out && maestro test "$FLOW"
```

`packages/app/maestro/.gitignore` 排除了 `*.png` 作为安全网。

### 元素定位

在组件上使用 `testID` 或 `nativeID`，然后在流程中用 `id:` 定位。优先使用这种方式而非文本匹配——文本匹配会因文案变更而失效。

```tsx
// 组件
<Pressable testID="sidebar-sessions" onPress={onPress}>
```

```yaml
# 流程
- tapOn:
    id: "sidebar-sessions"
- assertVisible:
    id: "sidebar-sessions"
```

### 条件步骤

使用 `runFlow:when:visible` 处理仅在特定元素出现在屏幕上时才执行的步骤：

```yaml
- runFlow:
    when:
      visible:
        id: "sidebar-sessions"
    commands:
      - swipe:
          direction: LEFT
          duration: 300
```

这就是 `flows/dev-client.yaml` 处理仅出现在开发构建中的 Expo dev client 屏幕的方式。

### 不要对正在运行的开发应用使用 launchApp

`launchApp` 会终止并重启应用，这会破坏 Expo dev client 状态和主机连接。对于测试已在运行中的开发应用的流程，**完全省略 launchApp**——直接与屏幕上的内容交互。

仅对需要干净启动的流程（如引导流程测试）使用 `launchApp`。

### 滑动手势

使用 `start`/`end` 搭配百分比坐标来实现精确控制：

```yaml
# 从左边缘滑动以打开侧边栏
- swipe:
    start: "5%,50%"
    end: "80%,50%"
    duration: 300
```

`direction: RIGHT` 更简单但精度较低——用于通用滑动，当起始位置很关键时（边缘手势、避开特定 UI 区域）使用坐标。

### 断言

`assertVisible` 检查**实际屏幕可见性**，而不仅仅是视图树中的存在。在视图树中存在但位于屏幕之外的元素（例如 `translateX: -400`）会正确地导致 `assertVisible` 失败。这使得它在捕获动画 bug 方面非常可靠——状态显示"打开"，但视图在视觉上是隐藏的。

对于异步元素，使用 `extendedWaitUntil`：

```yaml
- extendedWaitUntil:
    visible: ".*Online.*"
    timeout: 90000
```

### Dev Client 处理

两个可复用的流程处理启动后的 Expo dev client 屏幕：

- `flows/launch.yaml` —— 处理 dev launcher，关闭 dev 菜单，断言"Welcome to Paseo"
- `flows/dev-client.yaml` —— 同上，但不断言特定的应用路由

### 到达编辑器

`flows/land-in-chat.yaml` 是获取"进入聊天状态"的标准原语。它执行 `clearState`，运行 `launch.yaml`，点击欢迎屏幕的直连选项，输入 `127.0.0.1:6767`，提交，并等待 `message-input-root`。在此基础上编排任何编辑器级别的 fixture：

```yaml
appId: sh.paseo
---
- runFlow: flows/land-in-chat.yaml
# ...你的场景在此，从就绪的编辑器开始
```

示例见 `image-picker-repro.yaml`。

**对于本地端到端测试，优先使用直连而非中继配对。** 中继需要在输入框中输入 400+ 字符的配对 URL；直连只需 `127.0.0.1:6767`。守护进程在 6767 上监听，模拟器可以直接访问。

### 新工作区创建

Android 工作区创建的回归测试有一个专用测试框架：

```bash
bash packages/app/maestro/test-workspace-create-android-crash.sh
```

对于在启动/连接/侧边栏设置之后开始的短录制：

```bash
bash packages/app/maestro/record-workspace-create-android-focus.sh
```

流程详情记录在 `packages/app/maestro/README.md` 中。重要规则是有效的新工作区断言必须证明重定向已完成：选择一个真实的模型，点击 `Create`，等待 `workspace-header-title`，等待 `message-input-root`，断言 `New workspace` 已消失，并断言 Android redbox 字符串不存在。仅等待编辑器是不够的，因为验证错误后它可能仍在 `/new` 路由上。

新工作区场景应组合使用 `packages/app/maestro/flows/` 中的可复用子流程：

- `android-dev-client.yaml`
- `connect-direct-if-welcome.yaml`
- `open-prepared-project-sidebar.yaml`
- `new-workspace-open-from-sidebar.yaml`
- `new-workspace-select-codex-gpt54.yaml`
- `new-workspace-submit-and-assert-created.yaml`

工作区创建的 shell 脚本在运行 Maestro 之前将这些子流程渲染到一个临时目录中，这使得嵌套的 `runFlow` 路径和 `${PASEO_MAESTRO_*}` 占位符能够协同工作。

### Maestro 输入文本时的注意事项

Maestro 的 `inputText` 逐个字符触发输入。React Native 的**受控** `TextInput` 每次按键都会重新渲染；如果受控输入的状态更新滞后或在输入过程中重新挂载，字符会默默丢失——屏幕上最终显示的是被截断/乱码的"已输入"文本版本。

对于 E2E 流程输入的输入框（主机端点、配对 URL 等），使用**非受控的 ref 支持的输入**：`defaultValue` + `onChangeText` 写入 `useRef`，提交时通过 ref 读取。无需每次按键重新渲染，不会丢失字符。

参见 `pair-link-modal.tsx` 中的模式（`useRef` 支持的 `onChangeText`，无 `value=` prop）。始终在 `inputText` 之后配合 Maestro 的 `assertVisible` 断言输入框的 `id + text`，以便立即捕获回归问题。

### 启动原生呈现器的下拉菜单（iOS）

在 iOS 上，当下拉菜单（`DropdownMenu` / RN `Modal`）的菜单项需要启动原生呈现器如 `PHPickerViewController`（图片选择器）或 `UIDocumentPicker` 时，回调**不得在 `Modal` 仍在关闭期间触发**。UIKit 关闭完成过程跨越 React 卸载之后的多个帧；在关闭中途启动原生呈现器会留下一个不可见的遮罩层，拦截所有后续触摸。

`DropdownMenu` 通过将选中项的 `onSelect` 推迟到 `Modal.onDismiss` 触发（UIKit 级别的关闭完成）来处理此问题，然后在其调用前再加一个小的额外缓冲。参见 `components/ui/dropdown-menu.tsx` 的 `selectItem` / `flushPendingSelect`。

当构建一个组合了下拉菜单与原生呈现器的新组件时，请复用此下拉菜单——不要发明新的时间同步机制。

## 自验证循环

Maestro 只能与应用 UI 交互——它无法切换 iOS 外观、更改语言环境或模拟网络条件。对于依赖系统级状态的 bug，将 Maestro 包装在一个 bash 脚本中，在 Maestro 运行之间处理系统变化。

此模式还让 agent 能够自我验证修复，无需人工用户测试。

### 模式

1. 运行基线 Maestro 流程（确认功能正常工作）
2. 通过 `xcrun simctl` 进行系统级更改（切换外观等）
3. 重新运行 Maestro 流程（确认功能仍然正常）
4. 重复 N 次迭代以捕获间歇性失败

脚本在临时目录中运行 `maestro test`，因此截图不会弄脏检出目录。

标准示例见 `packages/app/maestro/test-sidebar-theme.sh`：

```bash
bash packages/app/maestro/test-sidebar-theme.sh 6 1
# 参数：iterations=6, wait_seconds=1（切换与测试之间的等待时间）
```

脚本模式的关键要素：

```bash
set -euo pipefail
ITERATIONS="${1:-3}"

for i in $(seq 1 "$ITERATIONS"); do
  # 切换系统状态
  xcrun simctl ui booted appearance light

  # 等待变化传播
  sleep 1

  # 运行 Maestro 流程并捕获结果
  if maestro test "$FLOW" 2>&1 | tee "$ITER_DIR/test.log"; then
    echo "PASS"
  else
    echo "FAIL"
    xcrun simctl io booted screenshot "$ITER_DIR/failure-state.png"
  fi
done
```

## Unistyles + Reanimated

### 崩溃

将 Unistyles 主题响应样式（`StyleSheet.create((theme) => ...)`）直接应用到 `Animated.View` 上会在主题变化时导致 **"Unable to find node on an unmounted component"**（无法在已卸载的组件上找到节点）。

Unistyles 将样式化组件包裹在 `<UnistylesComponent>` 中，并通过 C++ 修补原生视图属性。Reanimated 也从其 worklet 运行时管理同一个原生节点用于动画变换。当主题变化时，两个系统同时尝试更新该节点，视图崩溃。

### 修复

在 `Animated.View` 上使用普通 React Native `StyleSheet.create` 进行静态定位。将主题相关值通过 `useUnistyles()` 作为内联样式传入：

```tsx
// 错误：Animated.View 上的 Unistyles 动态样式
const styles = StyleSheet.create((theme) => ({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.colors.surfaceSidebar, // 主题响应
    overflow: "hidden",
  },
}));

<Animated.View style={[styles.sidebar, animatedStyle]} />;
```

```tsx
// 正确：静态样式表 + 内联主题值
import { StyleSheet as RNStyleSheet } from "react-native";

const staticStyles = RNStyleSheet.create({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
});

const { theme } = useUnistyles();

<Animated.View
  style={[staticStyles.sidebar, animatedStyle, { backgroundColor: theme.colors.surfaceSidebar }]}
/>;
```

普通 `View` 组件可以安全使用 Unistyles 动态样式——冲突仅限于 `Animated.View`。

## 原生聊天流布局

原生 agent 流使用反转的 `FlatList`，因此聊天布局有三个坐标系统：

- 按时间顺序的流顺序
- 策略排序的数组顺序
- 原生反转单元格的视觉顺序

不要在 React 渲染循环中计算流的相邻项、历史/实时头边界、回复尾部归属、助手块间距或工具序列终止。这些策略位于 `packages/app/src/agent-stream/layout.ts` 中，并在不依赖 React Native 渲染的情况下进行单元测试。

平台特定的流边缘属于 `StreamStrategy`：

- 正向 web 使用最后一个历史项作为历史/实时头边界，并在尾部之前渲染内容
- 原生反转使用第一个历史项作为历史/实时头边界，并补偿反转单元格的子元素顺序

如果聊天尾部在移动端出现重复或出现在助手消息上方，请从 `packages/app/src/agent-stream/layout.test.ts` 开始排查。不要为这类 bug 添加 React Native 渲染器测试；先让纯布局不变性测试失败。

## iOS 模拟器

```bash
# 截取屏幕截图
xcrun simctl io booted screenshot /tmp/screenshot.png

# 深色/浅色模式
xcrun simctl ui booted appearance          # 检查当前模式
xcrun simctl ui booted appearance dark     # 设为深色
xcrun simctl ui booted appearance light    # 设为浅色
```

Expo dev server 日志在运行 `npm run dev` 的 tmux 面板中。守护进程日志位于 `$PASEO_HOME/daemon.log`（参见 [development.md](development.md)）。
