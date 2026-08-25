# 悬停

在编写任何悬停代码之前阅读本文。我们发布的每一个悬停回归都是以下三种失败模式之一，而每一种都通过相同的规范模式解决。这个模式来之不易——它经受住了我们尝试过的所有其他形式的考验——所以复制它，不要重新发明它。

## 模式

规范实现位于 `packages/app/src/components/sidebar-workspace-list.tsx` 中的工作区行（大约在第 1369 行附近）。有疑问时，打开那个文件并复制其结构。

```tsx
//
//   ┌─ 普通 View。通过 pointerenter/pointerleave 跟踪悬停。
//   │
<View
  style={styles.workspaceRowContainer}
  onPointerEnter={handlePointerEnter}
  onPointerLeave={handlePointerLeave}
>
  <Pressable                          // ┐ 独立的内层 Pressable。
    onPress={handlePress}             // │ 只处理按下。
    onPressIn={...}                   // │ 永远不要有 onHoverIn/onHoverOut。
    onPressOut={...}                  // ┘
    style={workspaceRowStyle}
  >
    <View style={styles.workspaceRowMain}>
      <View style={styles.workspaceRowLeft}>…</View>
      <WorkspaceRowRightGroup isHovered={isHovered} />
      {/*                    └─ 基于悬停状态显示内容。 */}
    </View>
  </Pressable>
</View>
```

五件事让它起作用。每一件都很重要。

1. **悬停驻留在普通 `View` 上，而不是 `Pressable` 上。** `Pressable` 自带内部的悬停状态机。嵌套的 `Pressable` 会争夺它。普通 `View` 只分发 DOM 事件——没有状态机，没有争夺。
2. **按下驻留在*独立*的内层 `Pressable` 上。** 悬停和按下永远不共享同一个元素。两个状态机永远不看到彼此。
3. **`onPointerEnter` / `onPointerLeave` 是非冒泡的**，按 W3C 规范属于 mouseenter 风格。它们仅在跨越外层 `View` 的边界框时触发。跨越进入后代——包括后代的 `Pressable`（烤肉串菜单的按钮、复制按钮、tooltip 目标）——**不会**触发 `pointerleave`。这就是为什么在其中嵌套 `Pressable` 是安全的。
4. **行具有固定的 `minHeight`。** 当悬停时内容交换（烤肉串菜单替换 diff 状态），两者占据相同的固定槽位。零布局偏移，零几何闪烁。
5. **外层 `View` 只有 `position: relative`。** 它只为了成为悬停目标而存在。所有真正的布局驻留在内层 `Pressable` 上。悬停跟踪器是包裹行的密封信封；其中的布局变化永远不会泄漏出去并从侧面重新进入。

这就是整个模式。内化它。

## 当你跳过模式时，以下就是会出错的地方

### 失败模式 1 —— 嵌套的 Pressable 争夺悬停状态

如果你将 `onHoverIn` / `onHoverOut` 放在一个内部某处包含另一个 `Pressable` 的 `Pressable` 上（复制按钮、图标按钮、嵌套操作），当光标移动到内层 `Pressable` 上时，内层的悬停状态机声明了悬停，外层的 `onHoverOut` 触发。你的显示状态关闭。显示内容隐藏。光标不再位于隐藏的显示内容上，因此它最终回到触发区域上方。外层的 `onHoverIn` 触发。循环。

这是本代码库中最常见的悬停 bug，远远领先。这就是工作区行结构化以避免的情况。修复方法不是"在处理器上耍聪明"——而是"不要把悬停放在包含其他 Pressable 的 Pressable 上。"

> **规则：** 悬停跟踪元素是一个带有 `onPointerEnter` / `onPointerLeave` 的普通 `View`。任何 `Pressable`——包括你忘记了它们是 Pressable 的那些，比如 `TurnCopyButton`、图标按钮、任何处理点击的东西——都驻留在它内部。

### 失败模式 2 —— 悬停状态改变触发器的几何形状

症状：你悬停一个按钮，它改变外观，然后在没有移动光标的情况下在悬停和非悬停之间闪烁。

原因：悬停状态改变了触发器的大小或位置。光标在原始元素上；新布局将其移出或缩小到光标下方；`onHoverOut` 触发；状态恢复；原始布局返回；光标回到触发器上方；`onHoverIn` 触发；循环。

常见变体：

- 悬停状态改变触发器的 `width`、`height`、`padding` 或 `borderWidth`。
- 悬停状态挂载/卸载一个将触发器推到新位置的子元素。
- 悬停状态将触发器替换为不同的元素类型，重新挂载它。

修复方法，按优先顺序：

1. **不要在悬停时改变触发器的外部几何形状。** 改变颜色、透明度、不占用布局空间的边框（Web 上的 `outlineWidth`，绝对定位的覆盖层），或者适应同一固定框内的子内容。永远不要改变悬停目标本身的 `width`、`height`、`padding` 或 `borderWidth`。
2. **用 `opacity` + `pointerEvents` 隐藏，而不是条件渲染**，当隐藏的元素驻留在触发器内部时。在悬停时挂载/卸载会重新流动光标下方的布局。
3. **固定命中区域。** 在触发器上设置固定的 `minHeight` / `minWidth`，以便内部交换（悬停时图标 A 变成图标 B）使边界框保持不变。工作区行的 `minHeight: 36` 就是使烤肉串/diff-stat 交换稳定的原因。

### 失败模式 3 —— 显示的内容在悬停触发器外部

如果悬停元素 A 显示元素 B，B 必须位于 A 的悬停触发器**内部**。如果 B 是兄弟元素，当光标从 A 移向 B 时，它跨越出 A 的边界框，`pointerleave` 触发，B 消失。

错误：

```tsx
<View>
  <View onPointerEnter={...} onPointerLeave={...}>     {/* 悬停触发器 */}
    <Bubble />
  </View>
  <TrailingRow />                                       {/* 外部——兄弟元素，不是子元素 */}
</View>
```

正确：

```tsx
<View onPointerEnter={...} onPointerLeave={...}>      {/* 悬停触发器 */}
  <Bubble />
  <TrailingRow />                                      {/* 内部——子元素 */}
</View>
```

A 和 B 之间的任何间隙（同一父元素内兄弟元素之间的边距）都是父元素边界框的一部分，因此光标在穿过它时保持在悬停区域内。不需要桥接。

如果 A 和 B 确实不能共享一个父元素——B portal 到不同的层级，浮动在其他内容之上——参见下面的[章节：真实间隙](#带浮动面板的真实间隙)。

## 原生回退

悬停在触摸设备上不存在。任何隐藏在悬停后面的内容必须在原生和紧凑布局上有非悬停路径：

```tsx
const showControls = isHovered || isNative || isCompact;
```

`isNative` 和 `isCompact` 来自 `@/constants/platform` 和 `@/constants/layout`。不要使用 `Platform.OS === "ios"` 作为代理。

`onPointerEnter` / `onPointerLeave` 是 DOM 事件。它们不会在原生端触发。你不需要对它们进行门控——在原生端，悬停本来就不可达，可见性由你上面显示控件表达式中的 `isNative` / `isCompact` 驱动。这就是为什么工作区行的指针事件没有被 `if (isWeb)` 包裹。

## 那 `Pressable.onHoverIn` / `onHoverOut` 呢？

当 `Pressable` 基于自己的悬停样式化**自身**时——例如，一个图标按钮在悬停时改变颜色——这是可以的。那是自包含的。render-prop `<Pressable style={({ hovered }) => ...}>` 更干净地做同样的事情，并且是首选形式。

当用于跟踪悬停以驱动**该 `Pressable` 外部**的状态（显示兄弟元素、打开 tooltip、显示烤肉串菜单）时，如果其中有任何其他 `Pressable`，那就**不行**——因为那是失败模式 1。

启发式方法：如果你的悬停状态将被 `useState` 化并被同一 `Pressable` 自身的样式之外的任何东西读取，不要使用 `onHoverIn` / `onHoverOut`。使用规范模式。

## 带浮动面板的真实间隙

有时显示的内容不能驻留在触发器内部——悬停卡片 portal 到不同的层级，tooltip 浮动在其他内容之上，弹出层渲染到 `Portal` 中。用户需要用光标跨越真实的视觉间隙。

对于这种情况，使用 `useHoverSafeZone`（`packages/app/src/hooks/use-hover-safe-zone.ts`）。它计算触发器和内容之间的矩形"桥接"；当指针在触发器、内容或桥接内部时，卡片保持打开。短暂的宽限计时器吸收边缘的抖动。规范调用者是 `packages/app/src/components/workspace-hover-card.tsx`。

不要自己实现。数学很烦人，边缘情况（指针离开窗口、正在进行拖拽、内容卸载）很微妙，而且我们已经为这个 hook 付出了代价。

## PR 前检查清单

在打开涉及悬停的 PR 之前：

- [ ] 悬停跟踪在一个带有 `onPointerEnter` / `onPointerLeave` 的普通 `View` 上，**不是**在包裹任何可按下元素的 `Pressable` 上。
- [ ] 任何按下行为驻留在独立的没有 `onHoverIn` / `onHoverOut` 的内层 `Pressable` 上。
- [ ] 悬停触发器的边界框包含用户在与功能交互时可能将鼠标移入的每个元素。
- [ ] 悬停状态**不**改变触发器的外部几何形状（`width`、`height`、`padding`、`borderWidth`、会移动它的兄弟元素的挂载/卸载）。内部交换适应固定的 `minHeight` / `minWidth`。
- [ ] 触发器内部显示的内容使用 `opacity` + `pointerEvents`，而不是条件渲染，如果挂载它会重新流动触发器的话。
- [ ] 原生和紧凑布局上的可见性在没有悬停的情况下正常工作（`isHovered || isNative || isCompact`）。
- [ ] 如果显示的内容位于单独的层级（portal、浮动面板），`useHoverSafeZone` 已接线。
- [ ] 你打开了开发服务器，悬停触发器，并沿着**每个**显示的元素——包括任何可见间隙——缓慢移动鼠标，没有丢失悬停状态。
