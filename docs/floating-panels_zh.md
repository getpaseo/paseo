# 浮动面板

锚定弹出层——提示框、悬停卡片、下拉菜单、自动补全——在 iOS、Android 和 Web 上浮动显示在锚点元素上方。本文档记录了那些不明显的陷阱。它**不是**教程；假设你已经看过规范文件，正在尝试添加或修改一个浮动面板。

## 规范文件

| 文件                                       | 用途                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| `components/ui/combobox.tsx`               | 带搜索的锚定选择器；移动端回退到底部弹出层                |
| `components/ui/tooltip.tsx`                | 不可交互的悬停/长按提示框                                 |
| `components/ui/autocomplete-popover.tsx`   | 锚定在聚焦的编辑器输入框上的斜杠命令自动补全              |
| `components/workspace-hover-card.tsx`      | 桌面 Web 悬停卡片，使用 measure + computePosition + Portal |

每个文件处理不同的关注点组合：combobox 拥有输入焦点，tooltip 不可交互，hover-card 仅限 Web 桌面端，autocomplete 保持编辑器输入框聚焦，同时其可滚动列表存在于 Portal 中。目前还没有共享的"浮动面板"原语——当第五个用例出现时我们可以重新考虑；在那之前，优先复制最接近的文件并裁剪。

## 陷阱 1 —— Android 触摸命中测试基于父元素边界

在 Android 上，子 View 的边界如果超出父元素边界，渲染是正确的（`overflow: visible`，默认值），但**不会接收到触摸事件**。`ViewGroup.dispatchTouchEvent` 首先按父元素的命中矩形过滤触摸，然后遍历子元素。溢出区域内的触摸永远无法到达父元素，更不用说子元素了。iOS 和 Web 没有此规则——iOS 命中测试会向下进入溢出的子元素，Web 使用标准 CSS 指针事件。这就是让 autocomplete 走上这条路的问题：弹出层定位在父元素的 `bottom: 100%`，在 iOS/Web 上正常工作了数月；Android 的触摸直接穿透到了后面的聊天滚动视图。

代码库中有两种解决方案：

- **`Modal`**（combobox，原生端的 tooltip）——打开一个新的 Android 窗口，因此命中测试在该窗口内重新开始。副作用：在 Android 上打开 Modal 可能会使 IME 与底层 TextInput 分离。对于 combobox（它有自己的输入框）和 tooltip（没有输入框）来说没问题。对于 autocomplete **不行**（编辑器的输入框必须保持聚焦，以便用户继续输入）。
- **来自 `@gorhom/portal` 的 `<Portal>`**（hover-card, autocomplete-popover）——将 React 子树提升到一个固定的挂载点，该挂载点的边界覆盖整个屏幕。同一窗口，同一 IME，命中测试正常工作，因为新的父元素是全屏的。当你必须保持 IME 连接时，这是正确的默认选择。按层级选择宿主：应用全局覆盖层使用根宿主；内容覆盖层可以使用当前的 `FloatingPanelPortalHost`，以便滑动的侧边栏能够覆盖它们。

根据底层输入框是否可以失去键盘来决定使用 Modal 还是 Portal。

## 陷阱 2 —— Portal 破坏生命周期和坐标系统继承

Portal 避开了 Android 的命中测试，但它也避开了你默默依赖的两件事：

- **生命周期。** Portal 的子树挂载在应用根部，而不是在你组件的自然祖先链中。当用户导航离开时，你的组件可能保持挂载（在屏幕外，在一个标签页中）——弹出层也随之保持。用屏幕焦点信号来控制 `visible`。对于 `agent-panel` 内的面板，`isPaneFocused` prop 已经存在，并在面板切换时切换；传递 `visible={isYourOwnVisible && isPaneFocused}`。
- **变换。** `KeyboardShiftProvider` 拥有规范的键盘位移 SharedValue，`useKeyboardShiftStyle()` 只将该值适配为 translate/padding 样式。编辑器和聊天内容都必须读取那个由 provider 拥有的值。Portal 中的弹出层位于编辑器树之外——它不会获得那个变换，除非你自己应用。
- **分层。** 默认的根宿主在应用内容之后渲染，因此它位于紧凑侧边栏之上。必须位于侧边栏之下的内容覆盖层应该使用当前的 `FloatingPanelPortalHost`。
- **坐标系统。** `measureInWindow` 给出窗口坐标。Portal 在其宿主内部渲染，不一定在窗口原点。相对于宿主定位锚定内容：`anchorRect - hostRect`。这就是 `measureFloatingPanelPortalHost()` 的用途。

变换的修复方法是陷阱 3。

## 陷阱 3 —— Reanimated 变换 vs `measureInWindow`

`measureInWindow` 返回视图的*当前*屏幕位置。理论上这包括 Reanimated 应用的变换（Reanimated 更新原生视图属性，Android 的 `getLocationInWindow` 读取变换后的坐标）。实践中存在竞态条件——测量可能在动画中间快照，并且在 Android 上使用 Reanimated worklet 时结果不总是稳定的。

如果面板不能停留在变换后的祖先内部，不要试图通过每帧重新测量来跟踪键盘。相反，**将弹出层的变换绑定到编辑器使用的同一个 `KeyboardShiftProvider` SharedValue**：

1. 在测量锚点的时刻记录 `openShift = shift.value`。
2. 对弹出层包装器应用 `useAnimatedStyle(() => ({ transform: [{ translateY: openShift.value - shift.value }] }))`。

当 `shift` 等于 `openShift` 时，translate 为 0，弹出层位于测量位置。当键盘之后移动时，差值将弹出层平移了与编辑器平移完全相同的量。它们同步移动，无需重新测量。不要直接调用 `useReanimatedKeyboardAnimation()` 来设置应用 UI 偏移策略；Android 可能会短暂报告一个过时的非零高度和关闭进度，而共享 provider 是进行规范化的地方。

仅在键盘处于过渡中而弹出层打开时，通过 `Keyboard.addListener('keyboardDidShow'|'keyboardDidHide')` 重新测量以刷新快照。

## 陷阱 4 —— 平台偏移之前的宿主相对定位

通用的锚定覆盖层规则是：

1. 使用 `measureInWindow` 测量锚点。
2. 使用 `measureFloatingPanelPortalHost(hostName)` 测量 Portal 宿主。
3. 使用相对于宿主的锚点坐标进行定位：

```ts
left = anchorRect.x - hostRect.x;
bottom = hostRect.height - (anchorRect.y - hostRect.y) + offset;
```

在添加任何平台偏移之前执行此操作。如果锚点和宿主都使用 `measureInWindow` 测量，Android 的状态栏坐标行为会相互抵消。只有在渲染表面不在同一坐标系中测量时才添加状态栏偏移。参见 `tooltip.tsx` 中的那个单独情况。

## 陷阱 5 —— 两次测量闪烁

如果你的弹出层需要从以下两者计算 `top`（或 `left`）：

- 锚点的屏幕位置（来自 `measureInWindow` 的 `anchorRect`），**以及**
- 弹出层自身的尺寸（来自 `onLayout` 的 `contentSize`），

那么一个简单的实现会在每次打开时闪烁经过三个位置：

1. **第 1 帧** —— 在等待任一测量结果时，以 `top: -9999`（或任何占位值）渲染。包装器没有 `width`，因此内部内容按其自然（通常较窄的）固有宽度布局。
2. **第 2 帧** —— `anchorRect` 到达。包装器现在有 `width: anchorRect.width`。但来自第 1 帧的过时 `onLayout` 已经将 `contentSize` 设置为窄宽度尺寸。`top = anchorRect.y - wrongHeight - gap` —— 在错误位置可见。
3. **第 3 帧** —— 真正的 `onLayout` 以正确的宽度触发。`contentSize` 更新。位置对齐到正确的位置。

第 2 帧中可见的跳动就是闪烁。两个部分解决它，两者都需要：

- **在 `anchorRect` 设置好之前不要挂载浮动内容。** 在那之前返回 `null`。这完全阻止了错误宽度的 onLayout 发生。
- **一旦 `anchorRect` 设置好但 `contentSize` 还没设置好，以最终宽度但 `opacity: 0` 渲染包装器。** 第一次可见绘制就在正确的位置。这是 combobox 的模式——`shouldHideDesktopContent` 在 `combobox.tsx:481, 876`。**不要**使用 `top: -9999` 作为占位值；布局工作仍在 -9999 处发生，当你翻转回来时任何后续状态闪烁都是可见的。

"先渲染不可见来测量，然后显示"的模式是本代码库中解决定位鸡生蛋问题的规范方案。在有更花哨的方案之前，先用它。

## 陷阱 6 —— 底部弹出层引用不是生命周期真相

`@gorhom/bottom-sheet` 的模态框在呈现和关闭时会变动其命令式 ref。不要将 `ref != null` 视为调用 `present()` 的许可，也不要将 `ref == null` 视为弹出层已关闭。用户可见的生命周期是期望的 `visible` prop 加上弹出层回调（`onChange(-1)`、`onDismiss`）。

如果用户通过背景遮罩或平移手势关闭弹出层，弹出层可能在 React 状态确认 `visible=false` 之前就分离并重新连接。在重新连接时重新呈现会与 Gorhom 的关闭路径产生竞态，导致模态框无法重新打开。跟踪一个显式的阶段（`closed` / `presenting` / `presented` / `dismissing`），并在关闭过程中忽略 ref 变动。

不要将 `onChange(-1)` 单独视为关闭。在堆叠的 `BottomSheetModal` 中，`-1` 也可能意味着弹出层被另一个推入的弹出层暂时隐藏。从 `onDismiss` 关闭 React 状态；仅使用 `onChange` 来跟踪阶段。

## 新建锚定面板的配方

在编写新的之前，问自己：

1. **底层输入框可以失去键盘吗？** 如果可以，使用 Modal（更简单）。如果不能，使用 Portal。
2. **面板需要在屏幕切换时关闭吗？** 几乎总是需要——用上游焦点 prop（`isPaneFocused` 或类似）来控制 `visible`。
3. **面板是在 Portal 宿主中渲染的吗？** 也要测量宿主。永远不要使用原始窗口坐标作为本地 Portal 坐标。
4. **面板是否位于随键盘移动的内容之上？** 如果是，将 Reanimated 变换绑定到同一个 SharedValue（陷阱 3）。如果不是，你可能可以完全跳过变换。
5. **面板的内容高度会变化吗？** 如果是，你需要 `anchorRect` 和 `contentSize` 两者来定位 → 应用陷阱 5（在锚点之前返回 null，然后在 contentSize 之前 opacity-0）。如果不是——内容有已知的固定最大高度——你可能可以使用底部锚定定位（`bottom: windowHeight - anchor.y + gap`）并完全跳过 `contentSize` 往返。**但只有当高度确实有界时才这样。** 在提交之前验证。

然后复制最接近的规范文件并裁剪。
