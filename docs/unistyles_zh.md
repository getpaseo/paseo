# Unistyles 陷阱

本应用使用 [`react-native-unistyles` v3](https://www.unistyl.es/) 来实现主题感知样式。Unistyles 之所以快，是因为大多数样式更新不会经过 React 渲染：[Babel 插件](https://www.unistyl.es/v3/other/babel-plugin)会重写 React Native 组件导入，附加样式元数据，并让原生 ShadowRegistry 在主题或运行时依赖变化时更新被追踪的视图。

这个模型很强大，但也有尖锐的边界。在添加主题相关样式时请参考本文。

## 停——禁止使用 `useUnistyles()`

**不要调用 `useUnistyles()`。任何地方都不行。新代码不得新增调用；现有的调用点仅因尚未改写而暂时容忍，并将在被触及时代为转换。** 库作者自己[强烈建议不要使用它](https://www.unistyl.es/v3/references/use-unistyles)：

> 我们强烈建议**不要使用**这个 hook，因为它会在每次变化时重新渲染你的组件。这个 hook 是为了简化迁移过程而创建的，只应在其他方法失败时使用。

我们在 Paseo 中反复踩过这个坑。该 hook 将组件订阅到**每一个** Unistyles 运行时变化（主题、断点、安全区域、色彩方案、缩放比例），并在每次调用时返回一个新的对象引用。这意味着大型子树（agent 流、面板、侧边栏）的周期性锁步重新渲染，即使用户可见的内容没有任何变化——这在性能分析中已得到确认，每个周期唯一的变动输入是 `theme`。它还会破坏所有包含派生主题值的下游 `useMemo`/`memo` 边界。

审查者必须拒绝引入新 `useUnistyles()` 调用的 PR。没有例外通道。如果你无法用下面的替代方案解决问题，请提交 issue 并停止——不要用 hook 来敷衍。

请按顺序使用以下替代方案：

### 1. `StyleSheet.create((theme) => ...)` —— 默认方案

大多数主题感知样式只需此方案。Babel 插件追踪工厂函数内的主题依赖，并在不触发 React 重新渲染的情况下通过原生 ShadowTree 更新。

```tsx
const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
  },
}));

<View style={styles.container} />;
```

如果你读取主题值只是为了将其反馈到 `style` prop 中，你几乎肯定需要的是这个方案而不是 hook。

### 2. 硬编码常量用于真正静态的值

如果你只需要一个恰好存在于主题上的数字（例如用于计算间距或动画距离的固定间距值），请使用字面常量或导入静态模块。静态读取不需要订阅。参见下面的"静态主题导入"部分——导入 `baseColors`、主题名称常量或 `type Theme` 在值确实是静态的情况下是没问题的。

### 3. `withUnistyles(Component)` 用于第三方 props

当第三方组件需要接收主题响应的非 `style` prop（例如 `BlurView.tint`、`Image.tintColor`、导航器选项 props、底部弹出层的 `backgroundStyle`）时，用 `withUnistyles` 包裹该单个组件。只有包装器重新渲染，而非周围的树。

```tsx
const ThemedBlur = withUnistyles(BlurView);
<ThemedBlur tint={theme.colors.surface0} />;
```

（注意下文记录的 `> *` 子选择器泄漏问题。）

### 4. 没有"最后手段"

没有逃生通道。如果方案 (1)–(3) 都不适用，说明问题在上游——在那里修复或提交 issue。hook 不在考虑范围内。

## 更新如何传播

对于标准 React Native 组件，[Unistyles Babel 插件](https://www.unistyl.es/v3/other/babel-plugin)将 `View`、`Text`、`Pressable` 和 `ScrollView` 等导入重写为 Unistyles 感知的组件工厂。在原生端，这些工厂借用组件引用并将 `style` prop 注册到 ShadowRegistry。上游的 ["为什么我的视图不更新？"](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update) 指南将此描述为避免不必要 React 重新渲染的 ShadowTree 更新路径。

重要细节：原生自动路径追踪 `props.style`。它通常不会追踪每一个携带样式类值的 prop。

[`useUnistyles()`](https://www.unistyl.es/v3/references/use-unistyles) 则不同。它让 React 访问当前的主题/运行时，并在这些值变化时使组件重新渲染。用于必须通过 React props 渲染的值，如图标颜色或小型逃生通道。不要期望直接从 `UnistylesRuntime` 读取值会导致组件重新渲染；[issue #817](https://github.com/jpudysz/react-native-unistyles/issues/817) 是对这个不变性的有用提醒。

## Web 上的动态像素样式

避免将变化的像素值（如 `{ top, left }`、`{ maxHeight }` 或 `{ minWidth }`）传入 web 上由 Unistyles 管理的 React Native 组件的 `style` prop。Web 运行时会按值为每个不同的样式对象生成哈希，并向 `#unistyles-web` 追加 CSS 规则；这些规则在页面生命周期内不会被回收，因此指针驱动的定位可能演变成样式表的持续增长。

对于高频变化的值，请使用下文的内联样式逃生通道。不要仅为了将某个测量值排除在 CSS 注册表之外就将组件拆分为普通/web/native 变体。原始 DOM 包装器保留给真正的 DOM 基础设施使用，如终端宿主、虚拟化 web 行或第三方拖拽包装器。

## 内联样式逃生通道

当某个样式值变化频率高且必须绕过 Unistyles 的 CSS 注册表时，保持组件在常规 Unistyles 路径上，仅用 `inlineUnistylesStyle` 标记该样式对象。

```tsx
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const styles = StyleSheet.create({
  thumb: {
    position: "absolute",
  },
});

<View style={[styles.thumb, inlineUnistylesStyle({ height, transform: [{ translateY }] })]} />;
```

这使用 Unistyles 自己的动画样式通道：普通样式仍然成为 Unistyles 类，而被标记的样式对象保留在 React Native 的内联样式数组中。用于测量几何、滚动或拖拽变换以及按下/悬停/打开状态，这些场景下生成 CSS 类是不合适的。

不要仅为了处理一个高频变化的值就将组件拆分为普通变体和 Unistyles 变体。组件仍然是正常的 Unistyles 组件；只有特定的样式对象被排除。

当可复用组件有一个专门服务于动态几何的 prop 时，让该 prop 成为分界线。例如，`FloatingSurface.frameStyle` 和 `FloatingScrollView.style` 拥有自己的逃生通道，这样菜单、工具提示、悬停卡片和组合框的调用者可以保持声明式，而不必了解 Unistyles 内部机制。

不要 flatten 调用者提供的样式数组并将 flatten 后的对象传回 React Native 组件。Unistyles 样式条目携带 `unistyles_*` 元数据；flatten 两个条目会产生一个包含多组元数据键的对象，并触发运行时警告："请使用数组语法而非对象语法"。将调用者样式保持为数组形式，仅 flatten 你明确拥有的动态几何值。如果该拥有的值是从混合了多个样式的 prop flatten 而来的，在通过 `inlineUnistylesStyle` 发送之前，请剥离 `unistyles_*` 元数据。

## 主要陷阱：`contentContainerStyle`

`ScrollView.contentContainerStyle` 是经典陷阱。它看起来像一个样式 prop，但它与 Unistyles 默认注册的重映射原生组件不是同一个 prop。上游教程在其 [ScrollView 背景问题](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue) 部分直接指出了这一点。

当样式依赖主题时，避免此模式：

```tsx
<ScrollView contentContainerStyle={styles.container} />;

const styles = StyleSheet.create((theme) => ({
  container: {
    flexGrow: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
```

首次挂载时可能会以当前自适应或初始主题绘制。如果应用设置稍后加载持久化主题并调用 [`UnistylesRuntime.setTheme`](https://www.unistyl.es/v3/guides/theming#change-theme)，JS 端的样式代理可能报告新主题，而原生内容容器保留旧的背景。这就是欢迎屏幕出现浅色背景和深色前景/按钮的原因。

这广泛适用于携带主题相关值的非 `style` props，例如名为 `color`、`trackColor`、`tintColor`、`backgroundStyle`、`handleIndicatorStyle` 的组件 props，以及其他库特定的样式 props。[第三方视图决策算法](https://www.unistyl.es/v3/references/3rd-party-views)建议对这些情况做显式处理，[issue #1030](https://github.com/jpudysz/react-native-unistyles/issues/1030) 展示了 `Image.tintColor` 相关的原生 prop 更新边界情况。将这些值视为 React props，除非用 `withUnistyles` 包裹。

## 修复模式

推荐模式：将主题背景放在普通包装 View 上，保持 `contentContainerStyle` 不受主题影响。

```tsx
<View style={styles.container}>
  <ScrollView contentContainerStyle={styles.contentContainer}>{children}</ScrollView>
</View>;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flexGrow: 1,
    padding: theme.spacing[4],
  },
}));
```

这是设置屏幕使用的模式：屏幕背景在普通的 `View style={styles.container}` 上，而滚动内容容器只承载布局。

在实践中，包装 `View` 模式是我们使用的模式。在整个应用中，`withUnistyles` 现在保留用于包裹叶子组件——主要是 lucide 图标（`ThemedActivityIndicator`、`ThemedChevronDown` 等）和小型第三方组件如 `MarkdownWithStableRenderer`——以便它们接收主题响应的 `color`/`tintColor` props 而不会导致父组件重新渲染。

原则上，[`withUnistyles`](https://www.unistyl.es/v3/references/with-unistyles) 也可以包裹 `ScrollView`，通过其[对 `style` 和 `contentContainerStyle` 的自动映射行为](https://www.unistyl.es/v3/references/with-unistyles#auto-mapping-for-style-and-contentcontainerstyle-props)使 `contentContainerStyle` 具有主题响应性。我们之前在欢迎屏幕上这样做过，但遇到了下文记录的 `> *` 子选择器泄漏问题；后来我们将欢迎屏幕迁移到了包装 `View` 模式。如果你发现自己想要使用 `withUnistyles(ScrollView)`，请将其视为一个坏味道，先检查包装 View 是否可行。

最小的逃生通道是使用 `useUnistyles()` 并通过 React 传递内联值：

```tsx
const { theme } = useUnistyles();

<ScrollView
  contentContainerStyle={[styles.contentContainer, { backgroundColor: theme.colors.surface0 }]}
/>;
```

谨慎使用。这样做是可行的，因为 React 重新渲染该 prop，但这种方式放弃了该值的主要 Unistyles 原生更新路径。

## `withUnistyles` 与 `> *` 子选择器泄漏

`withUnistyles` 在具有主题相关 `style` prop 的组件上工作时，会在 `<div style={{display: 'contents'}} className={hash}>` 中包裹该组件，并在 `.hash > *` 子选择器下发出样式，使样式级联到被包裹的组件。这就是 `style` 和 `contentContainerStyle` 在 web 上自动映射的工作原理。

尖锐的边界：Unistyles 按值对样式做哈希。如果 `withUnistyles` 收到的样式值与应用中其他地方普通 `View` 上使用的样式值**完全相同**，两个使用处会得到相同的哈希——两条 CSS 规则（元素规则和 `> *` 子规则）都在同一个类名下发出。`> *` 规则随后泄漏到共享该哈希的每个 `View` 的所有直接子元素上。

我们遇到的具体回归案例：`welcome-screen.tsx` 有 `const ThemedScrollView = withUnistyles(ScrollView)` 搭配 `style={{ flex: 1, backgroundColor: theme.colors.surface0 }}`。`panels/agent-panel.tsx` 有 `root` 和 `container` 样式，值完全相同。三者都在类 `unistyles_j2k2iilhfz` 上碰撞，因此浏览器样式表包含：

```css
.unistyles_j2k2iilhfz {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
.unistyles_j2k2iilhfz > * {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
```

子选择器规则将 `flex:1` 和 `background-color: surface0` 强加到 Composer 的外层 `Animated.View`（`container` 的直接子元素）上，使其拉伸以填充剩余空间，并在编辑器 UI 和屏幕底部之间留下大片空白。它还在滚动到底部按钮后面绘制了一条 `surface0` 色带。这个 bug 只在浏览器中出现——Electron 在配对后跳过 `WelcomeScreen`，因此 `> *` 规则从未在那里注入。

需要留意的症状：

- 主题面板背景 `View` 的兄弟元素仅在 web 上意外拉伸。
- `{ flex: 1, backgroundColor: surface0 }` View 的随机直接子元素出现了意外的背景。
- DevTools 显示你未编写的 `.unistyles_xxx > *` 规则。

在 DevTools 控制台中快速确认：

```js
[...document.styleSheets]
  .flatMap((s) => [...(s.cssRules || [])])
  .map((r) => r.cssText)
  .filter((t) => t.includes("unistyles") && t.includes("> *"));
```

除了来自 react-native-web 的无害 `r-pointerEvents-* > *` 规则外，任何匹配都是泄漏。

尽可能优先使用上一节中的包装 `View` 模式来避免此 bug：将 `{ flex: 1, backgroundColor: surface0 }` 放在普通的 `View` 上，给 `ScrollView` 一个不受主题影响的 `style`/`contentContainerStyle`。这样可以让 `withUnistyles` 远离热路径，避免哈希碰撞。只有当包装 View 确实不方便时才使用 `withUnistyles(ScrollView)`，并且当你这样做时，给被包裹的样式一个独特的形状（额外的键、不同的布局），使其不会与别处使用的常见面板背景哈希碰撞。

## 隐藏的 Bottom Sheet 内容

`@gorhom/bottom-sheet` 可能在 sheet 隐藏时保持 `BottomSheetModal` 的内容挂载。这在 Paseo 的启动主题切换期间很重要：标题节点可能在初始自适应主题下创建，保持隐藏，然后稍后以过时的原生样式值出现，即使周围内容已正确重新渲染。

我们在 `AdaptiveModalSheet` 中看到了这一点：正文和按钮是深色主题正确的，但共享的 sheet 标题以浅色主题的文字颜色在深色 sheet 背景上打开。对于可复用 sheet 标题中的微小值，优先使用内联逃生通道：

```tsx
const { theme } = useUnistyles();

<Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>;
```

将布局和排版保留在 `StyleSheet.create` 中；仅将过时的主题相关值通过 React 传递。如果更大的子树出现相同行为，考虑在主题变化时重新挂载 sheet，或将主题绘制移到与可见内容一起挂载的包装器上。

同样的规则适用于 bottom-sheet 组件 props，如 `backgroundStyle` 和 `handleIndicatorStyle`：它们是库 props，而非 Unistyles 注册的直接 React Native `style` prop。优先使用调用 `useUnistyles()` 的自定义 `backgroundComponent`，或从 hook 主题传递一个小型内联对象。

## Memoized 样式对象

当第三方库接收普通样式对象时，它处于 Unistyles 的原生追踪路径之外。确保依赖这些样式的 memo 的依赖项包含它读取的实际主题值。

避免这样的间接键：

```tsx
const { theme, rt } = useUnistyles();
const markdownStyles = useMemo(() => createMarkdownStyles(theme), [rt.themeName]);
```

在自适应系统主题变化时，hook 可以提供浅色/深色主题更新，而间接的运行时键并非使 memo 失效的值。这导致库渲染过时的颜色。助手 markdown 恰好遇到了此问题：工作区 shell 切换到浅色，但助手文本和代码段保留了旧的深色主题 markdown 样式对象。

优先使用 hook 主题本身或显式的主题 token 作为依赖：

```tsx
const { theme } = useUnistyles();
const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
```

如果样式工厂很轻量，完全跳过 `useMemo` 也是可以的。

## 静态主题导入

不要从 `@/styles/theme` 导入 `theme` 用于实时 UI 颜色。该导出是深色主题兼容的默认值，因此在渲染代码中使用它会导致图标、占位符或第三方 props 在浅色模式下被固定在深色上。

改用 `withUnistyles` 包裹图标（或其他叶子组件），这样只有该节点在主题变化时重新渲染：

```tsx
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedChevronDown = withUnistyles(ChevronDown);

const styles = StyleSheet.create((theme) => ({
  icon: { color: theme.colors.foregroundMuted },
}));

<ThemedChevronDown size={theme.iconSize.md} style={styles.icon} />;
```

这是应用中目前的主流模式（参见 `sidebar-workspace-list.tsx`、`message.tsx`、工作区屏幕）。将 `useUnistyles()` 保留给本文顶部描述的最后手段情况。导入 `baseColors`、主题名称常量或 `type Theme` 在值确实是静态或仅用于类型时是没问题的。

## Reanimated `Animated.View` + 动态样式崩溃

不要将 `StyleSheet.create((theme) => ...)` 样式应用到 Reanimated 的 `Animated.View` 上。Unistyles 将样式化组件包裹在 `<UnistylesComponent>` 中，并从 C++ 通过 ShadowRegistry 修补原生视图属性。Reanimated 也从其 worklet 运行时访问相同的原生节点。当主题变化触发时，两个系统都试图修改同一节点，应用崩溃并报错 `Unable to find node on an unmounted component.` 这是主题切换时 iOS 侧边栏的真实崩溃（提交 `4896cfe9`）。

修复方法：在 `Animated.View` 上使用普通 React Native `StyleSheet` 保持静态定位，通过 `useUnistyles()` 将主题相关值（如 `backgroundColor`）作为内联样式传入——在这里内联路径是可以接受的，因为没有其他方式可行：

```tsx
import { StyleSheet as RNStyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { useUnistyles } from "react-native-unistyles";

const positionStyles = RNStyleSheet.create({
  sidebar: { position: "absolute", inset: 0, width: 280 },
});

function Sidebar() {
  const { theme } = useUnistyles();
  return (
    <Animated.View
      style={[positionStyles.sidebar, animatedStyle, { backgroundColor: theme.colors.surface1 }]}
    />
  );
}
```

这是少数 `useUnistyles()` 是正确的工具的场合之一：没有 `withUnistyles(Animated.View)` 等效方案，受影响的组件很小，而替代方案是崩溃。

## 自适应主题与持久化设置

Unistyles 的 [`initialTheme`](https://www.unistyl.es/v3/guides/theming#select-theme) 和 [`adaptiveThemes`](https://www.unistyl.es/v3/guides/theming#adaptive-themes) 是互斥的。`initialTheme` 可以是字符串或同步函数，但不能等待异步存储。

Paseo 目前将应用设置存储在 AsyncStorage 中，并通过 react-query 加载。这意味着应用可能先以自适应/系统主题挂载，然后在设置加载后切换：

1. Unistyles 配置以 `adaptiveThemes: true` 启动。
2. 设备可能报告系统浅色模式。
3. 设置加载了持久化的非自动偏好，例如深色。
4. 应用调用 `setAdaptiveThemes(false)` 和 `setTheme("dark")`。

这种短暂切换在当前存储模型下是预期行为。这使得可追踪的样式很重要：在初始自适应主题期间挂载的任何内容必须在持久化偏好应用后正确更新。[Issue #550](https://github.com/jpudysz/react-native-unistyles/issues/550) 是一个独立的 ScrollView 粘性头部 bug，但它仍然是为什么 ScrollView 主题更新值得额外怀疑的有用上下文。

如果我们未来需要完全避免切换，至少将主题偏好存储在同步存储中，并用 `initialTheme` 配置 Unistyles。

## 运行时主题修补用于用户偏好

外观设置（UI/等宽字体系列、字号、语法高亮主题）通过在运行时使用 `UnistylesRuntime.updateTheme(name, updater)` 修补每个已注册的主题来应用——而不是通过组件中的偏好读取来传递。`packages/app/src/screens/settings/appearance/apply-appearance.ts` 中的 `applyAppearance` 在设置加载/变化时从 `ProvidersWrapper` 的 effect 中运行，遍历所有六个主题键，返回 `{ ...theme, fontFamily, fontSize, lineHeight, colors.syntax }`。

这不需要 `useUnistyles()`，因为每个消费者已经通过 `StyleSheet.create((theme) => …)`（或 markdown 渲染器的 `withUnistyles`/`uniProps` 路径）读取这些 token，修补主题会通过原生 ShadowRegistry 重新绘制被追踪的视图，无需 React 重新渲染。

陷阱：

- **修补所有主题，而非仅当前活动的主题。** 活动主题可能变化，自适应模式可能翻转浅色/深色；修补每个键保持活动键最新，并使更新顺序与 `setTheme`/`setAdaptiveThemes` 无关。effect 依赖设置值（而非 `theme`），因此不会循环。
- **在展开前缩小可辨识联合类型。** `updateTheme` 的更新器返回主题联合类型；展开联合类型会将 `colorScheme` 扩大为 `"light" | "dark"`，这不能赋值给任何具体成员。对 `t.colorScheme` 做分支处理，使每个分支展开单个缩小的主题类型（不使用 `as`）。
- **`lineHeight.diff` 是代码/diff 行高轴**——它与代码字号控件耦合（约等于 `codeFontSize * 1.5`）。不要将其用于正文。Markdown 正文行高随 UI 梯度缩放（`Math.round(theme.fontSize.base * 1.4)`）；通过 `lineHeight.diff` 路由正文会导致小字号时代码被裁剪。
- **高频变化的草稿值**（外观预览中的实时输入）绕过主题：将它们作为用 `inlineUnistylesStyle` 标记的内联样式应用，这样每次按键的值不会增长 `#unistyles-web` CSS 注册表。
- **已挂载的解析内容使用 `AppearanceStyleBoundary`。** Markdown、语法高亮代码和工具调用详情正文可能包含 memoized/自定义渲染器树，这些树在运行时修补的外观 token 变化时不会自然重新运行。用 `packages/app/src/components/appearance-style-boundary.tsx` 包裹解析后的内容一次；不要在每个调用点添加本地的"外观键" props。
- **动态字体 token 保持扩大。** `commonTheme` 上的 `fontFamily`、`fontSize` 和 `lineHeight` 注解为 `string`/`number`（不用 `as const` 缩小），以便更新器的返回值可以赋值；平台默认栈位于 `DEFAULT_UI_FONT_STACK` / `DEFAULT_MONO_FONT_STACK`。

## 调试

要检查 Babel 插件看到的内容，暂时在 `packages/app/babel.config.js` 中启用 [`debug: true`](https://www.unistyl.es/v3/other/babel-plugin#debug)：

```js
[
  "react-native-unistyles/plugin",
  {
    root: "src",
    debug: true,
  },
],
```

然后重新构建打包并查找类似这样的行：

```text
src/components/welcome-screen.tsx: styles.container: [Theme]
```

这只能确认样式表依赖被检测到。上游调试指南也做了同样的区分：依赖检测只是一种失败模式。它不能证明样式 prop 已在你关心的原生视图上注册。

对于绘制层 bug，使用高对比度探针：

1. 将每个候选层涂上不同的颜色，例如根包装器青色，`ScrollView.style` 黄色，`contentContainerStyle` 品红色。
2. 冷重启应用，而不仅是 Fast Refresh。
3. 截取模拟器屏幕截图并取样像素，查看哪种颜色填充了该区域。
4. 提交前移除探针。

欢迎屏幕调查即使用此方法证明了白色层是 `ScrollView` 的内容容器。

## 参考资料

- [Unistyles v3 文档](https://www.unistyl.es/)
- [主题：初始主题、自适应主题和运行时主题变化](https://www.unistyl.es/v3/guides/theming)
- [ScrollView 背景问题](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue)
- [withUnistyles 参考](https://www.unistyl.es/v3/references/with-unistyles)
- [第三方视图决策算法](https://www.unistyl.es/v3/references/3rd-party-views)
- [Babel 插件 debug 选项](https://www.unistyl.es/v3/other/babel-plugin#debug)
- [为什么我的视图不更新？](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update)
- [GitHub issue #550：ScrollView 粘性头部主题更新](https://github.com/jpudysz/react-native-unistyles/issues/550)
- [GitHub issue #817：`UnistylesRuntime.themeName` 不会重新渲染](https://github.com/jpudysz/react-native-unistyles/issues/817)
- [GitHub issue #1030：`Image.tintColor` 和原生样式更新边界情况](https://github.com/jpudysz/react-native-unistyles/issues/1030)
