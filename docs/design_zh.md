# 设计

设计 Token——每一种颜色、字号、字重、间距步长、圆角、图标大小——都位于 `packages/app/src/styles/theme.ts` 中。

---

## 1. 格调

Paseo 追求极简、开阔、安静、自信。留白是有意为之。不拥挤，不装饰，不道歉。一行，一个标签，一个控件。这就是标准。

应用是冷静的，因为用户的工作不冷静。每一个视觉决策都服务于*对此操作*或*理解此内容*——绝不服务于*观看此界面*。

一致性来自组件复用，而非跨界面的手工匹配样式。项目列表中的一行、设置中的一行和模态框中的一行是同一个组件，而不是三个碰巧看起来相似的实现。当两个界面以两种不同方式做同一件语义上的事时，其中一个是错的。

---

## 2. 组件复用

在三个或更多地方使用的语义元素是原语。只在单个地方使用的元素是屏幕。

原语位于 `packages/app/src/components/ui/` 和 `packages/app/src/components/headers/` 中。卡片和行布局位于 `packages/app/src/styles/settings.ts` 中。区块结构位于 `packages/app/src/screens/settings/settings-section.tsx` 中。

一个被样式化成外观像按钮的可按压元素是错误的；按钮是 `<Button>`（`packages/app/src/components/ui/button.tsx`）。一个被样式化成外观像区块标题的裸 `<Text>` 是错误的；区块标题是 `<SettingsSection>`（`packages/app/src/screens/settings/settings-section.tsx`）。一个用于确认的自定义 `Modal` 是错误的；确认是 `confirmDialog`（`packages/app/src/utils/confirm-dialog.ts`）。一个手工制作的溢出菜单是错误的；菜单是 `<DropdownMenu>`（`packages/app/src/components/ui/dropdown-menu.tsx`）。一个手工制作的状态标签是错误的；标签是 `<StatusBadge>`（`packages/app/src/components/ui/status-badge.tsx`）。

在添加新组件之前，请阅读 `components/ui/`。原语通常已经存在。

---

## 3. 层次结构

层次通过字重和颜色传达，而非字号。应用中大多数标签、标题和提示使用 `fontSize.base` 或 `fontSize.xs`。行的主标题与次标题之间的区别是 `foreground` vs `foregroundMuted`。

字重有三个层级，按角色应用：

- **屏幕标题**——屏幕顶部的标题——使用 `<ScreenTitle>`（`packages/app/src/components/headers/screen-title.tsx`），以 `fontSize.base` 渲染，在紧凑布局上字重为 `400`，在桌面端为 `300`。顶部标题在桌面端更轻，而非更重。工作区屏幕标题遵循相同规则（`packages/app/src/screens/workspace/workspace-screen.tsx`）。
- **结构标签**使用 `fontWeight.medium`。这适用于卡片行栈上方的区块标签（`packages/app/src/components/agent-list.tsx:519-523`，`packages/app/src/components/keyboard-shortcuts-dialog.tsx:63-67`）、模态框内输入框上方的表单字段标签（`packages/app/src/components/add-host-modal.tsx:19-23`，`packages/app/src/components/pair-link-modal.tsx:24-28`）、模态框/sheet/对话框顶部的标题（`packages/app/src/components/adaptive-modal-sheet.tsx:90-94`，`packages/app/src/components/ui/combobox.tsx:1607-1611`，`packages/app/src/components/welcome-screen.tsx:48-53`）、紧凑组件（如侧边栏提醒操作）中的操作按钮标签（`packages/app/src/components/sidebar-callout.tsx:218-221`），以及密集元数据行上的内联数据强调（`packages/app/src/components/git-diff-pane.tsx:2322-2327`，`packages/app/src/components/file-explorer-pane.tsx:1115-1122`）。
- **内容**使用 `fontWeight.normal`。这适用于设置行（`packages/app/src/styles/settings.ts`）、侧边栏一级列表项标题（`packages/app/src/components/sidebar-workspace-list.tsx:2680-2686`，`packages/app/src/components/agent-list.tsx:572-578`）、`<Button>` 文本（`packages/app/src/components/ui/button.tsx:80-84`）、`<StatusBadge>` 文本（`packages/app/src/components/ui/status-badge.tsx:56-60`）以及 `<SidebarCallout>` 标题（`packages/app/src/components/sidebar-callout.tsx:175-180`）。

规则概括：为界面区域或分组*命名*的文本用 `medium`。位于界面区域或分组*内部*的文本用 `normal`。顶部屏幕标题是 `<ScreenTitle>`，字重更轻。

`foreground` 用于被操作的对象：行标题、区块标题、选中的侧边栏项目。`foregroundMuted` 用于上下文信息：提示、描述、次要元数据、非活跃侧边栏项目、占位符、状态文本。

`accent` 是每个界面上唯一的 CTA。一个填充 `accent` 的 `<Button variant="default">` 在页面上最多出现一次。大多数页面为零次——设置页面主要是开关和文本，工作区面板主要是内容，聊天编辑器本身就是输入。

`destructive` 是颜色，不是点击操作。重启守护进程和移除主机在行尾槽中使用 `<Button variant="outline">`；破坏性界面仅出现在 `confirmDialog` 内部（`packages/app/src/screens/settings/host-page.tsx:541-547`）。工作区归档在出现任何红色之前先打开确认对话框（`packages/app/src/components/sidebar-workspace-list.tsx`）。红色在用户表明意图之后出现。

---

## 4. 按钮

按钮是 `<Button>`（`packages/app/src/components/ui/button.tsx`）。它有五种变体。每种都有一个职责。

`default` 是界面上唯一的主要操作——填充 `accent`。每页最多一个。`<AdaptiveModalSheet>` 内部的主操作槽位和欢迎屏幕上的高亮操作是标准用法。

`secondary` 是两个权重相同的操作并列时使用的——填充 `surface3`。组件的默认值是 `secondary`，这与它在代码库中的出现频率一致。

`outline` 是位于行上的低频率操作——透明带 `borderAccent`。主机详情页的 Restart、Remove、Update（`packages/app/src/screens/settings/host-page.tsx:585-594`）。

`ghost` 是结构性的、非承诺性的——无边框、无填充。后退箭头、标题栏开关、"Load more" 底部（`packages/app/src/screens/sessions-screen.tsx:54-63`）、更多操作入口。Ghost 用于操作入口是 chrome 的一部分而非一个决策时。

`destructive` 填充 `destructive` 颜色。它仅出现在确认操作内部。页面上的按钮是 `outline`；破坏性按钮是对话框内部的确认按钮。

尺寸：`xs` 用于超紧凑的内联触发器。`sm` 用于位于行上的任何按钮。`md` 是页面默认值。`lg` 保留给大型独立 CTA。

一个包裹 `<Text>` 的 `<Pressable>` 是第六种变体。它是错误的。`<Button>` 接受 `style`、`textStyle`、`leftIcon`、`disabled`、`size` 和 `variant`。

---

## 5. 边框

边框用于分组、分隔，或较少情况下用于强调。

一个逻辑上相关的行组应位于卡片内部——整个组周围一个边框。卡片原语是 `settingsStyles.card`；键盘快捷键对话框使用相同的形状内联（`packages/app/src/components/keyboard-shortcuts-dialog.tsx:68-73`）。边框定义了哪些内容属于一组。

卡片内部首行之后的行带有 `settingsStyles.rowBorder`——单条顶边。第一行绝不会有。相同的分隔模式出现在键盘快捷键对话框行中（`packages/app/src/components/keyboard-shortcuts-dialog.tsx:74-83`）。行不需要自己的背景来营造分隔感。

本身是页面内容的列表——`sidebar-workspace-list.tsx` 中的侧边栏项目、工作区列表、agent 列表（`packages/app/src/components/agent-list.tsx`）——使用间距和表面色而非边框来分隔项目。卡片内的行是一种内部模式；作为页面的列表则不是。

面板 chrome——工作区面板标题、文件浏览器标题、diff 面板标题——使用单条底边来分隔标题与内容（`packages/app/src/components/git-diff-pane.tsx:2328-2331`）。一条边框，无阴影。

`borderAccent` 保留给 outline 按钮。输入框使用 `border`。单一事物的边框是错误的；一个有边框的单一元素要么是一行卡片（使用卡片），要么它不需要边框。

---

## 6. 选择器

五种原语。选择由选项数量、是否需要搜索以及选择器的锚定方式决定。

`<DropdownMenu>` 用于锚定到触发器的小型固定集合。主题选择器、工作区和项目行上的 kebab 菜单（`packages/app/src/components/sidebar-workspace-list.tsx:684-770`）、行的"更多"菜单。项目可以是异步的（`status: "pending"`），可以包含破坏性条目。适用于约 10 个以下选项且用户知道自己要找什么的场景。

`<Combobox>` 用于大型或可搜索的列表。侧边栏底部的主机切换器、编辑器中的模型选择器、工作区标题中的分支切换器（`packages/app/src/components/branch-switcher.tsx`）。用户输入以查找选项，或列表足够长需要滚动。

`<ContextMenu>` 用于目标上的右键和长按。行是触发器；没有可见的操作入口。用于侧边栏中工作区行上的附带操作（`packages/app/src/components/sidebar-workspace-list.tsx`）。

`<AdaptiveModalSheet>` 用于聚焦的任务。多字段表单（`packages/app/src/components/add-host-modal.tsx`、`packages/app/src/components/pair-link-modal.tsx`、`packages/app/src/components/project-picker-modal.tsx`）、带细节的确认、任何值得有背景遮罩的内容。紧凑布局上是底部弹出层，桌面端是居中的卡片。原始 `Modal` 对任何这些场景都是错误的。

`<AdaptiveModalSheet>` 在 sheet 内部拥有紧凑底部安全区域内边距，以便 sheet 背景仍然到达屏幕底部。如果 sheet 的第一个 snap 点比其标题、内容和安全区域间距更短，请提高该 snap 点而不要移动 sheet 容器。

`confirmDialog` 用于破坏性的是/否确认和命令式确认。基于 Promise：`await confirmDialog({ destructive: true, ... })`。任何点错按钮就会丢失工作的场景。

三个主题是 `DropdownMenu`。三十个主机是 `Combobox`。一个标签和一个值是 `AdaptiveModalSheet`。"你确定吗？"是 `confirmDialog`。

---

## 7. 密度和节奏

设置详情页、项目详情页以及任何列表+详情内容位于一个居中、最大宽度 720 的列内（`packages/app/src/screens/settings-screen.tsx`、`packages/app/src/screens/projects-screen.tsx`）。行保持可读性，眼睛不必追踪过宽的水平距离。表单模态框带有自己的较窄内容框（`packages/app/src/components/add-host-modal.tsx`）。

工作区和聊天界面使用完整宽度——这些是工作界面，而非阅读界面。编辑器带有来自 `packages/app/src/constants/layout.ts` 的 `MAX_CONTENT_WIDTH`，以保持行可读的同时让工作区面板填充其余空间。

区块之间应分开。`<SettingsSection>` 拥有自己的底部边距；下一个内容包裹在另一个 `<SettingsSection>` 中。agent 列表的 `sectionHeading` 带有相同的 `marginTop`/`marginBottom` 节奏（`packages/app/src/components/agent-list.tsx:511-517`）。给区块添加 `marginBottom` 是错误的。

区块内的卡片比区块之间更近。卡片内的行相互接触——只有分隔线将它们分开。节奏是 页面 → 宽敞；区块 → 宽敞；卡片 → 紧凑。

行有慷慨的垂直内边距：设置行大约 16px 内容加 16px 垂直内边距，侧边栏列表项为 8–12px（因为许多行需要容纳）。压缩行到低于既定密度以在屏幕上容纳更多内容是错误的。太多行意味着更多的卡片或更多的区块，而非更小的行。

留白就是设计。

---

## 8. 响应式

紧凑优先。小屏幕情况是设计好的；大屏幕情况在其周围增加 chrome。

列表+详情模式是标准的，在多个界面中复用。设置 shell（`packages/app/src/screens/settings-screen.tsx`）和项目屏幕（`packages/app/src/screens/projects-screen.tsx`）实现方式相同：

- 在紧凑布局上：全屏列表，顶部带 `<BackHeader>`。点击行推入全屏详情页面，带自己的 `<BackHeader>` 返回到列表。
- 在桌面端：左侧 320px 侧边栏，带 `surfaceSidebar` 背景。右侧内容面板带 `<ScreenHeader>`、`<HeaderIconBadge>` 和 `<ScreenTitle>`。

分支是屏幕组件顶部的一个 `useIsCompactFormFactor()` 检查。列表和详情在两种布局中是同一个组件；只有框架变化。

工作区屏幕（`packages/app/src/screens/workspace/workspace-screen.tsx`）遵循不同但平行的规则：标签页在紧凑布局上折叠，面板在桌面端分屏。侧边栏（`packages/app/src/components/left-sidebar.tsx`）在紧凑布局上覆盖，在桌面端固定。

新的列表+详情功能拷贝设置 shell。新的工作区形状功能拷贝工作区 shell。发明第三种形状应在设计评审中进行，而非在 PR 中。

---

## 9. 文案与语气

句首字母大写。"Pair a device"、"Danger zone"、"Restart daemon"、"Inject Paseo tools"、"No sessions yet"、"Load more"。专有名词保持大小写——Paseo、Beta、Stable、Local。标题式大写是错误的。

行标题、标签或按钮末尾不要加句号。单句提示末尾不要加句号："What happens when you press Enter while the agent is running"（`packages/app/src/screens/settings-screen.tsx:271-272`）。句号存在于多句正文内部："Restarts the daemon process. The app will reconnect automatically."

空状态字符串是简短的名词短语或短句："No projects yet"、"Select a project"、"No sessions yet"（`packages/app/src/screens/sessions-screen.tsx:74-76`）、"Host not found"。

按钮是命令式：Save、Cancel、Restart、Remove、Update、Install update、Add host、Load more。进行中的标签是现在分词加字面三点的省略号："Saving..."、"Restarting..."、"Removing..."、"Loading..."。

错误文案是直接的。"Unable to remove host"（`packages/app/src/screens/settings/host-page.tsx:697`），而非"Sorry, we couldn't remove the host."。恢复指引是具体的："Wait for it to come online before restarting."。错误描述状态；不做主观评论。

术语：

- Workspace，永远不用 "checkout"。
- Host，除非面向用户的概念是守护进程本身（"Restart daemon"）。
- Project，不用 "repo" 或 "repository"。
- Provider，不用 "model provider"。
- Session 和 agent 是不同的：session 是 `sessions-screen.tsx` 中的历史条目；agent 是工作区中的活跃实体。

---

## 10. 状态

加载默认是内联的。`<LoadingSpinner size={14} color={foregroundMuted} />` 紧邻其关联内容（`packages/app/src/screens/settings/providers-section.tsx:227-231`）。页面级加载是居中的 `<LoadingSpinner size="large">`（`packages/app/src/screens/sessions-screen.tsx:69-72`）。卡片级加载是单条短线，不是旋转器。行内下拉项使用 `<DropdownMenuItem status="pending" pendingLabel="Removing...">`；菜单项处理自己的进行中状态。

空状态是简短的名词短语。居中、使用 muted 颜色、一到两行。会话屏幕将空名词与单个 ghost 按钮配对以返回导航（`packages/app/src/screens/sessions-screen.tsx:74-81`）；这种配对是最大限度的阐述。将插图和 CTA 伪装成空状态是错误的。

内联错误是 `palette.red[300]` `xs` 字号下的单句话，位于其关联的字段下方或卡片内部（`packages/app/src/screens/settings/providers-section.tsx:115-119`）。

页面级提醒——信息通知、成功确认、警告或需要在页面上有一个小型可见块的可恢复错误——使用 `<Alert>`（`packages/app/src/components/ui/alert.tsx`）。变体：`default`、`info`、`success`、`warning`、`error`。chrome 在设计上是安静的：1px 着色边框、透明背景、小型变体着色图标、标题使用变体强调色、描述使用 `foregroundMuted`。操作位于 `children` 槽位中作为 `<Button variant="outline" size="sm">`——恢复操作是低频的，outline 样式与提醒的强调色调保持安静的协调（`packages/app/src/screens/project-settings-screen.tsx`）。每个区域一次一个 `<Alert>`。

侧边栏提醒——跨整个应用的交叉提醒，如工作树设置、Rosetta 安装和桌面更新可用——通过 `useSidebarCallouts()` 注册，并经由 `<SidebarCallout>`（`packages/app/src/components/sidebar-callout.tsx`）在左侧边栏中渲染。chrome（仅顶部边框、全宽操作按钮）针对该约 280px 的列做了调优。标准来源：`packages/app/src/components/worktree-setup-callout-source.tsx`、`packages/app/src/desktop/updates/rosetta-callout-source.tsx`、`packages/app/src/desktop/updates/update-callout-source.tsx`。绝不要将 `<SidebarCallout>` 导入到页面中——那应该是 `<Alert>` 的用途。

命令式错误使用 `Alert.alert("Error", "Unable to ...")`（React Native `Alert` API，而非本组件），用于中断流程且页面上没有位置的失败。

禁用状态是外部可按压元素上的 `opacity: theme.opacity[50]`。禁用状态的颜色变化是错误的；禁用按钮是同一个按钮，更暗。

部分失败（列表大部分正常但一个来源出错）是列表上方的带边框横幅，以 red-300 `xs` 列出每个失败项（`packages/app/src/screens/projects-screen.tsx:151-159`）。列表仍然渲染。

状态在其影响的最小范围内呈现。字段错误留在字段下方；页面错误是横幅；阻塞流程的错误是 `Alert`。

---

## 11. 列表行

行的结构是一个内容列加一个可选的尾端槽位。卡片内部的行是 `settingsStyles.row`。侧边栏列表内的行自带内边距和每项的 `borderRadius.lg`（`packages/app/src/components/sidebar-workspace-list.tsx:2614-2625`）。

钻取到详情页的行在尾端槽位中带有一个 chevron（`ChevronRight`，`iconSize.sm`，`foregroundMuted`）。整行是 `<Pressable>`。配对设备行（`packages/app/src/screens/settings/host-page.tsx:644-668`）、provider 行（`packages/app/src/screens/settings/providers-section.tsx:92-132`）、项目列表中的项目行。Chevron 表示导航。

Kebab 菜单（`<DropdownMenu>` 搭配 `<MoreVertical size={14} />` 触发器）用于行上的操作而非导航。触发器样式：`padding: 2`，`borderRadius: 4`，悬停背景 `surface2`。菜单位置：`align="end"`。菜单项使用 `<DropdownMenuItem leading={<Icon size={14} color={foregroundMuted} />} ...>`。可见性为 `isHovered || isTouchPlatform`——在 web 上悬停显示，在原生上始终可见（`packages/app/src/components/sidebar-workspace-list.tsx:684-770`）。

当同时有导航和行级操作时，行可以同时带有一个 chevron 和一个 kebab。Chevron 位于末尾；kebab 位于其前面。

开关和分段控件也位于尾端槽位中。同时导航和切换的行是一个 `<Pressable>` 带一个尾端槽位中的 `<Switch>`——switch 调用 `event.stopPropagation()` 以免触发行点击（`packages/app/src/screens/settings/providers-section.tsx:92-132`）。带有状态点、计数和 kebab 的侧边栏项目遵循相同规则（`packages/app/src/components/sidebar-workspace-list.tsx`）。

桌面端列表+详情布局中行上的选中状态使用 `surfaceSidebarHover` 作为背景（`packages/app/src/screens/projects-screen.tsx`）。侧边栏列表中行上的选中状态使用 `surface2`（`packages/app/src/components/agent-list.tsx:563-571`）。

---

## 12. 状态标签和徽章

状态标签是 `palette.<color>[300]` 的前景色搭配相同颜色 10% 透明度的背景。成功使用绿色，警告使用琥珀色，危险使用红色，静音使用 zinc。`<StatusBadge>` 原语（`packages/app/src/components/ui/status-badge.tsx`）是标准方式。

状态点——主机或 agent 名称旁边的小实心圆——是 `borderRadius.full`，填充状态颜色（`statusSuccess`、`statusWarning`、`statusDanger` 或 `foregroundMuted`）。它们位于侧边栏行的尾端槽位中，或作为状态标签的前导标记。

`packages/app/src/screens/settings/host-page.tsx:97-116`、`packages/app/src/components/agent-list.tsx:607-632` 和 `packages/app/src/components/sidebar-workspace-list.tsx:2889-2894` 中的自定义标签是需要消除的偏离。新代码使用 `<StatusBadge>`。

---

## 13. 禁止事项

- 在行标题、正文文本、按钮标签、徽章文本或 `<SidebarCallout>` 标题上使用 `fontWeight.medium`。Medium 保留给第 3 节中描述的结构标签层级——区块标签、模态框/sheet 标题、密集元数据强调和紧凑操作标签。其他的都是 `normal`。`<ScreenTitle>` 是响应式 `400/300`，绝不被覆盖。
- 用 `<Pressable>` 包裹 `<Text>` 来做按钮。`<Button>` 存在。
- 在设置内部用裸 `<Text>` 做区块标题。`<SettingsSection>` 存在。
- 在详情页上放"Settings" CTA。详情页就是设置；设置通过侧边栏、主机条目或行的 kebab 菜单到达。
- 在 UI 字符串或标识符中使用 "checkout" 一词。术语是 "workspace"。
- 在调色板之外添加新的颜色 token 或硬编码十六进制值。状态标签的 rgba 背景是记录在案的模式（第 12 节），不是许可证。
- 占位符文本调暗超过 `foregroundMuted`。不要额外透明度、不用斜体、不用幽灵文本。
- `onPointerEnter` 和 `onPointerLeave`。它们在原生 iOS 上不会触发。悬停使用 Pressable 的 `onHoverIn`/`onHoverOut`，并用 `isHovered || isCompact || isNative` 门控。
- 没有 `isWeb` 守卫的原始 DOM API。
- 不在比例内的间距值。`padding: 20` 和 `gap: 10` 是错误的。
- 禁用状态的颜色变化。仅使用透明度。
- 没有 `confirmDialog` 的破坏性操作。重启、移除和未来的破坏性操作都需要确认。工作树归档仅在 git 运行时报告有未提交更改或未推送提交时才确认；干净已推送的工作树立即归档。
- 自定义状态标签。`<StatusBadge>` 是标签原语。
- 对聚焦任务使用原始 `Modal`。`<AdaptiveModalSheet>` 是模态原语。
- 直接导入 `ActivityIndicator`。`<LoadingSpinner>` 是加载原语。

---

## 14. 按模式的规范界面

| 模式                                                | 参考                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表+详情（紧凑堆叠，桌面端侧边栏+面板）              | `packages/app/src/screens/settings-screen.tsx`、`packages/app/src/screens/projects-screen.tsx`                                                                                                                                                                                                           |
| 详情卡片+行                                          | `packages/app/src/screens/settings/host-page.tsx`、`packages/app/src/screens/settings/providers-section.tsx`                                                                                                                                                                                             |
| 卡片列表内的区块分组                                  | `packages/app/src/screens/settings/settings-section.tsx`                                                                                                                                                                                                                                                 |
| 表单模态框（标签+输入字段，主要+取消）                 | `packages/app/src/components/add-host-modal.tsx`、`packages/app/src/components/pair-link-modal.tsx`、`packages/app/src/components/project-picker-modal.tsx`                                                                                                                                              |
| 破坏性确认                                            | 从 `packages/app/src/screens/settings/host-page.tsx:541-547` 调用的 `confirmDialog`                                                                                                                                                                                                                      |
| 居中的 hero / 首次运行                                | `packages/app/src/components/welcome-screen.tsx`                                                                                                                                                                                                                                                         |
| 侧边栏列表（工作区、主机）                             | `packages/app/src/components/sidebar-workspace-list.tsx`、`packages/app/src/components/left-sidebar.tsx`                                                                                                                                                                                                 |
| 带分组的活跃项列表（agent）                           | `packages/app/src/components/agent-list.tsx`                                                                                                                                                                                                                                                             |
| 历史列表（会话）                                      | `packages/app/src/screens/sessions-screen.tsx`                                                                                                                                                                                                                                                           |
| 工作区面板（多标签、分屏）                             | `packages/app/src/screens/workspace/workspace-screen.tsx`                                                                                                                                                                                                                                                |
| Composer / 消息输入                                   | `packages/app/src/components/composer.tsx`、`packages/app/src/components/message-input.tsx`                                                                                                                                                                                                              |
| 带单条底边的面板 chrome                               | `packages/app/src/components/git-diff-pane.tsx`、`packages/app/src/components/file-explorer-pane.tsx`、`packages/app/src/components/terminal-pane.tsx`                                                                                                                                                   |
| 页面级提醒（info / success / warning / error）        | `packages/app/src/components/ui/alert.tsx`、`packages/app/src/screens/project-settings-screen.tsx`                                                                                                                                                                                                       |
| 侧边栏提醒（交叉关注提醒）                             | `packages/app/src/components/sidebar-callout.tsx`、`packages/app/src/contexts/sidebar-callout-context.tsx`、`packages/app/src/components/worktree-setup-callout-source.tsx`、`packages/app/src/desktop/updates/rosetta-callout-source.tsx`、`packages/app/src/desktop/updates/update-callout-source.tsx` |
| 可搜索选择器                                          | `packages/app/src/components/ui/combobox.tsx`、`packages/app/src/components/branch-switcher.tsx`                                                                                                                                                                                                         |
| 触发器锚定菜单                                        | `packages/app/src/components/ui/dropdown-menu.tsx`（用于 `sidebar-workspace-list.tsx`、主题选择器）                                                                                                                                                                                                      |
| 右键/长按菜单                                         | `packages/app/src/components/ui/context-menu.tsx`（用于 `sidebar-workspace-list.tsx`）                                                                                                                                                                                                                   |
| 标题栏（后退、屏幕、菜单）                             | `packages/app/src/components/headers/back-header.tsx`、`screen-header.tsx`、`menu-header.tsx`                                                                                                                                                                                                            |
