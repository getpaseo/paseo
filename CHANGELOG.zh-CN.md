# 更新日志

## 0.13.0-beta.1 - 2026-10-22

折叠屏手机布局、可将工作委派给其他机器的 Agent、插件文件面板，以及插件翻译。

将你的 daemon 连接到另一台机器，然后让 Agent 把工作委派过去：

```sh
paseo host add 192.168.1.20:6767 --label studio
paseo host add 'ssh://me@build-box' --label build-box
paseo host add 'relay://...' --label laptop
```

### 新增

- 新增对 iPhone Duo 等折叠屏手机的支持，展开后切换到宽屏布局 ([#7424](https://github.com/getpaseo/paseo/pull/7424))
- 新增已连接主机，Agent 可以在其他机器上创建、提示和监控 Agent，并在 Subagents 中查看它们 ([#7370](https://github.com/getpaseo/paseo/pull/7370), [#7593](https://github.com/getpaseo/paseo/pull/7593))
- 新增简体中文版 paseo.sh，地址为 [paseo.sh/zh-CN](https://paseo.sh/zh-CN) ([#7373](https://github.com/getpaseo/paseo/pull/7373))
- Changes 窗格新增 All changes 并设为默认，在一个 diff 中显示自分支基点以来已提交和未提交的工作 ([#7576](https://github.com/getpaseo/paseo/pull/7576))
- 如果进入 Plan 前开启了 Auto，Claude 计划审批新增 Implement with Auto mode ([#7453](https://github.com/getpaseo/paseo/pull/7453))

### 改进

- 新建工作区中的 Host 字段现在始终显示，其菜单末尾为 Add host ([#7580](https://github.com/getpaseo/paseo/pull/7580))
- 文件标签页的 Preview/Source 切换改为在该文件的各个面板之间切换 ([#7411](https://github.com/getpaseo/paseo/pull/7411))
- Explorer 在手机、平板和桌面上使用相同的标签页和启动器 ([#7424](https://github.com/getpaseo/paseo/pull/7424))
- 手机上的 Explorer 标签页保留完整标签并可滚动，关闭操作移到了长按菜单中 ([#7589](https://github.com/getpaseo/paseo/pull/7589))
- 用量行现在用应用的语言说明百分比是已用还是剩余 ([#7376](https://github.com/getpaseo/paseo/pull/7376) by [@michaelmwu](https://github.com/michaelmwu))
- Agent 的报告和完成通知现在合并为一条消息发送给父 Agent ([#7561](https://github.com/getpaseo/paseo/pull/7561))
- 不再向未显示该工作区 Setup 面板的应用发送工作区的 Setup 输出 ([#7407](https://github.com/getpaseo/paseo/pull/7407), [#7473](https://github.com/getpaseo/paseo/pull/7473))
- iOS 和 Android 上隐藏面板中的状态环动画现在会暂停 ([#7423](https://github.com/getpaseo/paseo/pull/7423) by [@peterkeen](https://github.com/peterkeen))
- 应用启动时只加载所选语言的翻译，减少了启动工作量 ([#7410](https://github.com/getpaseo/paseo/pull/7410) by [@colonelpanic8](https://github.com/colonelpanic8))
- 工作区布局未变化时不再重复保存 ([#7358](https://github.com/getpaseo/paseo/pull/7358) by [@colonelpanic8](https://github.com/colonelpanic8))

### 插件

- 新增[文件面板](https://paseo.sh/zh-CN/docs/plugins/reference#file-panels)，插件可以在文件标签页中打开匹配的文件，例如 PDF 查看器或富文本 Markdown 编辑器 ([#7411](https://github.com/getpaseo/paseo/pull/7411), [#7366](https://github.com/getpaseo/paseo/pull/7366))
- 新增[插件翻译](https://paseo.sh/zh-CN/docs/plugins/reference#runtime-translations)，插件内容和标签会跟随应用的语言 ([#7478](https://github.com/getpaseo/paseo/pull/7478))
- 新增插件列表翻译，可通过 `paseo-plugin.json` 中的 `translations` 和 `OVERVIEW.zh-CN.md` 提供 ([#7373](https://github.com/getpaseo/paseo/pull/7373))
- `@getpaseo/plugin/client/ui` 新增 `Markdown`，可使用 Paseo 的渲染器渲染 Markdown ([#7579](https://github.com/getpaseo/paseo/pull/7579))
- 所有插件 `icon` 新增对内联 SVG 和组件图标的支持 ([#7368](https://github.com/getpaseo/paseo/pull/7368))
- 所有插件 UI 导入改为 `@getpaseo/plugin/client/ui`；原入口仍可使用，但已弃用 ([#7474](https://github.com/getpaseo/paseo/pull/7474))
- turn-ended hook 现在发送空的 `timeline`；请改用 `timeline.refetch` 获取最近的历史记录 ([#7477](https://github.com/getpaseo/paseo/pull/7477))
- 修复了 notification 时间线转换器加载失败并报错 "invalid item type: notification" 的问题 ([#7582](https://github.com/getpaseo/paseo/pull/7582) by [@Gavinchen92](https://github.com/Gavinchen92))

### 修复

- 修复了 daemon 重启后 Agent 仍显示为运行中的问题 ([#7573](https://github.com/getpaseo/paseo/pull/7573))
- 修复了导入或恢复的聊天中 Claude 系统上下文显示为助手消息的问题 ([#7590](https://github.com/getpaseo/paseo/pull/7590) by [@khevamann](https://github.com/khevamann), [@rogerluan](https://github.com/rogerluan))
- 修复了应用加载后立即离开或重新加载时已保存的工作区标签页丢失的问题 ([#7547](https://github.com/getpaseo/paseo/pull/7547))
- 修复了 Markdown 预览中的相对链接从工作区根目录而不是文档所在文件夹解析的问题 ([#7538](https://github.com/getpaseo/paseo/pull/7538))
- 修复了 Android 上更改字体大小后添加图片失败并提示“选择图片失败”的问题 ([#7546](https://github.com/getpaseo/paseo/pull/7546) by [@RRD-dev](https://github.com/RRD-dev), [@idoyana](https://github.com/idoyana), [@luoph](https://github.com/luoph))
- 修复了 Android 上弹出框、提示和上下文菜单在触发元素下方偏移一个状态栏高度打开的问题 ([#7589](https://github.com/getpaseo/paseo/pull/7589))
- 修复了浅色主题中当前 Explorer 标签页不可见的问题 ([#7589](https://github.com/getpaseo/paseo/pull/7589))
- 修复了 Android 上不受信任的证书显示 "Host not found" 而不是 TLS 错误的问题 ([#7429](https://github.com/getpaseo/paseo/pull/7429))
- 修复了 Android 上键盘遮挡已聚焦的设置字段的问题 ([#7362](https://github.com/getpaseo/paseo/pull/7362))
- 修复了紧凑 Changes 菜单中 Pull 或 Push 出现两次的问题 ([#7355](https://github.com/getpaseo/paseo/pull/7355) by [@az33zy](https://github.com/az33zy))
- 修复了“跳转到标签”和“跳转到 workspace”可以保存不以数字结尾的快捷键的问题 ([#7365](https://github.com/getpaseo/paseo/pull/7365))
- 修复了 `paseo agent archive` 对前 200 个之后的 Agent 报告 `AGENT_NOT_FOUND` 的问题 ([#7535](https://github.com/getpaseo/paseo/pull/7535) by [@L4XB](https://github.com/L4XB), [@hteo1337](https://github.com/hteo1337))
- 修复了读取历史记录后已归档的 Agent 重新出现在 MCP `list_agents` 中的问题 ([#7532](https://github.com/getpaseo/paseo/pull/7532) by [@thomasvan](https://github.com/thomasvan))
- 修复了使用 `notifyOnFinish` 创建的分离 Agent 从不通知其创建者的问题 ([#7528](https://github.com/getpaseo/paseo/pull/7528) by [@thomasvan](https://github.com/thomasvan))
- 修复了 OpenCode Agent 被告知 `notifyOnFinish` 默认关闭的问题 ([#7383](https://github.com/getpaseo/paseo/pull/7383) by [@gszep](https://github.com/gszep))
- 修复了恢复被拒绝时 Pi 子 Agent 行仍显示为运行中的问题 ([#7369](https://github.com/getpaseo/paseo/pull/7369))
- 修复了 Android 源码构建下载第二个 NDK 的问题 ([#7403](https://github.com/getpaseo/paseo/pull/7403) by [@dwyanewang](https://github.com/dwyanewang))
- 修复了 Nix 包将许可证报告为 AGPL 而不是 Apache-2.0 的问题 ([#7415](https://github.com/getpaseo/paseo/pull/7415))

## 0.12.0 - 2026-10-19

后台工作区、新的 Markdown 渲染器（手机上可跨段落选择文本）、重新设计的手机布局，以及超过 120 项修复。

**升级前须知**：`paseo run --background` 已弃用，请改用 `--no-wait`；当 daemon 在 15 秒内未确认时，`paseo permit allow` 和 `deny` 现在会以非零状态退出

### 新增

- 新增后台工作区，除非开启 Show background，否则不会显示在侧边栏中 ([#5039](https://github.com/getpaseo/paseo/pull/5039), [#7141](https://github.com/getpaseo/paseo/pull/7141) by [@gpambrozio](https://github.com/gpambrozio), [@marvin-ambrozio](https://github.com/marvin-ambrozio))
- 在 diff 窗格中新增 Send feedback 按钮，无需打开 Agent 的聊天即可把审查评论发送给它 ([#6455](https://github.com/getpaseo/paseo/pull/6455))
- 在手机上新增全屏 Composer ([#6531](https://github.com/getpaseo/paseo/pull/6531), [#6902](https://github.com/getpaseo/paseo/pull/6902), [#6945](https://github.com/getpaseo/paseo/pull/6945), [#6987](https://github.com/getpaseo/paseo/pull/6987), [#7130](https://github.com/getpaseo/paseo/pull/7130), [#7170](https://github.com/getpaseo/paseo/pull/7170))
- 一个 Agent 发给另一个 Agent 的消息现在会显示发送者的名称 ([#6373](https://github.com/getpaseo/paseo/pull/6373))
- 当已安装的 Claude Code 提供 Claude Mythos 5.1 时新增该模型 ([#6403](https://github.com/getpaseo/paseo/pull/6403))
- Claude 问题卡片新增选项预览 ([#6171](https://github.com/getpaseo/paseo/pull/6171) by [@gabrielgiordan](https://github.com/gabrielgiordan))
- 新增 `paseo usage`，可在 CLI 中查看账号配额、余额和重置时间 ([#6474](https://github.com/getpaseo/paseo/pull/6474))

### 改进

- iOS 和 Android 上回复中的文本选择现在可以跨越段落、标题和列表 ([#6973](https://github.com/getpaseo/paseo/pull/6973))
- iOS 和 Android 上的代码块新增复制按钮 ([#6973](https://github.com/getpaseo/paseo/pull/6973))
- iOS 和 Android 上较宽的 Markdown 表格现在可以横向滚动 ([#6973](https://github.com/getpaseo/paseo/pull/6973))
- 手机布局改为浮动的标题栏 ([#6431](https://github.com/getpaseo/paseo/pull/6431))
- 手机上的 New agent 和 New terminal 移到了标签页切换器中 ([#6431](https://github.com/getpaseo/paseo/pull/6431))
- 手机上的工作区脚本移到了 ⋯ → Scripts 中，并显示正在运行的内容 ([#7122](https://github.com/getpaseo/paseo/pull/7122))
- 手机上的文件和子 Agent 改为在可关闭的底部面板中打开，子 Agent 还可以 Open as tab ([#6827](https://github.com/getpaseo/paseo/pull/6827), [#6885](https://github.com/getpaseo/paseo/pull/6885), [#6958](https://github.com/getpaseo/paseo/pull/6958))
- 手机上的 diff 评论改为在底部面板中打开，而不是在代码中嵌入编辑器 ([#6455](https://github.com/getpaseo/paseo/pull/6455))
- 手机上的 Settings 改为大图块，并分为 App 和 Host 两组 ([#7129](https://github.com/getpaseo/paseo/pull/7129))
- Command Center 现在按匹配度和最近使用对工作区和 Agent 排序，并显示时间戳、项目图标和高亮的匹配内容 ([#7277](https://github.com/getpaseo/paseo/pull/7277))
- 子 Agent 列表中每个 Paseo 子 Agent 的标题下方新增其模型、思考、模式和上下文 ([#7290](https://github.com/getpaseo/paseo/pull/7290))
- 手机上 Subagents 面板中的子 Agent 行更高了，其归档和分离按钮也使用了标准的按压高亮 ([#7364](https://github.com/getpaseo/paseo/pull/7364))
- 聊天中的 Paseo 工具调用现在以操作及其上下文开头，例如 Send message · 提示词的第一行 ([#7283](https://github.com/getpaseo/paseo/pull/7283))
- 手机上的 New workspace 表单改为全宽字段，Import session 移到了标题栏 ([#7239](https://github.com/getpaseo/paseo/pull/7239))
- 减少了回复流式输出时长聊天的渲染工作量 ([#7052](https://github.com/getpaseo/paseo/pull/7052) by [@colonelpanic8](https://github.com/colonelpanic8), [#7342](https://github.com/getpaseo/paseo/pull/7342))
- 重新打开侧边栏的速度提升约 45% ([#7157](https://github.com/getpaseo/paseo/pull/7157))
- 应用重新连接后，项目和工作区加载更快 ([#7242](https://github.com/getpaseo/paseo/pull/7242))
- 一个 Agent 通过 CLI 或 MCP 发给另一个 Agent 的消息现在会引导其正在进行的回合，而不是中断它 ([#5164](https://github.com/getpaseo/paseo/pull/5164) by [@derwells](https://github.com/derwells))
- Gitea 和 Forgejo 的 fork PR 检出现在会在分支名中包含 fork 所有者，例如 `bob/patch-1` ([#6829](https://github.com/getpaseo/paseo/pull/6829) by [@alexanderadam](https://github.com/alexanderadam))

### 插件

- 修复了导入 Paseo 协议类型的插件安装失败并提示 "Could not resolve type dependency" 的问题 ([#7023](https://github.com/getpaseo/paseo/pull/7023))
- 修复了移动应用上的插件中 `providers.waitForReady` 抛出错误的问题 ([#6760](https://github.com/getpaseo/paseo/pull/6760) by [@GeorgeR](https://github.com/GeorgeR))
- 修复了聊天大纲无法跳转到由时间线插件渲染的提示词的问题 ([#6690](https://github.com/getpaseo/paseo/pull/6690) by [@lukeRRD](https://github.com/lukeRRD))
- 修复了按 Escape 会停止正在运行的 Agent，而不是先关闭打开的插件预览的问题 ([#7110](https://github.com/getpaseo/paseo/pull/7110) by [@RRD-dev](https://github.com/RRD-dev), [@luoph](https://github.com/luoph))
- 修复了 `paseo plugin reload` 在重新加载仍在进行时因 60 秒超时而失败的问题 ([#6306](https://github.com/getpaseo/paseo/pull/6306) by [@Mtuchel](https://github.com/Mtuchel))
- 修复了插件 ACP Agent 运行期间发送的后续消息失败并提示 "Provider does not support prompt.steer" 的问题 ([#7270](https://github.com/getpaseo/paseo/pull/7270) by [@simonepri](https://github.com/simonepri))
- 修复了 Find 在时间线插件绘制的提示词文本中找不到匹配的问题 ([#7253](https://github.com/getpaseo/paseo/pull/7253) by [@a-grasso](https://github.com/a-grasso))
- 修复了重新打开聊天后，延迟加载的 Composer 插件胶囊遮挡 Copy 和 Fork 的问题 ([#7341](https://github.com/getpaseo/paseo/pull/7341) by [@sholiday](https://github.com/sholiday))

### 修复

- 修复了 iOS 回复中的列表项渲染为空白，以及调整大小或旋转后文本保持旧宽度的问题 ([#6973](https://github.com/getpaseo/paseo/pull/6973))
- 修复了插件宿主、CLI 和桌面应用运行 30 到 75 分钟后内存增长到约 1 GB 的问题 ([#6847](https://github.com/getpaseo/paseo/pull/6847) by [@babo-jeonguk](https://github.com/babo-jeonguk))
- 修复了 OpenCode v2 长时间的回复或推理流导致 daemon 内存耗尽的问题 ([#6262](https://github.com/getpaseo/paseo/pull/6262))
- 修复了已归档的 ACP Agent 每次加载时间线都会启动一个持续运行的 Provider 进程的问题 ([#6766](https://github.com/getpaseo/paseo/pull/6766) by [@apple-ouyang](https://github.com/apple-ouyang))
- 修复了过大的附件导致主机循环断开连接，而不是报告大小错误的问题 ([#6285](https://github.com/getpaseo/paseo/pull/6285))
- 修复了通过中继、SSH 或 socket 连接的主机上 Files 中的 Download 失败的问题 ([#6595](https://github.com/getpaseo/paseo/pull/6595) by [@odoo-mvds](https://github.com/odoo-mvds), [@YASICJUNWOO](https://github.com/YASICJUNWOO), [@JrDw0](https://github.com/JrDw0))
- 修复了使用自定义 Git diff 设置（例如 `color.diff=always` 或外部 diff 命令）时 Changes 不显示 diff 行的问题 ([#6536](https://github.com/getpaseo/paseo/pull/6536), [#6562](https://github.com/getpaseo/paseo/pull/6562) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了在 Appearance 中输入不完整的字体名称会破坏应用样式的问题 ([#6695](https://github.com/getpaseo/paseo/pull/6695))
- 修复了隐藏窗口没有渲染任何帧时 Linux 桌面窗口始终不出现的问题 ([#6726](https://github.com/getpaseo/paseo/pull/6726) by [@EhEo](https://github.com/EhEo))
- 修复了同一主机上另一个 Agent 正在流式输出时，打开其他 Agent 或工作区会卡住的问题 ([#7074](https://github.com/getpaseo/paseo/pull/7074) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了项目的新建工作区按钮选中第一个主机，而不是当前工作区所在主机的问题 ([#7308](https://github.com/getpaseo/paseo/pull/7308))
- 修复了在触屏浏览器中用键盘快捷键切换标签页后，Composer 仍保持聚焦的问题 ([#7352](https://github.com/getpaseo/paseo/pull/7352))
- 修复了在大型目录树上同时进行多个目录搜索时 daemon 内存耗尽的问题 ([#7265](https://github.com/getpaseo/paseo/pull/7265))
- 修复了打开多个窗格时拖动 Explorer 边缘卡顿的问题 ([#7284](https://github.com/getpaseo/paseo/pull/7284) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了 Provider 拒绝第一条提示词时，创建 Agent 显示错误和重试草稿的问题 ([#6379](https://github.com/getpaseo/paseo/pull/6379))
- 修复了主机断开时新 Agent 草稿一直停留在 "Loading…" 的问题；现在会显示 "Host is not connected" 并保留你的草稿 ([#7303](https://github.com/getpaseo/paseo/pull/7303) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了在流式回复期间重新加载聊天会在实时回复上方显示一份冻结的副本并丢失结尾的问题 ([#7256](https://github.com/getpaseo/paseo/pull/7256))
- 修复了答案发送失败时问题卡片一直转圈的问题；现在会显示错误并保留你的答案 ([#7098](https://github.com/getpaseo/paseo/pull/7098) by [@xzthemeofsss](https://github.com/xzthemeofsss))
- 修复了子 Agent 很快完成第一个回合时父 Agent 收不到完成通知的问题 ([#6008](https://github.com/getpaseo/paseo/pull/6008) by [@ahmet-izgi](https://github.com/ahmet-izgi))
- 修复了子 Agent 的任务被停止或重新加载时父 Agent 被告知子 Agent 已完成的问题 ([#6660](https://github.com/getpaseo/paseo/pull/6660) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了包含 U+2028 或 U+2029 的 Codex 聊天在 Node 24 上无法重新打开的问题 ([#5999](https://github.com/getpaseo/paseo/pull/5999) by [@grahameger](https://github.com/grahameger), [@jtsang4](https://github.com/jtsang4), [@kotusenka](https://github.com/kotusenka))
- 修复了恢复的 Codex 目标在继续执行后显示为空闲、且无法停止的问题 ([#7339](https://github.com/getpaseo/paseo/pull/7339) by [@hemaaanth](https://github.com/hemaaanth))
- 修复了 macOS 上 Add Project 的目录搜索进入 `~/Library` 后导致 daemon 挂起的问题 ([#5789](https://github.com/getpaseo/paseo/pull/5789) by [@lardissone](https://github.com/lardissone))
- 修复了保存的模式不被 Provider 提供时 New workspace 失败并提示 "Invalid mode" 的问题 ([#5847](https://github.com/getpaseo/paseo/pull/5847) by [@mcowger](https://github.com/mcowger))
- 修复了回答 OpenCode v2 的多选问题失败并提示 "Invalid answer" 的问题 ([#6149](https://github.com/getpaseo/paseo/pull/6149) by [@gammons](https://github.com/gammons))
- 修复了 OpenCode v2 Agent 上浏览器截图导致回合失败的问题 ([#6330](https://github.com/getpaseo/paseo/pull/6330))
- 修复了 OpenCode v2 Agent 收到 "HTTP 500" 而不是 Paseo 工具错误的问题 ([#6519](https://github.com/getpaseo/paseo/pull/6519))
- 修复了 OpenCode Agent 使用无效参数或未知名称调用 Paseo 工具时收到 "HTTP 500" 而不是可读错误的问题 ([#7183](https://github.com/getpaseo/paseo/pull/7183))
- 修复了 Provider 设置了 `CLAUDE_CONFIG_DIR` 时回退 Claude 对话失败并提示 "Session not found" 的问题 ([#6325](https://github.com/getpaseo/paseo/pull/6325))
- 修复了先修改正在运行的 Claude Agent 的思考级别、再修改其模式会终止其正在运行的命令的问题 ([#7179](https://github.com/getpaseo/paseo/pull/7179))
- 修复了 Provider 命令是包装脚本时需要较新 Claude Code 的 Claude 模型被隐藏的问题 ([#7209](https://github.com/getpaseo/paseo/pull/7209) by [@SulthanZahran1](https://github.com/SulthanZahran1))
- 修复了后台 Claude 子 Agent 卡片在子 Agent 工作期间（包括父 Agent 完成之后）一直为空的问题 ([#6242](https://github.com/getpaseo/paseo/pull/6242), [#7266](https://github.com/getpaseo/paseo/pull/7266))
- 修复了选择 Allow All 之后 Copilot 仍停留在 Plan 模式并拒绝编辑的问题 ([#7234](https://github.com/getpaseo/paseo/pull/7234))
- 修复了导入的 Claude Code 会话以第一条提示词而不是 `/rename` 标题作为名称的问题 ([#6930](https://github.com/getpaseo/paseo/pull/6930) by [@platanus-kr](https://github.com/platanus-kr))
- 修复了对 Claude 问题给出格式错误的答案时报告成功并丢弃该问题的问题 ([#6936](https://github.com/getpaseo/paseo/pull/6936) by [@thomasvan](https://github.com/thomasvan))
- 修复了 Cursor Agent 的上下文详情中不显示套餐用量的问题 ([#6353](https://github.com/getpaseo/paseo/pull/6353) by [@gengjiawen](https://github.com/gengjiawen))
- 修复了代理在响应结束时报告输入用量时，Claude 上下文计量只统计输出 token 的问题 ([#6703](https://github.com/getpaseo/paseo/pull/6703) by [@kywoo26](https://github.com/kywoo26))
- 修复了切换回 200k 模型后 Claude 上下文计量仍显示 1M 上限的问题 ([#6814](https://github.com/getpaseo/paseo/pull/6814))
- 修复了自定义 Claude `[1m]` 模型在第一个回合期间上下文计量一直为空的问题 ([#6767](https://github.com/getpaseo/paseo/pull/6767))
- 修复了定时任务的某次运行无法记录后该定时任务再也不运行的问题 ([#6334](https://github.com/getpaseo/paseo/pull/6334))
- 修复了共享同一 cron 分钟的定时任务会把一个时段运行两次并跳过下一次的问题 ([#6532](https://github.com/getpaseo/paseo/pull/6532) by [@keithpk](https://github.com/keithpk))
- 修复了从已有分支创建的 worktree 在 Committed 中不显示更改的问题 ([#6462](https://github.com/getpaseo/paseo/pull/6462) by [@cr-2takumax](https://github.com/cr-2takumax))
- 修复了在仓库子目录打开的工作区中 Changes 的 Discard 和提交 diff 的问题 ([#6777](https://github.com/getpaseo/paseo/pull/6777), [#6801](https://github.com/getpaseo/paseo/pull/6801), [#6882](https://github.com/getpaseo/paseo/pull/6882) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了重命名并编辑过的文件在 Changes 中每一行都显示为新增的问题 ([#6559](https://github.com/getpaseo/paseo/pull/6559))
- 修复了从某个提交打开的重命名文件显示为新文件的问题 ([#6895](https://github.com/getpaseo/paseo/pull/6895))
- 修复了文件名包含引号、反斜杠或制表符时 Changes 不显示 diff 的问题 ([#6583](https://github.com/getpaseo/paseo/pull/6583) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 Changes 丢失以 `--` 开头的删除行（例如 SQL 注释）的问题 ([#6569](https://github.com/getpaseo/paseo/pull/6569) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了干净的工作区在第一次编辑后 Diff 标签页一直转圈的问题 ([#6745](https://github.com/getpaseo/paseo/pull/6745))
- 修复了在添加时还不是 Git 仓库的项目中运行 `git init` 后创建 worktree 失败的问题 ([#6785](https://github.com/getpaseo/paseo/pull/6785))
- 修复了新 worktree 在设置完成后不打开 `paseo.json` 中配置的终端的问题 ([#6999](https://github.com/getpaseo/paseo/pull/6999) by [@davidyang](https://github.com/davidyang))
- 修复了新添加到 `paseo.json` 的服务在 daemon 重启之前无法启动的问题 ([#6542](https://github.com/getpaseo/paseo/pull/6542))
- 修复了服务只监听 IPv6 localhost 时工作区服务 URL 返回 502 的问题 ([#6753](https://github.com/getpaseo/paseo/pull/6753) by [@marcelocastrobarbosa](https://github.com/marcelocastrobarbosa))
- 修复了命令缺失或立即退出时终端无法关闭的问题 ([#6792](https://github.com/getpaseo/paseo/pull/6792) by [@KiraPC](https://github.com/KiraPC))
- 修复了 MCP 终端按键命令输入方向键和修饰键的名称，而不是发送这些按键的问题 ([#7343](https://github.com/getpaseo/paseo/pull/7343) by [@Aling33](https://github.com/Aling33))
- 修复了返回工作区后，原生终端中 CJK 文本的字符之间多出空格的问题 ([#6452](https://github.com/getpaseo/paseo/pull/6452) by [@jasonhnd](https://github.com/jasonhnd), [@liujin0506](https://github.com/liujin0506), [@seob717](https://github.com/seob717))
- 修复了在 iOS 和 Android 上从终端复制韩文文本时字符之间多出空格或丢失第一个字符的问题 ([#7254](https://github.com/getpaseo/paseo/pull/7254), [#7260](https://github.com/getpaseo/paseo/pull/7260) by [@helloimdevman](https://github.com/helloimdevman))
- 修复了在 iOS 和 Android 上长按终端中的韩文单词时只选中一个字符、而不是整个单词的问题 ([#7353](https://github.com/getpaseo/paseo/pull/7353))
- 修复了自托管的 Web 应用通过 80 或 443 端口上的反向代理连接失败的问题 ([#6638](https://github.com/getpaseo/paseo/pull/6638) by [@kiawin](https://github.com/kiawin))
- 修复了网络静默故障后 Hub 连接再也不会重连的问题 ([#7315](https://github.com/getpaseo/paseo/pull/7315))
- 修复了另一个解析出的地址不可达时，远程连接在慢速网络上失败的问题 ([#7336](https://github.com/getpaseo/paseo/pull/7336))
- 修复了助手回复中包含空格或非 ASCII 字符的文件链接以 ENOENT 失败的问题 ([#6520](https://github.com/getpaseo/paseo/pull/6520) by [@apple-ouyang](https://github.com/apple-ouyang), [@sunshinehomeyu-blip](https://github.com/sunshinehomeyu-blip))
- 修复了 Agent 回复中路径包含空格或非 ASCII 字符的本地图片无法加载的问题 ([#6877](https://github.com/getpaseo/paseo/pull/6877))
- 修复了 Markdown 文件预览不显示通过相对路径引用的图片的问题 ([#6750](https://github.com/getpaseo/paseo/pull/6750) by [@apple-ouyang](https://github.com/apple-ouyang))
- 修复了聊天和 Markdown 预览中的文件夹链接打开错误标签页或没有反应的问题；现在会打开 Files 并显示该文件夹的内容 ([#7205](https://github.com/getpaseo/paseo/pull/7205), [#7210](https://github.com/getpaseo/paseo/pull/7210), [#7229](https://github.com/getpaseo/paseo/pull/7229))
- 修复了指向某些类型文件的 Markdown 链接（例如 `[Capture](capture.png)`）没有反应的问题 ([#7233](https://github.com/getpaseo/paseo/pull/7233))
- 修复了 iOS 侧边栏行在短暂按住后保持高亮并吞掉下一次点击的问题 ([#7159](https://github.com/getpaseo/paseo/pull/7159) by [@kassamkhoja](https://github.com/kassamkhoja))
- 修复了 Android 上长按选择文本时聊天会滚动的问题 ([#7131](https://github.com/getpaseo/paseo/pull/7131) by [@RRD-dev](https://github.com/RRD-dev), [@luoph](https://github.com/luoph))
- 修复了在触摸设备上点击侧边栏行、底部按钮和 Settings 项时没有反馈的问题 ([#7150](https://github.com/getpaseo/paseo/pull/7150))
- 修复了较矮的手机屏幕上主屏幕操作被截断的问题 ([#7167](https://github.com/getpaseo/paseo/pull/7167))
- 修复了其他应用播放音频时 Android 语音输入停止并提示 "Dictation was interrupted by another audio source" 的问题 ([#7200](https://github.com/getpaseo/paseo/pull/7200))
- 修复了点击消息或关闭 Find 之后 Page Up 和 Page Down 无法滚动聊天的问题 ([#7033](https://github.com/getpaseo/paseo/pull/7033), [#7263](https://github.com/getpaseo/paseo/pull/7263) by [@panta82](https://github.com/panta82))
- 修复了 Add Project 的键盘选择移动到滚出视图的目录的问题 ([#7081](https://github.com/getpaseo/paseo/pull/7081) by [@superheher](https://github.com/superheher))
- 修复了按 Enter 会把 Composer 中的电子邮件地址替换为文件提及的问题 ([#6471](https://github.com/getpaseo/paseo/pull/6471) by [@jasonhnd](https://github.com/jasonhnd))
- 修复了使用俄语等非拉丁键盘布局时字母快捷键不生效的问题 ([#6755](https://github.com/getpaseo/paseo/pull/6755))
- 修复了在 Dvorak 等布局上录制快捷键时保存的是 QWERTY 键而不是输入的字母的问题 ([#6652](https://github.com/getpaseo/paseo/pull/6652))
- 修复了重新绑定 Jump to tab 或 Jump to workspace 时只保留按下的数字而不是 1–9 的问题；请重新录制已有的覆盖设置 ([#7065](https://github.com/getpaseo/paseo/pull/7065) by [@dbunk903](https://github.com/dbunk903))
- 修复了 Previous 和 Next workspace 快捷键在第 9 个工作区处停止的问题 ([#6586](https://github.com/getpaseo/paseo/pull/6586) by [@IEatCodeDaily](https://github.com/IEatCodeDaily))
- 修复了 Light 主题下以及系统主题变化后 Android 状态栏图标难以辨认的问题 ([#6707](https://github.com/getpaseo/paseo/pull/6707) by [@terayang](https://github.com/terayang))
- 修复了 iOS 和 Android 上配对二维码被裁切的问题 ([#6758](https://github.com/getpaseo/paseo/pull/6758) by [@fdkevin0](https://github.com/fdkevin0))
- 修复了启动器停止读取控制台输出时 Linux 桌面端出现 `write EPIPE` 错误对话框的问题 ([#6639](https://github.com/getpaseo/paseo/pull/6639))
- 修复了通过 SSH 执行 `paseo permit allow` 和 `deny` 时报告成功但请求仍处于待处理状态的问题 ([#6607](https://github.com/getpaseo/paseo/pull/6607) by [@budivoogt](https://github.com/budivoogt))
- 修复了名称以两个点开头的文件和文件夹（例如 `..notes.txt`）被隐藏和拒绝的问题 ([#6604](https://github.com/getpaseo/paseo/pull/6604), [#6720](https://github.com/getpaseo/paseo/pull/6720) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 Markdown 预览在非 HTML 的 `<`（例如 `List<Item>`）之后丢失表格行的问题 ([#6370](https://github.com/getpaseo/paseo/pull/6370) by [@gengjiawen](https://github.com/gengjiawen))
- 修复了 HTML 标题包含带链接的图片时显示字面标题标签的问题 ([#6650](https://github.com/getpaseo/paseo/pull/6650))
- 修复了包含空 `{}` 表达式的 Astro diff 无法渲染的问题 ([#6763](https://github.com/getpaseo/paseo/pull/6763))
- 修复了 ACP Provider 的自动补全中缺少斜杠命令参数提示的问题 ([#6920](https://github.com/getpaseo/paseo/pull/6920) by [@bwestlund17](https://github.com/bwestlund17))
- 修复了配置为 `agy` 图标的终端配置显示通用机器人图标而不是 Antigravity 图标的问题 ([#6938](https://github.com/getpaseo/paseo/pull/6938) by [@noahg9](https://github.com/noahg9))
- 修复了 Pi 扩展修改 Pi 思考级别后该级别没有更新的问题 ([#6741](https://github.com/getpaseo/paseo/pull/6741))
- 修复了来自 `@tintinweb/pi-subagents` 的 Pi 子 Agent 在达到回合上限后仍保持运行的问题 ([#6594](https://github.com/getpaseo/paseo/pull/6594) by [@Chen-DaYi](https://github.com/Chen-DaYi))
- 修复了在 OMP Agent 上手动执行 `/compact` 时不显示进度并且上下文计量不更新的问题 ([#6106](https://github.com/getpaseo/paseo/pull/6106))
- 修复了发给空闲 OMP Agent 的后续消息一直排队而不是启动该 Agent 的问题 ([#7169](https://github.com/getpaseo/paseo/pull/7169) by [@nhthung](https://github.com/nhthung))
- 修复了语音模式的 TTS 拒绝来自 OpenAI 兼容服务器的模型和声音名称的问题 ([#6060](https://github.com/getpaseo/paseo/pull/6060) by [@khimaros](https://github.com/khimaros))
- 修复了 xhigh 思考选项显示 "Extra high" 而不是其配置的标签的问题 ([#6005](https://github.com/getpaseo/paseo/pull/6005) by [@EliorFureraj](https://github.com/EliorFureraj))
- 修复了 Provider 设置中自定义模型名称较长时 Remove 按钮超出屏幕的问题 ([#6507](https://github.com/getpaseo/paseo/pull/6507))
- 修复了起始 ref 选择器无法按编号找到 GitLab 合并请求和 issue 的问题 ([#6525](https://github.com/getpaseo/paseo/pull/6525))
- 修复了起始 ref 选择器隐藏只在描述中匹配的变更请求的问题 ([#6558](https://github.com/getpaseo/paseo/pull/6558))
- 修复了 @ 提及找不到 `.cursor/plans` 下的计划文件的问题 ([#6641](https://github.com/getpaseo/paseo/pull/6641) by [@chyendongnhanh338](https://github.com/chyendongnhanh338))
- 修复了保存设置时 Paseo 把作为符号链接的 `config.json` 替换为普通文件的问题 ([#6023](https://github.com/getpaseo/paseo/pull/6023))
- 修复了发布的配置 schema 拒绝 `agentProfiles` 和 `plugins` 等有效设置的问题 ([#6621](https://github.com/getpaseo/paseo/pull/6621) by [@ragokan](https://github.com/ragokan))
- 修复了复制文件夹会把其中的相对符号链接变成指向原始位置的绝对链接的问题 ([#6771](https://github.com/getpaseo/paseo/pull/6771) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了当某个已跟踪文件把未跟踪文件（例如 `[id].tsx`）当作模式匹配时，重命名该文件失败的问题 ([#6573](https://github.com/getpaseo/paseo/pull/6573) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了保存名称较长的工作区文件时以 `ENAMETOOLONG` 失败的问题 ([#6658](https://github.com/getpaseo/paseo/pull/6658) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了文件夹名称以空格结尾的项目创建 worktree 和使用 Changes 失败的问题 ([#6686](https://github.com/getpaseo/paseo/pull/6686))
- 修复了基础分支的 worktree 路径包含换行符或以空格结尾时合并 worktree 的问题 ([#6668](https://github.com/getpaseo/paseo/pull/6668) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 `paseo agent ls` 只列出前 200 个 Agent 的问题 ([#6033](https://github.com/getpaseo/paseo/pull/6033) by [@hteo1337](https://github.com/hteo1337))
- 修复了 `paseo worktree ls` 和 `paseo worktree archive` 失败并提示 "cwd or repoRoot is required" 的问题 ([#6467](https://github.com/getpaseo/paseo/pull/6467) by [@jasonhnd](https://github.com/jasonhnd))
- 修复了 `paseo worktree ls` 在最多 15 秒内仍列出已归档 worktree 的问题 ([#6545](https://github.com/getpaseo/paseo/pull/6545) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 `paseo logs --since` 输出请求时间戳之前的活动的问题 ([#6514](https://github.com/getpaseo/paseo/pull/6514) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 `paseo logs --follow` 在文本流式输出时把单词拆到多行的问题 ([#6528](https://github.com/getpaseo/paseo/pull/6528) by [@fiorelorenzo](https://github.com/fiorelorenzo))
- 修复了 `paseo logs` 把推理内容输出在其后的回复之后的问题 ([#6546](https://github.com/getpaseo/paseo/pull/6546))
- 修复了取消 HTTP 下载后 daemon 仍保持文件打开的问题 ([#6567](https://github.com/getpaseo/paseo/pull/6567) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了 Linux 桌面窗口显示通用图标而不是 Paseo 图标的问题 ([#6645](https://github.com/getpaseo/paseo/pull/6645) by [@whme](https://github.com/whme), [@panta82](https://github.com/panta82))
- 修复了 Google Play 把没有摄像头的 Android 设备列为不兼容的问题 ([#6339](https://github.com/getpaseo/paseo/pull/6339))
- 修复了在内存少于 15 GB 的 Mac 上 `nix build .#desktop` 内存耗尽的问题 ([#6537](https://github.com/getpaseo/paseo/pull/6537) by [@truelecter](https://github.com/truelecter))
- 修复了 Refresh all 之后用量 Provider 的位置互换的问题 ([#6947](https://github.com/getpaseo/paseo/pull/6947) by [@sleroq](https://github.com/sleroq))
- 修复了刷新失败时用量卡片丢失最近的值并显示 "Updated" 的问题 ([#7246](https://github.com/getpaseo/paseo/pull/7246))
- 修复了用量把不同的 Cursor 账号合并到同一张卡片中的问题 ([#7344](https://github.com/getpaseo/paseo/pull/7344))
- 修复了 OpenCode Go 用量图标在深色主题上几乎看不见的问题 ([#6362](https://github.com/getpaseo/paseo/pull/6362) by [@az33zy](https://github.com/az33zy))
- 修复了 Provider 列表中 Devin、Hermes、Kiro 和 Antigravity 显示通用图标的问题 ([#7330](https://github.com/getpaseo/paseo/pull/7330) by [@OMEG-Lu](https://github.com/OMEG-Lu), [@kevenhu001-cyber](https://github.com/kevenhu001-cyber))
- 修复了翻译后的标签较长时，侧边栏中的设置按钮溢出卡片的问题 ([#7312](https://github.com/getpaseo/paseo/pull/7312) by [@gentslava](https://github.com/gentslava))

## 0.11.4 - 2026-10-15

[Hoplite](https://hoplite.sh) 通过企业赞助计划成为 Paseo 的第一家赞助商。Hoplite 构建云端编码 Agent，可以把来自 GitHub、Linear、Slack 等的任务变成拉取请求。感谢 Hoplite 团队对 Paseo 的支持。

### 修复

- 修复了在关联到 Hoplite 项目的工作区中，Hoplite 在 Settings → Providers 中显示错误而不是发现模型的问题

## 0.11.3 - 2026-10-15

### 新增

- 在 ACP Provider 目录中新增 Hoplite，作为可选启用的 Provider ([#6953](https://github.com/getpaseo/paseo/pull/6953) by [@odinglyn0](https://github.com/odinglyn0))
- Add provider 目录新增搜索 ([#6953](https://github.com/getpaseo/paseo/pull/6953), [#7030](https://github.com/getpaseo/paseo/pull/7030))

### 变更

- Add provider 失败现在以 toast 显示 ([#7030](https://github.com/getpaseo/paseo/pull/7030))

### 修复

- 修复了 Antigravity 和 Muse Code 等插件 Provider 也提供 Remove 的问题 ([#6568](https://github.com/getpaseo/paseo/pull/6568) by [@Ctrl-Creeper](https://github.com/Ctrl-Creeper))

## 0.11.2 - 2026-10-09

### 修复

- 修复了 iOS 聊天和 Markdown 预览中文本间歇性被裁切的问题 ([#6445](https://github.com/getpaseo/paseo/pull/6445))

## 0.11.1 - 2026-10-07

### 新增

- 为 Claude Code 2.1.293 及更新版本新增 Claude Haiku 5.5 ([#6332](https://github.com/getpaseo/paseo/pull/6332))

### 修复

- 修复了运行超过 30 秒的 Claude 工具调用（例如 WebFetch 或 MCP 工具）显示为子 Agent 的问题 ([#6308](https://github.com/getpaseo/paseo/pull/6308))
- 修复了在应用断开期间完成的子 Agent 一直显示 "working"，直到打开其中一个为止的问题 ([#6316](https://github.com/getpaseo/paseo/pull/6316))
- 修复了 Claude Agent 的对话记录位于另一个项目文件夹时（例如迁移了 daemon 或从 WSL 运行 Windows 版 Claude Code 之后），daemon 重启后其历史记录显示 "No activity to display" 的问题 ([#6301](https://github.com/getpaseo/paseo/pull/6301))

## 0.11.0 - 2026-10-07

Paseo 0.11 新增对[插件注册表](https://paseo.sh/plugins)的支持。你可以在那里浏览社区插件，用 `paseo plugin add owner/slug` 安装插件，或者[提交你自己的插件](https://paseo.sh/docs/plugins/publishing#plugin-registry)。

**升级前须知**：`paseo plugin add owner/repo` 现在从注册表安装，因此直接从 GitHub 安装请使用 `github:owner/repo`，安装本地目录请使用 `./path`。

### 新增

- 新增 Muse Code Provider，支持模型、审批模式和推理强度控制 ([#5719](https://github.com/getpaseo/paseo/pull/5719), [#5775](https://github.com/getpaseo/paseo/pull/5775) by [@millerben95](https://github.com/millerben95))
- 新增 Antigravity Provider，它驱动已安装的 `agy` CLI，并始终使用 Full access ([#5714](https://github.com/getpaseo/paseo/pull/5714), [#5795](https://github.com/getpaseo/paseo/pull/5795))
- 新增 Usage，从侧边栏底部打开（桌面端为对话框，移动端为底部面板），显示每个订阅账号的配额窗口并支持 Refresh ([#5465](https://github.com/getpaseo/paseo/pull/5465), [#5685](https://github.com/getpaseo/paseo/pull/5685), [#5786](https://github.com/getpaseo/paseo/pull/5786), [#5805](https://github.com/getpaseo/paseo/pull/5805), [#5921](https://github.com/getpaseo/paseo/pull/5921), [#6216](https://github.com/getpaseo/paseo/pull/6216))
- 在侧边栏底部新增可选启用的 Usage 摘要，显示你固定的窗口 ([#5903](https://github.com/getpaseo/paseo/pull/5903), [#5975](https://github.com/getpaseo/paseo/pull/5975), [#6089](https://github.com/getpaseo/paseo/pull/6089))
- Usage 新增从 Codex CLI、OpenCode、Pi 和 OMP 发现 ChatGPT 登录 ([#5844](https://github.com/getpaseo/paseo/pull/5844))
- Usage 新增从 Claude Code 凭据文件、macOS 钥匙串、Pi 和 OMP 发现 Claude 登录 ([#5844](https://github.com/getpaseo/paseo/pull/5844))
- Usage 新增 OpenCode Go ([#5465](https://github.com/getpaseo/paseo/pull/5465))
- 新增 Usage 卡片不可用的原因，例如登录已过期以及用于刷新的命令；当所有登录都不可用时列出每个登录的错误 ([#5876](https://github.com/getpaseo/paseo/pull/5876), [#6156](https://github.com/getpaseo/paseo/pull/6156))
- OMP Agent 新增回合中引导 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@n24q02m](https://github.com/n24q02m))
- OMP 新增 Fast 模式和 Auto 思考级别 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@n24q02m](https://github.com/n24q02m), [@abhi-wan-kenobi](https://github.com/abhi-wan-kenobi))
- OMP 定时任务和 Hub 运行新增 MCP 服务器 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@omercnet](https://github.com/omercnet))
- 新增 Content width 设置，用于设置宽屏上聊天和 Markdown 文件的最大宽度 ([#5680](https://github.com/getpaseo/paseo/pull/5680))
- 新增 Vue 文件的语法高亮 ([#6205](https://github.com/getpaseo/paseo/pull/6205) by [@Davnn1](https://github.com/Davnn1))
- 在 `config.json` 中新增 `agents.providers.<id>.options`，作为每个 Provider 的默认选项，并支持按 Agent 覆盖 ([#5780](https://github.com/getpaseo/paseo/pull/5780))
- iPad 和 Android 平板上的终端窗格新增终端按键栏和 Paste ([#5712](https://github.com/getpaseo/paseo/pull/5712) by [@lardissone](https://github.com/lardissone))

### 插件

- `paseo plugin add owner/slug` 现在从插件注册表安装经过审核的插件，因此本地目录需要使用 `./slug` 这样的路径，直接从 GitHub 安装需要使用 `github:owner/repo` ([#6224](https://github.com/getpaseo/paseo/pull/6224))
- 插件 SDK 新增[界面以及侧边栏顶部和底部项](https://paseo.sh/docs/plugins/reference#screens-and-sidebar-items) ([#5685](https://github.com/getpaseo/paseo/pull/5685))
- 插件 SDK 新增用量来源 ([#5465](https://github.com/getpaseo/paseo/pull/5465), [#5876](https://github.com/getpaseo/paseo/pull/5876))
- 插件 SDK 新增 `spawnProcess()`、`execCommand()` 和 `terminateProcess()`，用于启动 CLI，包括 Windows 的 `.cmd` 和 `.bat` 脚本 ([#6151](https://github.com/getpaseo/paseo/pull/6151))
- 插件 SDK 新增 `client.playAudio()`，用于在每个客户端上播放音频 ([#5976](https://github.com/getpaseo/paseo/pull/5976))
- 新增 `agent.closed` 插件生命周期事件 ([#5971](https://github.com/getpaseo/paseo/pull/5971) by [@ilteoood](https://github.com/ilteoood))
- 插件 Provider 新增命令和环境变量覆盖以及可用性诊断 ([#5707](https://github.com/getpaseo/paseo/pull/5707))
- 插件 manifest 新增显示名称、图标、截图和视频 ([#6263](https://github.com/getpaseo/paseo/pull/6263))
- `paseo plugin init` 新增用于插件注册表列表的 `OVERVIEW.md` 模板 ([#6226](https://github.com/getpaseo/paseo/pull/6226))

### 变更

- 上下文窗口详情现在显示 Agent 所用账号的用量，包括自定义的 `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME` 目录 ([#5465](https://github.com/getpaseo/paseo/pull/5465))
- 桌面端的上下文窗口详情改为带 Refresh 的悬停卡片 ([#5975](https://github.com/getpaseo/paseo/pull/5975), [#6185](https://github.com/getpaseo/paseo/pull/6185))
- 上下文窗口计量现在在 Agent 的第一个回合之前就会显示 ([#6089](https://github.com/getpaseo/paseo/pull/6089))
- Codex Fast 改为 Speed 菜单，列出每个模型提供的 Normal、Fast 和 Ultrafast 速度；在桌面端显示为闪电图标，选择 Fast 或 Ultrafast 时变为黄色 ([#5708](https://github.com/getpaseo/paseo/pull/5708), [#6152](https://github.com/getpaseo/paseo/pull/6152) by [@Nurshot](https://github.com/Nurshot))
- Explorer 标签页现在与工作区标签页的行为一致，支持 + 菜单、拖放以及关闭 Files 和 Changes ([#5942](https://github.com/getpaseo/paseo/pull/5942))
- Pi 和 OMP 的扩展上下文改为显示为可展开的工具行而不是助手文本，并隐藏标记为隐藏的 Pi 消息 ([#6090](https://github.com/getpaseo/paseo/pull/6090))
- Import session 从侧边栏底部移到了 New workspace 界面 ([#5805](https://github.com/getpaseo/paseo/pull/5805))
- 新安装时侧边栏工作区行默认显示最近活动 ([#6087](https://github.com/getpaseo/paseo/pull/6087))
- 紧凑侧边栏底部按钮的点击区域改为 44×44 ([#6044](https://github.com/getpaseo/paseo/pull/6044))
- 从 `origin/main` 或其他远程分支创建的新工作区现在会先获取该分支 ([#5788](https://github.com/getpaseo/paseo/pull/5788) by [@odoo-mvds](https://github.com/odoo-mvds))
- Paseo 内部用于生成分支名、提交消息和 PR 文本的 Claude Agent 现在在禁用 Claude hooks 的情况下运行 ([#5750](https://github.com/getpaseo/paseo/pull/5750))
- OMP 审批模式的更改现在在下一次空闲重启时生效，并且在回合进行中会被拒绝 ([#5550](https://github.com/getpaseo/paseo/pull/5550))
- Agent、定时任务和 Import session 行中的相对时间戳现在在显示期间会持续更新 ([#5340](https://github.com/getpaseo/paseo/pull/5340))

### 修复

- 修复了 Claude Opus 4.7 及更高版本上 Claude Agent 从不显示 Thought 行的问题 ([#4355](https://github.com/getpaseo/paseo/pull/4355) by [@ThePharmer](https://github.com/ThePharmer))
- 修复了只有后台辅助进程在工作时 Claude Agent 显示为运行中，以及发送消息或 Stop 会终止这些辅助进程的问题 ([#6295](https://github.com/getpaseo/paseo/pull/6295) by [@IsakPersson](https://github.com/IsakPersson))
- 修复了 Claude Code 使用 Bedrock 或 Vertex 时 Auto 模式下的 Claude Agent 无法切换模式的问题 ([#6272](https://github.com/getpaseo/paseo/pull/6272))
- 修复了 Claude 子 Agent 的自动模式报告显示为原始的 SubagentHandback 工具卡片而不是 Markdown 的问题 ([#6248](https://github.com/getpaseo/paseo/pull/6248))
- 修复了后台 Claude 子 Agent 卡片显示为一直运行的空白 "Task"、daemon 重启后显示为 "Agent"，或两个同时启动时没有标签的问题 ([#6067](https://github.com/getpaseo/paseo/pull/6067), [#6100](https://github.com/getpaseo/paseo/pull/6100), [#6268](https://github.com/getpaseo/paseo/pull/6268))
- 修复了 Claude 空闲时 Claude Code 终端不显示为需要输入的问题 ([#6022](https://github.com/getpaseo/paseo/pull/6022))
- 修复了 Claude 用量在重试时间之前再次调用被限流的登录的问题 ([#6089](https://github.com/getpaseo/paseo/pull/6089))
- 修复了自行进入计划模式的 Claude Agent 仍显示并保存其之前的模式的问题 ([#6074](https://github.com/getpaseo/paseo/pull/6074))
- 修复了在会话中更改模式后，恢复的 Agent 回到创建时模式的问题 ([#5140](https://github.com/getpaseo/paseo/pull/5140) by [@ThePlenkov](https://github.com/ThePlenkov))
- 修复了 Windows 上 ACP 插件 Provider 无法启动 `.cmd` 或 `.bat` CLI 的问题 ([#6151](https://github.com/getpaseo/paseo/pull/6151))
- 修复了配置的模型不在 Agent 提供的模型中时 ACP Agent 使用默认模型运行的问题 ([#6273](https://github.com/getpaseo/paseo/pull/6273))
- 修复了 Provider 从不响应关闭请求时，归档 ACP Agent 后其 Provider 仍在运行的问题 ([#6213](https://github.com/getpaseo/paseo/pull/6213) by [@apple-ouyang](https://github.com/apple-ouyang))
- 修复了 worktree 被移除后已归档的 ACP Agent 显示空白聊天的问题 ([#6228](https://github.com/getpaseo/paseo/pull/6228))
- 修复了在权限请求未处理时回合失败后，ACP Agent 拒绝之后所有消息的问题 ([#6045](https://github.com/getpaseo/paseo/pull/6045))
- 修复了报告上下文用量的 ACP Agent 从不显示上下文窗口计量的问题 ([#4848](https://github.com/getpaseo/paseo/pull/4848) by [@apple-ouyang](https://github.com/apple-ouyang))
- 修复了 ACP Agent 拒绝某项会话设置时，定时任务运行和工作区元数据记录为 `[object Object]` 的问题 ([#5765](https://github.com/getpaseo/paseo/pull/5765))
- 修复了 `omp` 进程崩溃后 OMP Agent 仍绑定在已失效进程上的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@viet-initx](https://github.com/viet-initx))
- 修复了 OMP 多选问题显示单选按钮并为每个选项分别提问的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550))
- 修复了 OMP 上的 `/compact` 在 OMP 仍在压缩时于 60 秒后报告失败的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@Kh05ifr4nD](https://github.com/Kh05ifr4nD))
- 修复了 `paseo import --provider omp` 使用默认模型而不是会话的模型启动 Agent 的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@alloevil](https://github.com/alloevil))
- 修复了重新加载后 OMP 注入的行显示 `[custom_message]` 前缀的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@jegork](https://github.com/jegork))
- 修复了 OMP 工具行对失败的工具、Task、Wait、网页搜索和抓取显示原始对象或通用标签的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550))
- 修复了 OMP `xd://` 写入的结果从时间线中消失的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@kasrakhosravi](https://github.com/kasrakhosravi))
- 修复了 OMP 模型回退后 Composer 仍显示旧模型的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@gray-graff](https://github.com/gray-graff))
- 修复了打开已归档的 OMP Agent 会启动一个持续运行的 `omp` 进程的问题 ([#5550](https://github.com/getpaseo/paseo/pull/5550) by [@thomasvan](https://github.com/thomasvan))
- 修复了运行中包含 Paseo 不显示的消息（例如 OMP 规则提醒）时 OMP 回合一直处于运行中的问题 ([#6112](https://github.com/getpaseo/paseo/pull/6112))
- 修复了被 OMP 拒绝的提示词（例如缺少 API 密钥）以没有错误的已完成回合结束的问题 ([#6110](https://github.com/getpaseo/paseo/pull/6110), [#6115](https://github.com/getpaseo/paseo/pull/6115))
- 修复了重新打开的 OMP 聊天对压缩和 OMP 自行写入的其他条目显示 "Custom message" 行的问题 ([#6198](https://github.com/getpaseo/paseo/pull/6198), [#6215](https://github.com/getpaseo/paseo/pull/6215))
- 修复了模型已被移除的 Pi 和 OMP 会话无法导入或重新打开的问题 ([#6061](https://github.com/getpaseo/paseo/pull/6061))
- 修复了未安装 `pi-mcp-adapter` 时 Pi 0.99 上的 Pi Agent 启动时没有 Paseo 的 MCP 服务器的问题 ([#5762](https://github.com/getpaseo/paseo/pull/5762) by [@ArietidsZ](https://github.com/ArietidsZ))
- 修复了正在运行的 Pi 子 Agent 在完成之前显示空白记录的问题 ([#5755](https://github.com/getpaseo/paseo/pull/5755))
- 修复了分组的 Tintinweb pi-subagents 完成时只把第一个 Agent 标记为已完成，其余仍显示为工作中的问题 ([#5826](https://github.com/getpaseo/paseo/pull/5826))
- 修复了针对 `paseo_*` 工具的 OpenCode `ask` 规则不经提示就运行工具的问题 ([#5801](https://github.com/getpaseo/paseo/pull/5801) by [@ymarcus93](https://github.com/ymarcus93))
- 修复了 OpenCode 服务器就绪较慢时第一条 OpenCode 提示词要等到事件流超时的问题 ([#5873](https://github.com/getpaseo/paseo/pull/5873) by [@axsuul](https://github.com/axsuul))
- 修复了问题被关闭或工具权限被拒绝后 OpenCode v2 Agent 仍处于运行中的问题 ([#6177](https://github.com/getpaseo/paseo/pull/6177), [#6188](https://github.com/getpaseo/paseo/pull/6188))
- 修复了 Nix 包无法启动 daemon 和打开终端的问题 ([#5523](https://github.com/getpaseo/paseo/pull/5523) by [@wongcallum](https://github.com/wongcallum))
- 修复了 OpenCode v2 Agent 在 Nix 包上无法启动的问题 ([#5988](https://github.com/getpaseo/paseo/pull/5988))
- 修复了每个 Paseo 技能在 Codex 的技能列表中出现两次的问题 ([#5827](https://github.com/getpaseo/paseo/pull/5827) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了 Codex 图片生成失败后聊天中没有留下任何行的问题 ([#5810](https://github.com/getpaseo/paseo/pull/5810) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了被拒绝的 Codex 命令或文件编辑在回合结束后仍显示运行中图标的问题 ([#5717](https://github.com/getpaseo/paseo/pull/5717) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了在 Codex 0.156 及更新版本上回退旧版 Codex 聊天失败并提示 `unknown variant thread/rollback` 的问题 ([#5711](https://github.com/getpaseo/paseo/pull/5711) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了包含 `$` 序列的 Codex 自定义提示词参数在传给 Codex 时被修改的问题 ([#5669](https://github.com/getpaseo/paseo/pull/5669) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了 schema 中有名为 `properties` 的字段时 Codex 结构化输出失败的问题 ([#5684](https://github.com/getpaseo/paseo/pull/5684))
- 修复了未设置思考选项而创建的 Codex Agent 在 daemon 重启后丢失默认强度的问题 ([#5686](https://github.com/getpaseo/paseo/pull/5686))
- 修复了 Codex 请求批准同一条目中的两条命令时只显示一个权限请求的问题 ([#5758](https://github.com/getpaseo/paseo/pull/5758))
- 修复了在当前版本的 Codex 上 Codex 终端行只显示 "Terminal" 而没有命令的问题 ([#5774](https://github.com/getpaseo/paseo/pull/5774))
- 修复了 Composer 显示目录默认的思考级别而不是 Agent 实际使用的级别的问题 ([#5804](https://github.com/getpaseo/paseo/pull/5804))
- 修复了 Agent 的模型不在已加载目录中时 Composer 显示另一个模型标签的问题 ([#5796](https://github.com/getpaseo/paseo/pull/5796))
- 修复了在 Web 和桌面端向上滚动浏览较早的历史时聊天向回跳几屏的问题 ([#5945](https://github.com/getpaseo/paseo/pull/5945), [#5970](https://github.com/getpaseo/paseo/pull/5970), [#6172](https://github.com/getpaseo/paseo/pull/6172))
- 修复了聊天中的图片加载完成时下方文本发生移动的问题 ([#5970](https://github.com/getpaseo/paseo/pull/5970))
- 修复了复制聊天代码块中的全部代码时有时会包含 ``` 围栏行的问题 ([#6138](https://github.com/getpaseo/paseo/pull/6138))
- 修复了跨越嵌套在编号列表项中的代码块复制时下一项被重新编号的问题 ([#6158](https://github.com/getpaseo/paseo/pull/6158))
- 修复了跨越图片复制聊天选区时丢失其替代文本和来源，或选区从图片下方开始时却包含该图片的问题 ([#6181](https://github.com/getpaseo/paseo/pull/6181), [#6195](https://github.com/getpaseo/paseo/pull/6195))
- 修复了聊天中相对的 `path:line` 文件链接打开到该文件第一次被引用的行的问题 ([#5653](https://github.com/getpaseo/paseo/pull/5653) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了包含带链接图片的 PR 评论显示原始 HTML 标签并丢失图片链接的问题 ([#5968](https://github.com/getpaseo/paseo/pull/5968))
- 修复了浏览器工具输入的文本出现在你的消息框而不是浏览器标签页中的问题 ([#6207](https://github.com/getpaseo/paseo/pull/6207))
- 修复了 Astro 表达式在嵌套模板字符串之后失去颜色的问题 ([#6219](https://github.com/getpaseo/paseo/pull/6219))
- 修复了下载名称包含非 ASCII 字符的文件的问题 ([#6278](https://github.com/getpaseo/paseo/pull/6278), [#6281](https://github.com/getpaseo/paseo/pull/6281) by [@dillonzq](https://github.com/dillonzq), [@jasonhnd](https://github.com/jasonhnd))
- 修复了在其他应用语言下 PR 面板、侧边栏工作区状态和 "Worked for" 行显示英文的问题 ([#6196](https://github.com/getpaseo/paseo/pull/6196), [#6208](https://github.com/getpaseo/paseo/pull/6208), [#6225](https://github.com/getpaseo/paseo/pull/6225) by [@dillonzq](https://github.com/dillonzq))
- 修复了读起来像逐字机器翻译的法语翻译 ([#6004](https://github.com/getpaseo/paseo/pull/6004) by [@fxlelouarn](https://github.com/fxlelouarn))
- 修复了滚动长聊天后无法从工作区标题栏拖动桌面窗口的问题 ([#5233](https://github.com/getpaseo/paseo/pull/5233) by [@Zhou-Ruichen](https://github.com/Zhou-Ruichen))
- 修复了在桌面布局的触摸屏上打开 Agent 时弹出屏幕键盘的问题 ([#5477](https://github.com/getpaseo/paseo/pull/5477) by [@dinhphieu](https://github.com/dinhphieu))
- 修复了 macOS 终端中 Option+方向键、Cmd+方向键和 Cmd+Backspace 的行编辑 ([#3339](https://github.com/getpaseo/paseo/pull/3339) by [@gpambrozio](https://github.com/gpambrozio))
- 修复了 Add Project 的目录搜索遇到读取永不返回的文件夹时 daemon 冻结的问题 ([#6029](https://github.com/getpaseo/paseo/pull/6029), [#6041](https://github.com/getpaseo/paseo/pull/6041) by [@lardissone](https://github.com/lardissone))
- 修复了 `paseo.json` 无法解析时新的 worktree 工作区被归档的问题 ([#6036](https://github.com/getpaseo/paseo/pull/6036) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了工作区脚本状态在其他已连接的客户端中不更新的问题 ([#6007](https://github.com/getpaseo/paseo/pull/6007) by [@swbiggart](https://github.com/swbiggart))
- 修复了 Agent 和终端继承语音库路径，导致 Windows 上 Git Bash 的 PATH 被截断的问题 ([#5987](https://github.com/getpaseo/paseo/pull/5987) by [@hanh9898](https://github.com/hanh9898))
- 修复了 daemon 在解压本地语音模型时停止后，语音输入一直失败直到手动删除该模型的问题 ([#6210](https://github.com/getpaseo/paseo/pull/6210) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了网络不提供主机名时 macOS 主机显示为 `UNKNOWN` 的问题 ([#5922](https://github.com/getpaseo/paseo/pull/5922))
- 修复了主机从睡眠中唤醒后 `paseo daemon status` 把 Linux 虚拟机中的 daemon 报告为已停止的问题 ([#6279](https://github.com/getpaseo/paseo/pull/6279))
- 修复了中继连接在握手之前停滞后，中继重新连接被忽略的问题 ([#5648](https://github.com/getpaseo/paseo/pull/5648) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了启动 `paseo daemon run` 的程序停止读取其输出时，它以 "Daemon failed to start" 退出的问题 ([#6117](https://github.com/getpaseo/paseo/pull/6117))
- 修复了输出不再被读取时 CLI 命令因 `EPIPE` 崩溃，以及 Windows 桌面应用显示错误对话框的问题 ([#6097](https://github.com/getpaseo/paseo/pull/6097))
- 修复了以链接方式全局安装时 daemon 自更新给出错误的拒绝原因的问题 ([#6095](https://github.com/getpaseo/paseo/pull/6095))
- 修复了 npm 安装在非 npm 全局前缀下时 daemon 自更新失败的问题 ([#5649](https://github.com/getpaseo/paseo/pull/5649) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了打开 worktree 已被移除的已归档 Agent 时，如果工作区没有记录分支，会显示 "Workspace unavailable" 的问题 ([#5694](https://github.com/getpaseo/paseo/pull/5694))
- 修复了向目录已被移除的已归档 Agent 发送失败后，它从 History 中消失的问题 ([#6255](https://github.com/getpaseo/paseo/pull/6255))
- 修复了 daemon 重启后主机页面上的主机版本仍是旧版本的问题 ([#5351](https://github.com/getpaseo/paseo/pull/5351) by [@bashrusakh](https://github.com/bashrusakh))
- 修复了 Remote SSH 主机无法连接到受密码保护的 daemon 的问题，并新增 Daemon password 字段 ([#6081](https://github.com/getpaseo/paseo/pull/6081) by [@royenheart](https://github.com/royenheart))
- 修复了在第一次连接尝试期间移除主机不会停止该连接的问题 ([#5722](https://github.com/getpaseo/paseo/pull/5722))
- 修复了在重新连接期间开始的文件上传失败并提示 `Connection changed during file upload` 的问题 ([#5585](https://github.com/getpaseo/paseo/pull/5585))
- 修复了平板上键盘打开时居中的 New workspace 表单折叠并重叠的问题 ([#6093](https://github.com/getpaseo/paseo/pull/6093) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了 Android 侧边栏在选择工作区后重新打开时跳回顶部的问题 ([#6058](https://github.com/getpaseo/paseo/pull/6058))
- 修复了在原生平板上点击上下文圆环和长按工作区标签页没有反应的问题 ([#5713](https://github.com/getpaseo/paseo/pull/5713) by [@JichenZhang](https://github.com/JichenZhang))
- 修复了 iPad 聊天文本在窗格调整大小后保持旧宽度的问题 ([#5716](https://github.com/getpaseo/paseo/pull/5716))
- 修复了 Web 和桌面端的上下文圆环从三点钟方向而不是十二点钟方向开始填充的问题 ([#5598](https://github.com/getpaseo/paseo/pull/5598))
- 修复了应用缩放时浏览器标注截图截取错误区域的问题 ([#5703](https://github.com/getpaseo/paseo/pull/5703))
- 修复了没有本地 daemon 运行时桌面应用每秒启动一个 `daemon status` 进程的问题 ([#5636](https://github.com/getpaseo/paseo/pull/5636))
- 修复了在选择项目或模型之前，草稿中的 `/` 菜单列出 `/clear` 和 `/exit` 的问题 ([#5594](https://github.com/getpaseo/paseo/pull/5594) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了 `paseo agent delete --all` 和 `--cwd` 遗留已归档 Agent 的问题 ([#6027](https://github.com/getpaseo/paseo/pull/6027) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了 `paseo agent` 命令对未知的 Agent ID 报告通用失败而不是 `AGENT_NOT_FOUND` 的问题 ([#6053](https://github.com/getpaseo/paseo/pull/6053))
- 修复了 `paseo agent open` 对不存在的 Agent 打开 Desktop 并以 0 退出的问题 ([#5727](https://github.com/getpaseo/paseo/pull/5727))
- 修复了 Provider 检查耗时超过一秒时 `paseo restart` 以 `RESTART_NOT_CONFIRMED` 退出的问题 ([#6009](https://github.com/getpaseo/paseo/pull/6009))
- 修复了 `paseo schedule update --no-max-runs` 和 `--no-expires-in` 在到达 daemon 之前就失败的问题 ([#5973](https://github.com/getpaseo/paseo/pull/5973) by [@Mar-garet](https://github.com/Mar-garet))
- 修复了恢复的 Claude Agent 的对话记录缺失或无法读取时 `daemon.log` 中没有任何记录的问题 ([#5818](https://github.com/getpaseo/paseo/pull/5818) by [@gabrielgiordan](https://github.com/gabrielgiordan))
- 修复了重新加载插件会在其 Provider 的已完成聊天中添加 `[System Error] Provider connection closed` 的问题 ([#5579](https://github.com/getpaseo/paseo/pull/5579))
- 修复了 `paseo plugin add .` 在 daemon 的目录而不是 CLI 的目录中查找插件的问题 ([#6239](https://github.com/getpaseo/paseo/pull/6239))
- 修复了桌面端的插件设置界面无法返回 Plugins 页面的问题 ([#5620](https://github.com/getpaseo/paseo/pull/5620))
- 修复了插件客户端代码无法导入只声明了 `main` 或 `module` 的 npm 包的问题 ([#5838](https://github.com/getpaseo/paseo/pull/5838))
- 修复了 SDK 的 `send()` 和 `run()` 在 TypeScript 中拒绝 `activeTurnBehavior` 的问题 ([#5605](https://github.com/getpaseo/paseo/pull/5605) by [@wjxdy](https://github.com/wjxdy))
- 修复了从 npm 打包 `@getpaseo/client` 时失败并提示 `Could not resolve "@getpaseo/relay/e2ee"` 的问题 ([#5815](https://github.com/getpaseo/paseo/pull/5815))

## 0.10.3 - 2026-10-02

### 新增

- 配对链接连接到新主机，或连接到密钥或中继已变化的已保存主机之前，新增确认步骤 ([#5753](https://github.com/getpaseo/paseo/pull/5753))

## 0.10.2 - 2026-09-30

### 修复

- 修复了超过五分钟的 OpenCode v2 回合失败并提示 `UND_ERR_HEADERS_TIMEOUT` 的问题 ([#5674](https://github.com/getpaseo/paseo/pull/5674))
- 修复了上下文计量在 OpenCode v2 回合期间一直为空并在回合结束后消失的问题 ([#5710](https://github.com/getpaseo/paseo/pull/5710) by [@mcowger](https://github.com/mcowger))
- 修复了 OpenCode v2 问题卡片只显示标题且无法输入答案的问题 ([#5679](https://github.com/getpaseo/paseo/pull/5679))
- 修复了来自 GPT 模型的 OpenCode v2 补丁编辑显示为原始 Patch 卡片而不是编辑 diff 的问题 ([#5696](https://github.com/getpaseo/paseo/pull/5696))
- 修复了已完成的 OpenCode v2 编辑不显示 diff 的问题 ([#5609](https://github.com/getpaseo/paseo/pull/5609))

## 0.10.1 - 2026-09-29

### 新增

- 为 Claude Code 2.1.284 及更新版本新增 Claude Sonnet 5.5 ([#5583](https://github.com/getpaseo/paseo/pull/5583) by [@yangqi](https://github.com/yangqi))

### 修复

- 修复了切换到不支持所选思考级别的模型后 OpenCode 聊天失败并提示 "Variant unavailable" 的问题 ([#5587](https://github.com/getpaseo/paseo/pull/5587))
- 修复了回退 Codex 聊天会丢失其自定义 Provider 和 Paseo 工具的问题 ([#5345](https://github.com/getpaseo/paseo/pull/5345) by [@zbaibg](https://github.com/zbaibg))
- 修复了流式回复在聊天重新加载之前把代码块和 Mermaid 图表的行连在一起的问题 ([#5577](https://github.com/getpaseo/paseo/pull/5577))
- 修复了从拆分窗格打开的子 Agent 在另一个窗格中打开的问题 ([#5451](https://github.com/getpaseo/paseo/pull/5451))
- 修复了归档自定义 Codex Provider 的 Agent 后其会话仍留在 Import session 中的问题 ([#5572](https://github.com/getpaseo/paseo/pull/5572))
- 修复了使用自己 `CODEX_HOME` 的自定义 Codex Provider 的 `/` 菜单列出 daemon 的提示词而不是它自己的提示词的问题 ([#5450](https://github.com/getpaseo/paseo/pull/5450))
- 修复了后台 `send_agent_prompt` 对 Agent 已接受的提示词返回 `idle` 的问题 ([#5386](https://github.com/getpaseo/paseo/pull/5386))
- 修复了 Windows 上工作区内文件的文件链接提示显示完整路径的问题 ([#1987](https://github.com/getpaseo/paseo/pull/1987))
- 修复了运行 `cursor-agent` 的终端配置显示通用终端图标的问题 ([#5379](https://github.com/getpaseo/paseo/pull/5379))

## 0.10.0 - 2026-09-28

### 新增

- 新增 OpenCode v2 支持，会根据已安装的 `opencode` 版本自动选择 ([#5198](https://github.com/getpaseo/paseo/pull/5198), [#5526](https://github.com/getpaseo/paseo/pull/5526) by [@karrots](https://github.com/karrots), [@dsingal0](https://github.com/dsingal0), [@gszep](https://github.com/gszep))
- Pi 聊天新增来自 rpiv-todo、pi-goal-x 和 Pi 示例 todo 扩展的任务列表 ([#5309](https://github.com/getpaseo/paseo/pull/5309))
- Subagents 栏新增来自 pi-subagents、Tintinweb pi-subagents 和 Gotgenes pi-subagents 的子 Agent 运行 ([#5309](https://github.com/getpaseo/paseo/pull/5309))
- Pi 聊天新增 rpiv-ask-user-question 对话框，以一个问题表单的形式显示 ([#5309](https://github.com/getpaseo/paseo/pull/5309))
- 中继连接新增密码校验，会拒绝错误的 daemon 密码；后续版本将强制要求密码 ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- Add host、配对链接和二维码配对新增密码字段，用于受密码保护的 daemon ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- `paseo daemon pair` 新增 `relay://` 连接字符串 ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- 在 OMP 17.4.2 及更新版本上，问题卡片新增 OMP Ask 选项描述 ([#3628](https://github.com/getpaseo/paseo/pull/3628) by [@joeshull](https://github.com/joeshull))

### 变更

- CLI 和桌面应用现在连接同一台机器上受密码保护的 daemon 时不再询问密码 ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- 因密码被拒绝的主机现在会在主机和 Connections 页面上显示 "Password required" 或 "Incorrect password" ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- Settings 重新组织为 General、Sidebar、Chat、Terminal、Browser 和 Open location 页面 ([#5459](https://github.com/getpaseo/paseo/pull/5459))

### 修复

- 修复了 daemon 密码包含空格或 `@`、`/` 等字符时直接连接失败的问题 ([#5393](https://github.com/getpaseo/paseo/pull/5393))
- 修复了 OpenCode 服务器重启后现有 OpenCode Agent 以 `ECONNREFUSED` 失败的问题 ([#5338](https://github.com/getpaseo/paseo/pull/5338))
- 修复了 OpenCode 自行添加的消息在聊天中显示得像是用户输入的问题 ([#5434](https://github.com/getpaseo/paseo/pull/5434))
- 修复了 `daemon.log` 无法写入时（例如磁盘已满）daemon 停止的问题 ([#5445](https://github.com/getpaseo/paseo/pull/5445))
- 修复了打开 worktree 已被移除的已归档 ACP Agent 时 daemon 崩溃的问题 ([#5439](https://github.com/getpaseo/paseo/pull/5439) by [@qinkangdeid](https://github.com/qinkangdeid))
- 修复了应用启动后（包括之后的重启）现有工作区从侧边栏中消失的问题 ([#5394](https://github.com/getpaseo/paseo/pull/5394))
- 修复了使用自己 `CLAUDE_CONFIG_DIR` 的自定义 Claude Provider 上的 Agent 在 daemon 重启后打开为空白聊天的问题 ([#5437](https://github.com/getpaseo/paseo/pull/5437))
- 修复了自定义 Codex Provider 的会话不出现在 Import session 中的问题 ([#5446](https://github.com/getpaseo/paseo/pull/5446))
- 修复了 Provider 的版本检查耗时超过 1.5 秒时主机设置中的 Update daemon 和 Restart 失败的问题 ([#5372](https://github.com/getpaseo/paseo/pull/5372))
- 修复了在 Agent 会话内执行 `paseo --host <other daemon> run` 失败并提示 "Caller agent not found" 的问题 ([#5392](https://github.com/getpaseo/paseo/pull/5392))
- 修复了之前回退过之后，Pi 聊天回退到比所选消息更早位置的问题 ([#5383](https://github.com/getpaseo/paseo/pull/5383))
- 修复了 daemon 重启时 Pi 聊天的回退被撤销的问题 ([#5432](https://github.com/getpaseo/paseo/pull/5432))
- 修复了未指定模型启动的 Pi Agent 忽略 Pi 配置的默认模型的问题 ([#5343](https://github.com/getpaseo/paseo/pull/5343))
- 修复了检出切换分支后新 Agent 的 `/` 菜单中的项目技能仍是旧内容的问题 ([#5415](https://github.com/getpaseo/paseo/pull/5415))
- 修复了自定义 ACP Provider 上新 Agent 的 `/` 菜单中缺少斜杠命令的问题 ([#5411](https://github.com/getpaseo/paseo/pull/5411))
- 修复了向正在运行的子 Agent 发送提示词后父 Agent 收到两次子 Agent 完成通知的问题 ([#5407](https://github.com/getpaseo/paseo/pull/5407))
- 修复了超过 30 秒等待时间的阻塞式 `send_agent_prompt` 在子 Agent 完成时从不通知调用方的问题 ([#5347](https://github.com/getpaseo/paseo/pull/5347))
- 修复了 OSC 8 终端链接显示导航提示并打开空白 Paseo 窗口的问题 ([#5388](https://github.com/getpaseo/paseo/pull/5388) by [@liujin0506](https://github.com/liujin0506))
- 修复了插件主题超出窗口时 Theme 菜单无法滚动的问题 ([#5374](https://github.com/getpaseo/paseo/pull/5374))
- 修复了上周同一星期几的消息只显示星期几而不显示日期的问题 ([#5341](https://github.com/getpaseo/paseo/pull/5341))
- 修复了 stdin 不是终端时 `paseo daemon set-password` 静默退出的问题 ([#5358](https://github.com/getpaseo/paseo/pull/5358))

## 0.9.2 - 2026-09-24

### 新增

- 新增结构化的 Claude Code 启动参数，用于会话配置和插件 ([#5206](https://github.com/getpaseo/paseo/pull/5206))

### 改进

- 减少了对 watcher 无法观察的仓库的后台 Git 轮询 ([#5170](https://github.com/getpaseo/paseo/pull/5170))
- 缩短了在大型主目录上 Add Project 目录搜索的时间 ([#5190](https://github.com/getpaseo/paseo/pull/5190))

### 修复

- 修复了工作区打开后出现被忽略的目录时 daemon 失去响应的问题 ([c3e1e08](https://github.com/getpaseo/paseo/commit/c3e1e084a068e5895710c43b034ced8ebef256e8) by [@Marcus172](https://github.com/Marcus172))
- 修复了客户端连接关闭后 daemon 内存增长的问题 ([9978988](https://github.com/getpaseo/paseo/commit/9978988e35409a018a52d0d7646f18b51e562346))
- 修复了以空格结尾的项目文件夹导致应用在加载时崩溃的问题 ([#5205](https://github.com/getpaseo/paseo/pull/5205) by [@L4XB](https://github.com/L4XB))
- 修复了 Agent 界面先于侧边栏打开时工作区标签缺失的问题 ([#5079](https://github.com/getpaseo/paseo/pull/5079) by [@morven-ai](https://github.com/morven-ai))
- 修复了工作区所在的磁盘或网络共享不可用时工作区消失的问题 ([#5227](https://github.com/getpaseo/paseo/pull/5227))
- 修复了会话导入失败导致已归档的 worktree 无法恢复的问题 ([#5238](https://github.com/getpaseo/paseo/pull/5238))
- 修复了 Paseo 移除 worktree 后已归档 Agent 的日志读取失败的问题 ([#5229](https://github.com/getpaseo/paseo/pull/5229))
- 修复了新创建的分支通过继承的上游推送到默认分支的问题 ([#5249](https://github.com/getpaseo/paseo/pull/5249))
- 修复了刷新后 fork 检出的拉取请求从工作区中消失的问题 ([#5221](https://github.com/getpaseo/paseo/pull/5221))
- 修复了 Agent 创建的本地工作区接受不存在的路径或文件的问题 ([#5322](https://github.com/getpaseo/paseo/pull/5322))
- 修复了聊天上传把原始文件名中的有效字符替换为下划线的问题 ([#5317](https://github.com/getpaseo/paseo/pull/5317))
- 修复了多选问题丢失已勾选的选项或输入的 Other 答案的问题 ([#5320](https://github.com/getpaseo/paseo/pull/5320) by [@ThePharmer](https://github.com/ThePharmer))
- 修复了底部面板打开时按 Android 返回键会离开当前界面的问题 ([#5245](https://github.com/getpaseo/paseo/pull/5245))
- 修复了语音模式在语音回复的各段之间播放思考提示音的问题 ([#5281](https://github.com/getpaseo/paseo/pull/5281))
- 修复了带附件发送的 Claude 斜杠命令以纯文本到达 Claude 的问题 ([#5240](https://github.com/getpaseo/paseo/pull/5240) by [@joecorkerton](https://github.com/joecorkerton))
- 修复了在没有收到响应的回合之后回退 Claude 的问题 ([#5285](https://github.com/getpaseo/paseo/pull/5285))
- 修复了在包含子 Agent 消息的回合之后回退 Claude 的问题 ([#5289](https://github.com/getpaseo/paseo/pull/5289))
- 修复了配置了持久时间线存储时刷新后 Agent 历史重复的问题 ([#5286](https://github.com/getpaseo/paseo/pull/5286))
- 修复了 OMP 自定义消息在 Provider 完成之前结束回合的问题 ([#3258](https://github.com/getpaseo/paseo/pull/3258))
- 修复了被停止的 OMP 回合显示为失败回合的问题 ([#5243](https://github.com/getpaseo/paseo/pull/5243))
- 修复了运行时已退出的 Pi 或 OMP Agent 无法通过 Stop 结束的问题 ([#5235](https://github.com/getpaseo/paseo/pull/5235))
- 修复了 OpenCode Agent 忽略其配置的权限规则的问题 ([#5296](https://github.com/getpaseo/paseo/pull/5296) by [@gurvancampion](https://github.com/gurvancampion))
- 修复了 Codex 的 Default 和 Read-only 模式把审批请求发送给 Auto-review 的问题 ([#5239](https://github.com/getpaseo/paseo/pull/5239) by [@HMWCS](https://github.com/HMWCS))
- 修复了从 Fast 模型切换到不支持 Fast 的模型后创建 Cursor Agent 的问题 ([#5274](https://github.com/getpaseo/paseo/pull/5274) by [@gengjiawen](https://github.com/gengjiawen))
- 修复了 Codex 中 GPT-6 Sol 和 GPT-6 Luna 缺少 Fast 控件的问题 ([#5273](https://github.com/getpaseo/paseo/pull/5273) by [@basilk15](https://github.com/basilk15), [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了 Claude 配置的 Fable 模型不在模型选择器中的问题 ([#5326](https://github.com/getpaseo/paseo/pull/5326) by [@noahg9](https://github.com/noahg9))
- 修复了 daemon 启动的 ACP 终端使用错误的 Agent 身份的问题 ([#5248](https://github.com/getpaseo/paseo/pull/5248))
- 修复了 daemon 重启后 Agent 已完成的插件会话显示为失败的问题 ([#5253](https://github.com/getpaseo/paseo/pull/5253))
- 修复了 Provider 会话关闭期间重新加载插件导致其子进程崩溃的问题 ([#5231](https://github.com/getpaseo/paseo/pull/5231))
- 修复了插件 Provider 请求失败导致 daemon 崩溃的问题 ([#5298](https://github.com/getpaseo/paseo/pull/5298))
- 修复了 Hub 执行无法为其创建的工作区设置标题的问题 ([#5302](https://github.com/getpaseo/paseo/pull/5302))
- 修复了无效的定时任务文件导致 daemon 无法启动的问题 ([#5301](https://github.com/getpaseo/paseo/pull/5301))
- 修复了空的 `paseo.pid` 导致 daemon 无法启动的问题 ([#5306](https://github.com/getpaseo/paseo/pull/5306))
- 修复了重启后被复用的 daemon PID 导致无法启动的问题 ([#5277](https://github.com/getpaseo/paseo/pull/5277))
- 修复了 `config.json` 带有 UTF-8 BOM 时 daemon 启动失败的问题 ([#5315](https://github.com/getpaseo/paseo/pull/5315))
- 修复了后台 daemon 的启动错误没有出现在报告的日志文件中的问题 ([#5332](https://github.com/getpaseo/paseo/pull/5332))
- 修复了针对无效 `config.json` 的 CLI 错误没有指出文件和出错字段的问题 ([#5337](https://github.com/getpaseo/paseo/pull/5337))
- 修复了密码被拒绝后 CLI 仍建议启动 daemon 的问题 ([#5310](https://github.com/getpaseo/paseo/pull/5310))
- 修复了受密码保护的桌面 daemon 缺少 Open in editor 的问题 ([#5335](https://github.com/getpaseo/paseo/pull/5335))
- 修复了 `paseo permit ls --json` 截短了 `permit allow` 和 `permit deny` 所需的请求 ID 的问题 ([#5305](https://github.com/getpaseo/paseo/pull/5305))
- 修复了副本缓存的存储持续拒绝写入时读取一直空转的问题 ([#5290](https://github.com/getpaseo/paseo/pull/5290))
- 修复了 MiniMax 卡片对未激活的 token 订阅显示原始错误的问题 ([#5258](https://github.com/getpaseo/paseo/pull/5258))
- 修复了带修饰键的 Backspace 无法设为自定义快捷键的问题 ([#5224](https://github.com/getpaseo/paseo/pull/5224))
- 修复了多步快捷键在两步之间应用更新时失败的问题 ([#5255](https://github.com/getpaseo/paseo/pull/5255) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了第二步按住修饰键时多步快捷键失败的问题 ([#5272](https://github.com/getpaseo/paseo/pull/5272))
- 修复了重新绑定的窗格聚焦快捷键在输入时失效的问题 ([#5287](https://github.com/getpaseo/paseo/pull/5287))

## 0.9.1 - 2026-09-22

### 新增

- 在 Claude Code 2.1.280 及更新版本上，Claude 目录新增 Opus 5.5 作为默认模型，支持 1M 上下文窗口和 Fast Mode ([#5200](https://github.com/getpaseo/paseo/pull/5200) by [@leonardourci](https://github.com/leonardourci), [@sebgalind0](https://github.com/sebgalind0), [@rp4ri](https://github.com/rp4ri))

### 修复

- 修复了应用重新连接 daemon 后侧边栏只保留最近有变化的对话的问题 ([#5189](https://github.com/getpaseo/paseo/pull/5189) by [@bagutzu](https://github.com/bagutzu))
- 修复了 Import session 只提供最新的 100 个 Codex 对话的问题 ([#5174](https://github.com/getpaseo/paseo/pull/5174) by [@3ae3ae](https://github.com/3ae3ae))
- 修复了 ID 带有次版本号的 Claude 模型（例如 Opus 5.5）在回合结束后于 Composer 中回退为其主版本的问题 ([#5200](https://github.com/getpaseo/paseo/pull/5200))

## 0.9.0 - 2026-09-22

### 新增

- 文件窗格新增 Cmd/Ctrl+F Find，可在可编辑文件中替换 ([#4589](https://github.com/getpaseo/paseo/pull/4589))
- 终端回滚缓冲区新增 Cmd/Ctrl+F Find ([#4650](https://github.com/getpaseo/paseo/pull/4650))
- 聊天新增 Cmd/Ctrl+F Find，包括已加载历史窗口之外的消息 ([#4765](https://github.com/getpaseo/paseo/pull/4765))
- 移动端 Changes 新增 Jump to file，在底部面板中打开已更改文件树 ([#4861](https://github.com/getpaseo/paseo/pull/4861))
- 检测到 PR 时，每个工作区会自动打开一次 Pull request 标签页 ([#4956](https://github.com/getpaseo/paseo/pull/4956))
- 新增可展开的计划卡片，被拒绝的计划默认折叠 ([#4756](https://github.com/getpaseo/paseo/pull/4756))
- 所选文件上传期间新增带加载图标的附件占位符 ([#4958](https://github.com/getpaseo/paseo/pull/4958))
- History 搜索中的工作区、Agent、项目和分支字段新增匹配高亮 ([#4945](https://github.com/getpaseo/paseo/pull/4945))

### 插件

- 新增从 npm 安装插件，包括有作用域的包、版本、标签和范围 ([#4975](https://github.com/getpaseo/paseo/pull/4975))
- 新增 `paseo plugin update`，支持 `--all`、`--check` 和 `--yes`，并在批准之前显示当前和拟更新的修订版本 ([#4975](https://github.com/getpaseo/paseo/pull/4975))
- Settings → Plugins 新增每个插件的描述、来源和已安装的修订版本 ([#4975](https://github.com/getpaseo/paseo/pull/4975))
- `navigation.openAgent()` 和 `navigation.openWorkspace()` 新增可选的 `serverId` ([#4942](https://github.com/getpaseo/paseo/pull/4942))
- 新增通过 `useHosts()` 发现主机，以及通过 `getPaseoClient(serverId)` 获取指定主机的 SDK 客户端 ([#4971](https://github.com/getpaseo/paseo/pull/4971))
- 新增 `openExternalUrl()` 和 `<ExternalLink>`，用于在 Paseo 之外打开 URL ([#4972](https://github.com/getpaseo/paseo/pull/4972))
- 新增 `navigation.openBrowser()`，用于在桌面端的工作区浏览器中打开 URL ([#4972](https://github.com/getpaseo/paseo/pull/4972))
- `registerSettings()` 现在返回一个带有 `read()` 和 `subscribe()` 的服务端设置句柄 ([#4674](https://github.com/getpaseo/paseo/pull/4674) by [@mcowger](https://github.com/mcowger))
- `assistant_message` 转换器现在在每次更新时都会收到完整的累计消息 ([#4675](https://github.com/getpaseo/paseo/pull/4675) by [@mcowger](https://github.com/mcowger), [@jegork](https://github.com/jegork))
- `tool_call` 转换器现在会在 Overview 分组之前收到每一个原始调用 ([#4675](https://github.com/getpaseo/paseo/pull/4675))
- 修复了插件会话的心跳租约过期后永久失去主机 API 的问题 ([#4912](https://github.com/getpaseo/paseo/pull/4912) by [@gpambrozio](https://github.com/gpambrozio))
- 修复了 Windows 上插件构建命令以 `spawn npm ENOENT` 失败的问题 ([#4776](https://github.com/getpaseo/paseo/pull/4776) by [@ABorakati](https://github.com/ABorakati))
- 修复了没有 `messageId` 的 ACP 文本块把一条回复拆成每块一条消息的问题 ([#4701](https://github.com/getpaseo/paseo/pull/4701) by [@L4XB](https://github.com/L4XB))
- 修复了嵌套的 Provider 子 Agent 显示为根 Agent 直接子项的问题 ([#4970](https://github.com/getpaseo/paseo/pull/4970))

### 变更

- History 搜索现在在按日期分组的结果中保持时间顺序，而不是按相关性重新排序 ([#4945](https://github.com/getpaseo/paseo/pull/4945))
- 工作区的 Restore 现在保持选中已归档的 Agent，并提供单独的 Unarchive 操作 ([#4736](https://github.com/getpaseo/paseo/pull/4736))
- 工作区错误界面的 Retry 改为 Reload，会重新打开到项目选择器 ([#4598](https://github.com/getpaseo/paseo/pull/4598))
- 关闭最后一个内容标签页后现在会留下 New 启动器，而不是一个无法使用的窗格 ([#4844](https://github.com/getpaseo/paseo/pull/4844))
- `paseo daemon start` 现在读取持久化的配置；已移除的配置标志会失败并给出迁移说明 ([#4575](https://github.com/getpaseo/paseo/pull/4575))

### 改进

- 回复流式输出时，粗体、斜体、删除线、行内代码和链接标签会保持格式 ([#4742](https://github.com/getpaseo/paseo/pull/4742))
- 一条三句话的回复，第一段语音音频的等待时间从 4.80 秒缩短到 0.95 秒 ([#4927](https://github.com/getpaseo/paseo/pull/4927))
- 在包含 213 个文件的工作区中，冷启动生成 diff 的时间从 11.45 秒缩短到 2.65 秒 ([#4676](https://github.com/getpaseo/paseo/pull/4676))
- 降低了桌面端内存占用：加载 daemon 管理后，Electron 主进程的 RSS 从 290.5 MiB 降至 152.1 MiB ([#5007](https://github.com/getpaseo/paseo/pull/5007))
- 打开的聊天在视图被回收、应用进入后台和重新连接时保持订阅 ([#4863](https://github.com/getpaseo/paseo/pull/4863))
- 聊天 toast 新增重新连接和 Updating messages 状态 ([#4863](https://github.com/getpaseo/paseo/pull/4863))
- 大文件上传期间在每个 128 KiB 分块之间让出主线程，使应用保持响应 ([#4958](https://github.com/getpaseo/paseo/pull/4958))
- 桌面窗口隐藏时，常驻的浏览器页面在两次截图之间进入空闲 ([#4646](https://github.com/getpaseo/paseo/pull/4646))

### 修复

- 修复了长对话中工具输出累积导致 daemon 堆内存耗尽的问题 ([#4838](https://github.com/getpaseo/paseo/pull/4838))
- 修复了重复提交为同一意图创建多个工作区或 Agent 的问题 ([#4442](https://github.com/getpaseo/paseo/pull/4442))
- 修复了关闭工作区中最后一个内容标签页后陷入崩溃循环的问题 ([#4844](https://github.com/getpaseo/paseo/pull/4844))
- 修复了已启用的 Provider 发布重复的模型 ID 时 New Agent 崩溃的问题 ([#4839](https://github.com/getpaseo/paseo/pull/4839))
- 修复了 Android 和 iOS 上长草稿延伸到聊天标题栏后面的问题 ([#4824](https://github.com/getpaseo/paseo/pull/4824))
- 修复了键盘关闭时 Android Composer 变高的问题 ([#4902](https://github.com/getpaseo/paseo/pull/4902))
- 修复了长按删除清空草稿后 Android Composer 仍保持原高度的问题 ([#4946](https://github.com/getpaseo/paseo/pull/4946))
- 修复了 Composer 变高时 New workspace 设置内容不向上移动的问题 ([#4973](https://github.com/getpaseo/paseo/pull/4973))
- 修复了在聊天中点击或选择文本时 Android 时间线滚走的问题 ([#5013](https://github.com/getpaseo/paseo/pull/5013))
- 修复了 Android 上 Paste image 在附件到达 Composer 之前就失败的问题 ([#4758](https://github.com/getpaseo/paseo/pull/4758))
- 修复了 Android 平板上 Provider 和模型选择器没有响应的问题 ([#4845](https://github.com/getpaseo/paseo/pull/4845) by [@cjcrjc](https://github.com/cjcrjc), [@mkuhl](https://github.com/mkuhl))
- 修复了 Linux 桌面包在没有 Chromium 沙箱的情况下启动的问题 ([#4447](https://github.com/getpaseo/paseo/pull/4447))
- 修复了 `paseo daemon stop` 关闭了所选 daemon 之外的 daemon 的问题 ([#4575](https://github.com/getpaseo/paseo/pull/4575))
- 修复了恢复的已归档工作区显示空的 Changes 和 Commits 的问题 ([#4926](https://github.com/getpaseo/paseo/pull/4926))
- 修复了被拒绝的计划显示在拒绝它的后续消息下方的问题 ([#4756](https://github.com/getpaseo/paseo/pull/4756))
- 修复了 Composer 获得焦点时 Cmd/Ctrl+F 无法打开聊天 Find 的问题 ([#4991](https://github.com/getpaseo/paseo/pull/4991))
- 修复了分支的远程是仓库 URL 时检测不到关联拉取请求的问题 ([#4862](https://github.com/getpaseo/paseo/pull/4862))
- 修复了插件过滤后的 Agent 列表替换了应用自己的目录订阅的问题 ([#4596](https://github.com/getpaseo/paseo/pull/4596))
- 修复了更新后的应用拒绝不支持独立订阅的 daemon 的问题 ([#4737](https://github.com/getpaseo/paseo/pull/4737))
- 修复了在 0.8.0 及更早的 daemon 上创建工作区和 Agent 失败，或 Agent 标题停留在 "Loading…" 的问题 ([#4895](https://github.com/getpaseo/paseo/pull/4895))
- 修复了 Cursor 模型显示另一个模型的思考选项的问题 ([#4180](https://github.com/getpaseo/paseo/pull/4180) by [@fidelix](https://github.com/fidelix))
- 修复了 Pi 模型选择器提供模型不支持的思考级别的问题 ([#4413](https://github.com/getpaseo/paseo/pull/4413) by [@mcowger](https://github.com/mcowger), [@therainisme](https://github.com/therainisme))
- 修复了 Pi 会话报告请求的思考级别而不是 Pi 实际应用的级别的问题 ([#4413](https://github.com/getpaseo/paseo/pull/4413))
- 修复了语音聊天的用户消息显示内部提示词包装而不是转写文本的问题 ([#4927](https://github.com/getpaseo/paseo/pull/4927))
- 修复了 History 和 Command Center 搜索匹配由不同单词中的字母拼成的查询的问题 ([#4945](https://github.com/getpaseo/paseo/pull/4945))
- 修复了触摸布局中工作区标题因隐藏的 diff 统计而过早截断的问题 ([#4698](https://github.com/getpaseo/paseo/pull/4698))
- 修复了拖动打开 Explorer 时显示 `+0 -0` 和 "No changes" 的问题 ([#4861](https://github.com/getpaseo/paseo/pull/4861))
- 修复了打开已保存的聊天时重新连接 toast 重新播放进入动画的问题 ([#4925](https://github.com/getpaseo/paseo/pull/4925))
- 修复了已更改文件底部面板中 Android 文件行周围出现凸起阴影的问题 ([#4898](https://github.com/getpaseo/paseo/pull/4898))

## 0.8.0 - 2026-09-10

Paseo 0.8 新增插件标题栏按钮、自定义 Provider 和更丰富的聊天组件，同时修复了桌面端更新和移动端键盘的问题。

**升级前须知**：macOS 桌面应用现在需要 macOS 13 或更新版本；Linux 和 Windows 的支持不变。为 0.7 编写的插件需要参考 [0.8 迁移指南](https://paseo.sh/docs/plugins/v0.8/migration)，包括分离的客户端/服务端入口以及修订后的 Composer 胶囊 API。

### 新增

- 新增 Agent 继续工作时 Codex 提出的问题的回答表单 ([#4587](https://github.com/getpaseo/paseo/pull/4587))
- 侧边栏菜单中已完成的工作区新增 Mark as unread ([#3603](https://github.com/getpaseo/paseo/pull/3603) by [@edihasaj](https://github.com/edihasaj))
- 在帮助菜单、Settings → About 和桌面端更新提示中新增应用内的 What's new 面板 ([#4576](https://github.com/getpaseo/paseo/pull/4576))
- 侧边栏底部、History 和 Command Center 新增 Import session ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- Import session 新增搜索、分页和按工作区过滤 ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- Appearance 设置新增侧边栏项的排序和可见性控制 ([#4203](https://github.com/getpaseo/paseo/pull/4203))
- 时间线新增来自 Pi 扩展和 OpenCode 的 Provider 通知 ([#3411](https://github.com/getpaseo/paseo/pull/3411) by [@trim21](https://github.com/trim21))
- Web 和桌面端新增全屏 Mermaid 查看器 ([#4107](https://github.com/getpaseo/paseo/pull/4107) by [@gengjiawen](https://github.com/gengjiawen))
- Web diff 的右键菜单新增 Copy、Copy line 和 Select all ([#4229](https://github.com/getpaseo/paseo/pull/4229))
- ACP Provider 目录新增 Gajae Code ([#3471](https://github.com/getpaseo/paseo/pull/3471) by [@Yeachan-Heo](https://github.com/Yeachan-Heo))
- 新增按 Provider 禁用全部或部分 Paseo 工具的控制 ([#4277](https://github.com/getpaseo/paseo/pull/4277) by [@mcowger](https://github.com/mcowger))
- 在 fork 拉取请求的工作区中运行设置、自动终端或脚本之前新增显式批准 ([#4215](https://github.com/getpaseo/paseo/pull/4215))
- 新增 Hub 对现有 Agent 的后续消息，包括恢复已归档的工作区 ([#4354](https://github.com/getpaseo/paseo/pull/4354))
- Hub 执行新增 Provider 目录发现 ([#4242](https://github.com/getpaseo/paseo/pull/4242))

### 插件

- 新增自定义 Provider，可以有自己的图标、设置、权限和时间线渲染 ([#4314](https://github.com/getpaseo/paseo/pull/4314))
- 新增插件重新加载后的 Provider 会话恢复 ([#4629](https://github.com/getpaseo/paseo/pull/4629) by [@mcowger](https://github.com/mcowger))
- 新增自定义时间线组件和持久化的时间线行 ([e34aea2](https://github.com/getpaseo/paseo/commit/e34aea206e6ec7ac2d5fa9766db28fb221ae990c))
- 新增无需 Provider 回合即可运行的客户端斜杠命令 ([e34aea2](https://github.com/getpaseo/paseo/commit/e34aea206e6ec7ac2d5fa9766db28fb221ae990c))
- 在 Settings → Plugins 下新增插件设置界面 ([#4357](https://github.com/getpaseo/paseo/pull/4357))
- 新增 Agent 创建、回合、权限和归档事件的生命周期 hook ([#4435](https://github.com/getpaseo/paseo/pull/4435))
- 新增针对新 Agent 的 Provider、模型、环境变量、MCP 服务器和工作区隔离的转换 ([#4435](https://github.com/getpaseo/paseo/pull/4435))
- 新增标题栏按钮和 Composer 胶囊，支持操作、菜单、自定义弹出框和实时更新 ([#4577](https://github.com/getpaseo/paseo/pull/4577))
- 新增自定义弹窗主体，支持滚动、感知键盘的输入框和剪贴板操作 ([#4392](https://github.com/getpaseo/paseo/pull/4392))
- SDK 新增终端的创建、输入、捕获和管理 ([#4358](https://github.com/getpaseo/paseo/pull/4358))
- 新增通过 `paseo.projects.subscribe()` 实时订阅项目 ([#3983](https://github.com/getpaseo/paseo/pull/3983) by [@omercnet](https://github.com/omercnet))
- 新增通过 `agent.respondToPermission()` 响应权限请求 ([#3985](https://github.com/getpaseo/paseo/pull/3985) by [@omercnet](https://github.com/omercnet))
- 新增通过 `providers.listUsage()` 查询 Provider 用量 ([#4062](https://github.com/getpaseo/paseo/pull/4062) by [@ivanbrykov](https://github.com/ivanbrykov))
- 插件 manifest 新增支持的 Paseo 版本要求 ([#4430](https://github.com/getpaseo/paseo/pull/4430))
- 插件现在分为客户端和服务端入口，并使用针对各自运行时的 SDK 导入 ([#4347](https://github.com/getpaseo/paseo/pull/4347) by [@liujin0506](https://github.com/liujin0506), [@panrafal](https://github.com/panrafal))
- Composer 胶囊注册改为使用 `button`、`registration.update()` 和 `registration.remove()` ([#4577](https://github.com/getpaseo/paseo/pull/4577))
- `paseo plugin ls` 现在显示运行时状态、已安装的提交和加载错误，而无需联系远程 ([#4265](https://github.com/getpaseo/paseo/pull/4265))
- 修复了 Explorer 菜单中缺少工作区插件面板的问题 ([#4446](https://github.com/getpaseo/paseo/pull/4446))

### 变更

- 桌面应用现在需要 macOS 13 或更新版本；macOS 12 将不再收到桌面端更新 ([#4322](https://github.com/getpaseo/paseo/pull/4322))
- `--host` 改为全局 CLI 选项：`paseo --host <target> <command>` ([#4238](https://github.com/getpaseo/paseo/pull/4238))
- 侧边栏底部的 Home 按钮改为 Import session ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- `paseo hub init` 和默认的 `paseo hub deploy` 现在使用 `.paseo/triggers/` 中的组织触发器 ([#4517](https://github.com/getpaseo/paseo/pull/4517))
- Codex Fast 的可用性改为基于受支持的模型列表，包括 GPT-6 Astra ([#4640](https://github.com/getpaseo/paseo/pull/4640))
- CLI 安装现在解析到打过补丁的 React 19.1.x 版本 ([#4100](https://github.com/getpaseo/paseo/pull/4100) by [@liujin0506](https://github.com/liujin0506))

### 改进

- 回到应用时立即重新连接所有主机 ([#4160](https://github.com/getpaseo/paseo/pull/4160))
- 时间线和 Composer 一起移动，使移动端键盘过渡更平滑 ([#4275](https://github.com/getpaseo/paseo/pull/4275))
- 减少了打开大型 diff 时的卡顿 ([#4574](https://github.com/getpaseo/paseo/pull/4574))
- 只重新加载配置发生变化的 Provider ([#4332](https://github.com/getpaseo/paseo/pull/4332))
- 移除了空闲 SDK 连接上未请求的时间线和目录流量 ([#4470](https://github.com/getpaseo/paseo/pull/4470))
- App Diagnostics 新增 macOS 更新程序的诊断信息 ([#4322](https://github.com/getpaseo/paseo/pull/4322))

### 修复

- 修复了 macOS 桌面端更新关闭应用却没有安装新版本的问题 ([#4322](https://github.com/getpaseo/paseo/pull/4322))
- 修复了发布清单可用之前桌面更新程序就报告已是最新的问题 ([#4201](https://github.com/getpaseo/paseo/pull/4201))
- 修复了在 Linux `.deb`、RPM 和 tarball 安装中，从桌面端安装的 CLI 执行 `paseo restart` 失败的问题 ([#4207](https://github.com/getpaseo/paseo/pull/4207))
- 修复了打包后的 macOS Dock 图标显示过大的问题 ([#4389](https://github.com/getpaseo/paseo/pull/4389))
- 修复了使用工具栏按键或 Enter 时移动端终端键盘关闭又重新打开的问题 ([#4469](https://github.com/getpaseo/paseo/pull/4469))
- 修复了加载期间收到实时更新时缓存的对话和工作区列表无法显示的问题 ([#4436](https://github.com/getpaseo/paseo/pull/4436))
- 修复了应用在后台时回合完成后排队的消息不发送的问题 ([#4160](https://github.com/getpaseo/paseo/pull/4160))
- 修复了工作区归档后 Codex 重新加载和后续消息因 active-writer 错误而失败的问题 ([#4353](https://github.com/getpaseo/paseo/pull/4353))
- 修复了重复的 Claude 压缩更新留下多余的、一直转圈的 Compacting 行的问题 ([#4391](https://github.com/getpaseo/paseo/pull/4391) by [@tomgrin10](https://github.com/tomgrin10))
- 修复了扩展触发的回合之后 Pi Agent 卡在运行中的问题 ([#3849](https://github.com/getpaseo/paseo/pull/3849) by [@mjakl](https://github.com/mjakl))
- 修复了你切换到别处后，延迟完成的工作区创建仍会跳转过去的问题 ([#2986](https://github.com/getpaseo/paseo/pull/2986) by [@cleiter](https://github.com/cleiter))
- 修复了创建工作区后 New workspace 丢失所选模型的问题 ([#4401](https://github.com/getpaseo/paseo/pull/4401))
- 修复了创建工作区期间所选 Provider 消失导致崩溃的问题 ([#4332](https://github.com/getpaseo/paseo/pull/4332))
- 修复了模型选择器中 Codex 模型行一直显示 Loading 的问题 ([#4283](https://github.com/getpaseo/paseo/pull/4283) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了嵌套的子 Agent 显示在根 Agent 下而不是其实际父 Agent 下的问题 ([#4321](https://github.com/getpaseo/paseo/pull/4321))
- 修复了自主回合之间重复的工具调用 ID 产生重复时间线行的问题 ([140b0bb](https://github.com/getpaseo/paseo/commit/140b0bb716205cf0e00c0ff5b6b3c20af6c79413))
- 修复了某个 Provider 挂起时 Import session 一直加载的问题 ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- 修复了 Import session 忽略 Claude Code `/rename` 标题的问题 ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- 修复了导入会话会为已打开的目录创建重复工作区的问题 ([#4216](https://github.com/getpaseo/paseo/pull/4216))
- 修复了空的 ACP 会话出现在 Import session 中的问题 ([#4335](https://github.com/getpaseo/paseo/pull/4335))
- 修复了恢复的终端标题在加载前短暂显示 Terminal 的问题 ([#4553](https://github.com/getpaseo/paseo/pull/4553))
- 修复了 Web 和桌面端滚动时 diff 文件标题滞后的问题 ([#4240](https://github.com/getpaseo/paseo/pull/4240))
- 修复了在 Committed 和 Uncommitted 之间切换时 Changes 与其 diff 不同步的问题 ([#4199](https://github.com/getpaseo/paseo/pull/4199))
- 修复了 Mermaid 图表在流式输出期间缩小或在重新加载后损坏的问题 ([#4210](https://github.com/getpaseo/paseo/pull/4210))
- 修复了桌面端 Settings 导航在内存中保留已关闭视图的问题 ([#4228](https://github.com/getpaseo/paseo/pull/4228))
- 修复了 Windows 上文件监视器漏掉嵌套目录变化的问题 ([#4354](https://github.com/getpaseo/paseo/pull/4354))
- 修复了 daemon 的 Git 命令允许仓库的 `core.fsmonitor` 执行其自定义命令的问题 ([#4208](https://github.com/getpaseo/paseo/pull/4208))
- 修复了 OpenCode 2 会话的终端活动报告 ([#4300](https://github.com/getpaseo/paseo/pull/4300) by [@mr-karan](https://github.com/mr-karan))
- 修复了网站在加载完成前提供错误平台下载的问题 ([#4222](https://github.com/getpaseo/paseo/pull/4222))

## 0.7.2 - 2026-09-02

### 新增

- pi Agent 新增回合中引导，新消息可以到达正在进行的回合而不会中断它 ([#3752](https://github.com/getpaseo/paseo/pull/3752) by [@mcowger](https://github.com/mcowger))
- 托管在 Git 上的插件新增声明式构建命令和 monorepo 源路径 ([#4158](https://github.com/getpaseo/paseo/pull/4158))

### 改进

- 减少了在移动端观看流式输出的 Agent 时的 JS 卡顿 ([#4190](https://github.com/getpaseo/paseo/pull/4190))

### 修复

- 修复了打开和滚动大型或包含大量文件的 diff 时卡顿或崩溃的问题 ([#4174](https://github.com/getpaseo/paseo/pull/4174))
- 修复了 JS 卡顿跨越动画时移动端侧边栏和 Explorer 面板失去停靠位置的问题 ([#4190](https://github.com/getpaseo/paseo/pull/4190))
- 把渲染内容限制在 32,000 个字符，修复了单条超大助手消息导致时间线崩溃的问题 ([#4166](https://github.com/getpaseo/paseo/pull/4166))
- 修复了 Codex 0.151 及更高版本上分页线程的 Codex 回退失败的问题 ([#4119](https://github.com/getpaseo/paseo/pull/4119))
- 修复了按 Escape 关闭图片预览时同时中断正在运行的 Agent 的问题 ([#4161](https://github.com/getpaseo/paseo/pull/4161))
- 修复了 Windows 上 daemon 停止和重启跳过优雅关闭并遗留孤立 Agent 进程的问题 ([#4168](https://github.com/getpaseo/paseo/pull/4168))
- 修复了 OMP 启动无论配置的 RPC 超时是多少都在 10 秒时超时的问题 ([#4143](https://github.com/getpaseo/paseo/pull/4143) by [@Juns-g](https://github.com/Juns-g))
- 修复了没有可见提示词的已完成回合不显示完成时间的问题 ([#4170](https://github.com/getpaseo/paseo/pull/4170))
- 修复了文件标识元数据不可用时 Explorer 重命名会替换已存在文件的问题 ([#4171](https://github.com/getpaseo/paseo/pull/4171))

## 0.7.1 - 2026-09-01

### 新增

- 新增支持 1M 上下文窗口的 Claude Fable 5.1 ([#4179](https://github.com/getpaseo/paseo/pull/4179))

## 0.7.0 - 2026-08-31

### 变更

- 项目许可证改为 Apache-2.0 ([#3944](https://github.com/getpaseo/paseo/pull/3944))
- Cmd/Ctrl+E 改为切换 Explorer 的可见性，而不选择视图 ([#3896](https://github.com/getpaseo/paseo/pull/3896))
- 移动端默认内容文字大小从 15px 改为 16px ([#4111](https://github.com/getpaseo/paseo/pull/4111))

### 新增

- 新增直接从 Git 仓库安装和更新插件 ([#3920](https://github.com/getpaseo/paseo/pull/3920))
- 新增由插件定义的时间线转换和渲染 ([#3940](https://github.com/getpaseo/paseo/pull/3940))
- 新增从桌面端和 CLI 通过 SSH 连接到已有的远程 daemon ([#3989](https://github.com/getpaseo/paseo/pull/3989) by [@reidlevesque](https://github.com/reidlevesque))
- Command Center 新增工作区管理和布局操作 ([#3013](https://github.com/getpaseo/paseo/pull/3013) by [@cleiter](https://github.com/cleiter))
- 新增插件的上下文相关 Composer 胶囊贡献 ([#3956](https://github.com/getpaseo/paseo/pull/3956))
- 新增面向客户端插件的宿主 UI 基础组件 ([#3967](https://github.com/getpaseo/paseo/pull/3967))
- Paseo 工具调用新增可读的提示词、详情和结果 ([#4066](https://github.com/getpaseo/paseo/pull/4066))
- 工作区图片和助手时间线预览新增缩放和平移 ([#4032](https://github.com/getpaseo/paseo/pull/4032), [#4049](https://github.com/getpaseo/paseo/pull/4049), [#4064](https://github.com/getpaseo/paseo/pull/4064))
- 新增直接在首选的桌面编辑器中打开子文件夹 ([#3615](https://github.com/getpaseo/paseo/pull/3615) by [@caikovsky](https://github.com/caikovsky))
- 新增从插件界面导航到 Agent 和工作区 ([#3901](https://github.com/getpaseo/paseo/pull/3901) by [@omercnet](https://github.com/omercnet))
- 插件客户端界面新增由宿主渲染的图标 ([#3903](https://github.com/getpaseo/paseo/pull/3903) by [@omercnet](https://github.com/omercnet))
- 插件主题新增语义化的表面、边框、成功和警告颜色 ([#3898](https://github.com/getpaseo/paseo/pull/3898) by [@omercnet](https://github.com/omercnet))
- 公开的插件 SDK 新增已注册项目列表 ([#3899](https://github.com/getpaseo/paseo/pull/3899) by [@omercnet](https://github.com/omercnet))
- Command Center 新增按 PR 和 MR 编号搜索 ([#3008](https://github.com/getpaseo/paseo/pull/3008) by [@cleiter](https://github.com/cleiter))
- Agent SDK 句柄新增会话命令 ([#3719](https://github.com/getpaseo/paseo/pull/3719) by [@gpambrozio](https://github.com/gpambrozio), [@marvin-ambrozio](https://github.com/marvin-ambrozio))
- 新增 F-Droid 发布元数据和稳定版更新日志生成 ([#2501](https://github.com/getpaseo/paseo/pull/2501) by [@antonok-edm](https://github.com/antonok-edm))
- 文件、编辑器和 diff 新增 Astro 语法高亮 ([#3997](https://github.com/getpaseo/paseo/pull/3997))

### 改进

- 助手文本以稳定的视觉速率流式显示，而不是按到达时的块显示 ([#3612](https://github.com/getpaseo/paseo/pull/3612) by [@Tommypop2](https://github.com/Tommypop2))
- 在恢复无关缓存和网络加载之前先绘制缓存的对话 ([#3907](https://github.com/getpaseo/paseo/pull/3907))
- 普通 Agent 会话复用同一个 OpenCode 辅助进程，而不是每个 Agent 启动一个 ([#4009](https://github.com/getpaseo/paseo/pull/4009))
- 在预留的 API 配额内批量轮询 GitHub 拉取请求 ([#3825](https://github.com/getpaseo/paseo/pull/3825) by [@dezchai](https://github.com/dezchai))
- GitLab 和 Gitea 检查新增手动、需要操作和警告状态 ([#2337](https://github.com/getpaseo/paseo/pull/2337) by [@nllptrx](https://github.com/nllptrx))
- 冷启动时的拉取请求状态检查继续使用共享的 GitHub 批量路径 ([#4025](https://github.com/getpaseo/paseo/pull/4025))

### 修复

- 修复了 Claude 或 OMP 的 JSONL 进程在写入期间关闭导致 daemon 崩溃的问题 ([#4048](https://github.com/getpaseo/paseo/pull/4048))
- 修复了 Composer 销毁期间键盘重启导致 Android 首条消息提交崩溃的问题 ([#4044](https://github.com/getpaseo/paseo/pull/4044))
- 修复了移动端长草稿把 Composer 控件挡在键盘后面的问题 ([#4051](https://github.com/getpaseo/paseo/pull/4051))
- 修复了点击可选择文本时 Android 时间线发生偏移的问题 ([#4090](https://github.com/getpaseo/paseo/pull/4090))
- 修复了 Web 和 Electron 的 Composer 在提交后失去焦点的问题 ([#4067](https://github.com/getpaseo/paseo/pull/4067))
- 修复了 Android 语音输入在采集停止后让蓝牙音频保持通话质量路由的问题 ([#4069](https://github.com/getpaseo/paseo/pull/4069))
- 修复了放弃部分转写后语音输入重试超时的问题 ([#4065](https://github.com/getpaseo/paseo/pull/4065))
- 修复了立即提交语音输入时遗漏最新语音片段的问题 ([#3968](https://github.com/getpaseo/paseo/pull/3968))
- 修复了 iPad 桌面布局中模型选择器崩溃的问题 ([#3992](https://github.com/getpaseo/paseo/pull/3992) by [@yzim](https://github.com/yzim))
- 修复了 Provider 子 Agent 时间线中缺少 OpenCode 子会话提示词的问题 ([#4055](https://github.com/getpaseo/paseo/pull/4055) by [@mcowger](https://github.com/mcowger))
- 修复了从 History 打开已归档的 Agent 时 Agent 消失的问题 ([#4033](https://github.com/getpaseo/paseo/pull/4033))
- 修复了恢复的工作区标签页陷入协调循环的问题 ([#3987](https://github.com/getpaseo/paseo/pull/3987))
- 修复了已归档的工作区从持久缓存中重新出现的问题 ([#3975](https://github.com/getpaseo/paseo/pull/3975))
- 修复了 Grok 统一计费账号显示零额度而不是每周用量的问题 ([#4029](https://github.com/getpaseo/paseo/pull/4029) by [@Lite-G](https://github.com/Lite-G), [@claude](https://github.com/claude))
- 修复了 Git 进程排队时 daemon 重新连接停滞的问题 ([#3945](https://github.com/getpaseo/paseo/pull/3945))
- 修复了较慢的 Pi 和 OMP 启动请求在 30 秒后超时的问题 ([#4008](https://github.com/getpaseo/paseo/pull/4008))
- 修复了提交和 squash 合并绕过配置的 Git 签名的问题 ([#3976](https://github.com/getpaseo/paseo/pull/3976))
- 修复了 Android 系统导航栏遮挡 Commits 控件的问题 ([#4005](https://github.com/getpaseo/paseo/pull/4005))
- 修复了新的 Agent 工作显示为重新打开的任务的问题 ([#4068](https://github.com/getpaseo/paseo/pull/4068))
- 修复了 Markdown 中的字面字符被替换为排版符号的问题 ([#3253](https://github.com/getpaseo/paseo/pull/3253) by [@cleiter](https://github.com/cleiter))
- 修复了回退长对话时重放整个重建的时间线的问题 ([#3642](https://github.com/getpaseo/paseo/pull/3642))
- 修复了回退的提示词在已挂载的 iOS Composer 中仍为空白的问题 ([#3946](https://github.com/getpaseo/paseo/pull/3946))
- 修复了 iOS 上原生插件设置和异步客户端回调失败的问题 ([#3942](https://github.com/getpaseo/paseo/pull/3942))
- 修复了 ACP Agent 把终端能力报告为不可用的问题 ([#3910](https://github.com/getpaseo/paseo/pull/3910) by [@pmilanez](https://github.com/pmilanez))
- 修复了已取消的 Claude 权限请求留下过时权限卡片的问题 ([#3792](https://github.com/getpaseo/paseo/pull/3792))
- 修复了插件 daemon 会话隐藏非旧版 Provider 的 Agent 的问题 ([#3902](https://github.com/getpaseo/paseo/pull/3902) by [@omercnet](https://github.com/omercnet))
- 修复了手动允许的桌面端更新在就绪检查期间消失的问题 ([#3865](https://github.com/getpaseo/paseo/pull/3865))
- 修复了移动端 Changes 和拉取请求操作在 Explorer 之外打开的问题 ([#3867](https://github.com/getpaseo/paseo/pull/3867))
- 修复了旧版桌面构建删除新版构建写入的设置的问题 ([#3909](https://github.com/getpaseo/paseo/pull/3909) by [@cleiter](https://github.com/cleiter))
- 修复了从 Settings 返回后 Composer 高度闪烁的问题 ([#3943](https://github.com/getpaseo/paseo/pull/3943))
- 修复了 Light 主题中所选工作区没有可见高亮的问题 ([#3922](https://github.com/getpaseo/paseo/pull/3922) by [@wdaubney](https://github.com/wdaubney))
- 修复了滚动 diff 的顺序与 Changes 树不一致的问题 ([#3913](https://github.com/getpaseo/paseo/pull/3913) by [@cleiter](https://github.com/cleiter))
- 修复了 Close 操作的西班牙语翻译错误 ([#3934](https://github.com/getpaseo/paseo/pull/3934) by [@antonio](https://github.com/antonio))

## 0.6.1 - 2026-08-25

### 改进

- Command Center 现在可以以任意顺序匹配部分多词查询，并按相关性对可见结果排序 ([#2971](https://github.com/getpaseo/paseo/pull/2971) by [@cleiter](https://github.com/cleiter))

### 修复

- 修复了升级后持久化的 Side panel 标签页被放进 Explorer 而不是普通侧窗格的问题 ([#3861](https://github.com/getpaseo/paseo/pull/3861))
- 修复了桌面端和 Web 上按 Escape 后 Settings 仍保持打开的问题 ([#2828](https://github.com/getpaseo/paseo/pull/2828) by [@mcowger](https://github.com/mcowger))
- 修复了切换分支会隐藏当前拉取请求，或因已合并的拉取请求而触发自动归档的问题 ([#3799](https://github.com/getpaseo/paseo/pull/3799))

## 0.6.0 - 2026-08-25

### 变更

- 恢复了专用的 Explorer 侧边栏，默认包含 Files 和 Changes，取代 0.5.0 中引入的、由用户自行安排的空 Side panel ([#3826](https://github.com/getpaseo/paseo/pull/3826))
- 在侧边打开的内容现在使用普通的、可关闭的工作区窗格，而不是 Explorer 侧边栏 ([#3826](https://github.com/getpaseo/paseo/pull/3826))
- 恢复了平板上可调整大小的组合式 Explorer 停靠栏 ([#3826](https://github.com/getpaseo/paseo/pull/3826))

### 新增

- 新增按操作设置在主面板或侧边打开文件、更改、子 Agent 和拉取请求 ([#3826](https://github.com/getpaseo/paseo/pull/3826))
- Explorer 中新增 New tab，并支持拖动兼容的文件、diff、Agent、终端、拉取请求和插件面板 ([#3826](https://github.com/getpaseo/paseo/pull/3826))
- 新增独立的 Diff 标签页，同时在 Changes 中保留可选且会持久保存的内联 diff 模式 ([#3826](https://github.com/getpaseo/paseo/pull/3826))
- 新增 Windows 和 Linux 上的自定义窗口控件 ([#3826](https://github.com/getpaseo/paseo/pull/3826))

### 修复

- 修复了启动期间第一个事件流连接停滞时 OpenCode 回合失败的问题 ([#3814](https://github.com/getpaseo/paseo/pull/3814))
- 修复了 Provider 报告连接就绪之前 OpenCode 提示词就开始执行的问题 ([#3821](https://github.com/getpaseo/paseo/pull/3821))

## 0.5.2 - 2026-08-24

### 修复

- 修复了 Android 平板和折叠屏在非紧凑布局下工作区崩溃的问题 ([#3760](https://github.com/getpaseo/paseo/pull/3760) by [@jeid64](https://github.com/jeid64))
- 修复了共享同一配置的不同构建识别的设置不同时应用设置被重置的问题 ([#3787](https://github.com/getpaseo/paseo/pull/3787))

## 0.5.1 - 2026-08-23

### 修复

- 修复了 iOS 和 Android 上多行 Composer 在工作区和 Agent 切换后不再调整大小的问题 ([#3740](https://github.com/getpaseo/paseo/pull/3740))

## 0.5.0 - 2026-08-23

### 新增

- 新增实验性的受信任本地插件 ([#3222](https://github.com/getpaseo/paseo/pull/3222), [#3446](https://github.com/getpaseo/paseo/pull/3446), [#3465](https://github.com/getpaseo/paseo/pull/3465))
- Settings → Appearance 新增由插件贡献的应用主题 ([#3602](https://github.com/getpaseo/paseo/pull/3602) by [@ragokan](https://github.com/ragokan))
- 新增由用户自行安排的 Side panel，带有独立的标签页 ([#3287](https://github.com/getpaseo/paseo/pull/3287), [#3605](https://github.com/getpaseo/paseo/pull/3605))
- 新增浏览器风格的 New 标签页，带有锚定在窗格内的选择器 ([#3715](https://github.com/getpaseo/paseo/pull/3715), [#3735](https://github.com/getpaseo/paseo/pull/3735))
- Claude、Codex 和 OpenCode 新增回合中引导 ([#3394](https://github.com/getpaseo/paseo/pull/3394), [#3580](https://github.com/getpaseo/paseo/pull/3580) by [@mcowger](https://github.com/mcowger))
- 新增用于侧边栏组织和过滤的工作区标签 ([#3510](https://github.com/getpaseo/paseo/pull/3510) by [@cleiter](https://github.com/cleiter))
- 在活动 Agent 的 Composer 上方新增实时的工作区更改计数 ([#3682](https://github.com/getpaseo/paseo/pull/3682))
- Command Center 新增工作区面板、标签页和窗格操作 ([#3685](https://github.com/getpaseo/paseo/pull/3685))
- 新增 `paseo project`，可在终端中创建、列出、重命名和删除项目 ([#3460](https://github.com/getpaseo/paseo/pull/3460))
- 新增 `paseo reload`，无需重启 daemon 即可应用可在运行时安全生效的 `config.json` 更改 ([#3365](https://github.com/getpaseo/paseo/pull/3365))
- Host → Agents 新增 Paseo 技能管理，包括远程主机 ([#3451](https://github.com/getpaseo/paseo/pull/3451))
- 侧边栏显示菜单新增按项目过滤 ([#3563](https://github.com/getpaseo/paseo/pull/3563) by [@cleiter](https://github.com/cleiter))
- 工作区行新增可选显示的分支和项目名称 ([#3445](https://github.com/getpaseo/paseo/pull/3445))
- 新增拖放调整已固定工作区的顺序 ([#3341](https://github.com/getpaseo/paseo/pull/3341))
- 新增从模型选择器一键创建 Agent 配置 ([#3533](https://github.com/getpaseo/paseo/pull/3533))
- Open in editor 新增 Android Studio ([#3531](https://github.com/getpaseo/paseo/pull/3531), [#3614](https://github.com/getpaseo/paseo/pull/3614) by [@caikovsky](https://github.com/caikovsky))
- 一键 ACP Provider 目录新增 MiniMax Code ([#3457](https://github.com/getpaseo/paseo/pull/3457) by [@hetaoBackend](https://github.com/hetaoBackend))
- 新增 Nix 语法高亮 ([#3110](https://github.com/getpaseo/paseo/pull/3110) by [@Strainy](https://github.com/Strainy))
- 新增 Svelte 语法高亮 ([#3487](https://github.com/getpaseo/paseo/pull/3487), [#3534](https://github.com/getpaseo/paseo/pull/3534) by [@fiorelorenzo](https://github.com/fiorelorenzo))
- 新增引导式 Hub 设置，可连接 daemon 并部署一个兼容的入门 workflow ([#3651](https://github.com/getpaseo/paseo/pull/3651), [#3657](https://github.com/getpaseo/paseo/pull/3657), [#3677](https://github.com/getpaseo/paseo/pull/3677))

### 改进

- 主机重新连接期间立即恢复缓存的项目、工作区、Agent 和时间线 ([#3259](https://github.com/getpaseo/paseo/pull/3259), [#3329](https://github.com/getpaseo/paseo/pull/3329))
- 减少了桌面端和 Android 上长聊天时切换工作区的卡顿 ([#3447](https://github.com/getpaseo/paseo/pull/3447), [#3610](https://github.com/getpaseo/paseo/pull/3610))
- Web 和桌面端的 Composer 输入保持在帧预算之内 ([#3450](https://github.com/getpaseo/paseo/pull/3450))
- 大型 diff 在展开、滚动和评论时保持响应 ([#3422](https://github.com/getpaseo/paseo/pull/3422))
- 通过有界渲染使大型只读源码预览保持响应 ([#3665](https://github.com/getpaseo/paseo/pull/3665))
- 长时间运行的 Agent 时间线不再完整重写对话记录到磁盘 ([#3647](https://github.com/getpaseo/paseo/pull/3647))
- 拉取请求检查新增结果摘要，并优先分组显示失败项 ([#3483](https://github.com/getpaseo/paseo/pull/3483))
- 子 Agent 和任务跟踪器移到了 Composer 上方的胶囊中 ([#3482](https://github.com/getpaseo/paseo/pull/3482))
- 移动端 Agent 配置简化为一个选项面板 ([#3424](https://github.com/getpaseo/paseo/pull/3424))
- 在紧凑布局中，汇总的工具调用组改为在实时更新的底部面板中打开 ([#3619](https://github.com/getpaseo/paseo/pull/3619))
- 为聊天、Composer、Markdown 和审查文本新增单独的 Content 文字大小设置 ([#3637](https://github.com/getpaseo/paseo/pull/3637))
- Pi 的用量和上下文计量在回合进行中更新 ([#3532](https://github.com/getpaseo/paseo/pull/3532))
- Archive finished 现在会归档栏中所有已完成的子 Agent ([#3368](https://github.com/getpaseo/paseo/pull/3368))
- 自动的 Setup 标签页现在只在工作区设置失败后出现 ([#3634](https://github.com/getpaseo/paseo/pull/3634))
- Settings 中的 Default send 改为下拉菜单 ([#3644](https://github.com/getpaseo/paseo/pull/3644))
- 桌面应用和 CLI 中的配对链接新增“等同于密码”的警告 ([#3734](https://github.com/getpaseo/paseo/pull/3734))
- 修正了俄语界面翻译和术语 ([#3586](https://github.com/getpaseo/paseo/pull/3586) by [@timz](https://github.com/timz))

### 修复

- 修复了文本框和移动端终端中 CJK 输入法组字被取消的问题 ([#2811](https://github.com/getpaseo/paseo/pull/2811), [#3343](https://github.com/getpaseo/paseo/pull/3343), [#3391](https://github.com/getpaseo/paseo/pull/3391), [#3462](https://github.com/getpaseo/paseo/pull/3462), [#3517](https://github.com/getpaseo/paseo/pull/3517) by [@northsea4](https://github.com/northsea4), [@jimersylee](https://github.com/jimersylee), [@ZacharyZcR](https://github.com/ZacharyZcR), [@chulmin-dev](https://github.com/chulmin-dev))
- 修复了事件流断开时 OpenCode 回合失败的问题 ([#3395](https://github.com/getpaseo/paseo/pull/3395))
- 修复了启动较慢或加载大量插件时 OpenCode Agent 超时的问题 ([#3578](https://github.com/getpaseo/paseo/pull/3578), [#3621](https://github.com/getpaseo/paseo/pull/3621) by [@BrianAguilarWasco](https://github.com/BrianAguilarWasco))
- 修复了不相关的已合并拉取请求导致工作区被归档的问题 ([#3425](https://github.com/getpaseo/paseo/pull/3425))
- 修复了在已加载的桌面浏览器页面上 Annotate element 和 Screenshot element 没有反应的问题 ([#3187](https://github.com/getpaseo/paseo/pull/3187) by [@dgk-dev](https://github.com/dgk-dev))
- 修复了 heartbeat 运行后重复出现复制和 fork 页脚的问题 ([#3484](https://github.com/getpaseo/paseo/pull/3484))
- 修复了只通过 `cursor-agent` 登录的主机上 Cursor 套餐用量的问题 ([#3486](https://github.com/getpaseo/paseo/pull/3486) by [@Lite-G](https://github.com/Lite-G))
- 修复了移动端 Composer 在提交后仍保留已发送文本的问题 ([#3564](https://github.com/getpaseo/paseo/pull/3564))
- 修复了多行 Composer 在工作区和草稿的生命周期之间保留过时高度的问题 ([#3681](https://github.com/getpaseo/paseo/pull/3681), [#3740](https://github.com/getpaseo/paseo/pull/3740))
- 修复了目标仓库被配置为 `upstream` 时检出拉取请求的问题 ([#2997](https://github.com/getpaseo/paseo/pull/2997) by [@mcowger](https://github.com/mcowger))
- 修复了 Claude 或 Codex 等待权限时 Composer 的引导消息一直未被读取的问题 ([#3585](https://github.com/getpaseo/paseo/pull/3585) by [@cleiter](https://github.com/cleiter))
- 修复了检出状态变化后 Changes 打开空比较的问题 ([#3636](https://github.com/getpaseo/paseo/pull/3636))
- 修复了自动重试成功期间 Pi 聊天以错误状态结束的问题 ([#3639](https://github.com/getpaseo/paseo/pull/3639))
- 修复了 macOS 钥匙串中有多个凭据项时 Claude 用量显示为不可用的问题 ([#3597](https://github.com/getpaseo/paseo/pull/3597) by [@t-benoit](https://github.com/t-benoit))
- 修复了 Provider 用量检查覆盖 Claude 或 Codex 凭据文件的问题 ([#3442](https://github.com/getpaseo/paseo/pull/3442) by [@danberindei](https://github.com/danberindei))
- 修复了原生线程在 Paseo 之外被归档后活动的 Codex Agent 无法打开的问题 ([#3334](https://github.com/getpaseo/paseo/pull/3334))
- 修复了 Provider 已经结束回合后 Agent 仍然无法停止的问题 ([#3742](https://github.com/getpaseo/paseo/pull/3742))
- 修复了创建 worktree 时拒绝包含大写字母、下划线或点的合法 Git 分支名的问题 ([#3591](https://github.com/getpaseo/paseo/pull/3591))
- 修复了 New Workspace 中项目图标显示过时图片的问题 ([#3600](https://github.com/getpaseo/paseo/pull/3600))
- 修复了格式错误的 SVG 项目图标导致 iOS 应用崩溃的问题 ([#3711](https://github.com/getpaseo/paseo/pull/3711) by [@omercnet](https://github.com/omercnet))
- 修复了固定项目唯一的工作区后其 New workspace 操作被隐藏的问题 ([#3722](https://github.com/getpaseo/paseo/pull/3722) by [@yugui923](https://github.com/yugui923))
- 修复了工作区布局变化绕过时间线重试退避的问题 ([#3736](https://github.com/getpaseo/paseo/pull/3736))
- 修复了全新安装解析到未经该版本验证的 Provider SDK 版本的问题 ([#3678](https://github.com/getpaseo/paseo/pull/3678))

## 0.4.0 - 2026-08-13

### 破坏性变更

- 移除了 `paseo chat` 和 `paseo loop` ([#3053](https://github.com/getpaseo/paseo/pull/3053))

### 新增

- 新增主机级的 Agent 配置，可复用 Provider、模型、模式、思考和功能设置 ([#3208](https://github.com/getpaseo/paseo/pull/3208))
- Cmd/Ctrl+P 新增工作区文件搜索 ([#3059](https://github.com/getpaseo/paseo/pull/3059))
- Files 和 Changes 新增文件和文件夹操作 ([#3027](https://github.com/getpaseo/paseo/pull/3027) by [@nikuscs](https://github.com/nikuscs))
- 聊天和 Markdown 预览新增可交互的 Mermaid 图表 ([#2306](https://github.com/getpaseo/paseo/pull/2306) by [@dmeledon](https://github.com/dmeledon))
- 在 Composer 上方和时间线中新增实时任务进度 ([#3227](https://github.com/getpaseo/paseo/pull/3227))
- 新增用于生成工作区标题、分支名、提交和拉取请求草稿的模型设置 ([#3215](https://github.com/getpaseo/paseo/pull/3215))
- 新增受支持的 `@getpaseo/client` TypeScript SDK ([#3141](https://github.com/getpaseo/paseo/pull/3141))
- CLI 新增 Provider 安装诊断 ([#3243](https://github.com/getpaseo/paseo/pull/3243))
- CLI 新增工作区重命名 ([#3209](https://github.com/getpaseo/paseo/pull/3209) by [@martinhanzik](https://github.com/martinhanzik))

### 改进

- Markdown 预览新增居中的阅读布局和格式化的 YAML front matter ([#3240](https://github.com/getpaseo/paseo/pull/3240))
- Command Center 新增侧边栏分组 ([#3063](https://github.com/getpaseo/paseo/pull/3063) by [@cleiter](https://github.com/cleiter))
- 主题快捷键现在包含所有内置主题 ([#3214](https://github.com/getpaseo/paseo/pull/3214))
- 移除了空闲工作区的定期 Git 轮询 ([#3323](https://github.com/getpaseo/paseo/pull/3323))
- Provider 目录刷新设置为可配置的两分钟期限 ([#3322](https://github.com/getpaseo/paseo/pull/3322))

### 修复

- 修复了主机睡眠或 daemon worker 停滞后终端会话丢失的问题 ([#3235](https://github.com/getpaseo/paseo/pull/3235), [#3263](https://github.com/getpaseo/paseo/pull/3263))
- 修复了归档工作区时 daemon 挂起的问题 ([#3107](https://github.com/getpaseo/paseo/pull/3107))
- 修复了项目分布在多台主机上时 Android 上 New Workspace 崩溃的问题 ([#3241](https://github.com/getpaseo/paseo/pull/3241))
- 修复了 Provider 缓存耗尽 Android 本地存储的问题 ([#3234](https://github.com/getpaseo/paseo/pull/3234))
- 修复了连接中断期间语音输入录音丢失的问题 ([#3159](https://github.com/getpaseo/paseo/pull/3159))
- 修复了新工作区复用已有 worktree 的问题 ([#3224](https://github.com/getpaseo/paseo/pull/3224))
- 修复了新 worktree 忽略 Project Settings 中保存的设置命令的问题 ([#3233](https://github.com/getpaseo/paseo/pull/3233))
- 修复了所选基础分支包含不同的 `paseo.json` 时新 worktree 变脏的问题 ([#3311](https://github.com/getpaseo/paseo/pull/3311))
- 修复了已移除的主机仍继续收到推送通知的问题 ([#3176](https://github.com/getpaseo/paseo/pull/3176))
- 修复了权限提示或工作区关闭后委派 Agent 的通知停止的问题 ([#3177](https://github.com/getpaseo/paseo/pull/3177), [#3192](https://github.com/getpaseo/paseo/pull/3192) by [@thomasvan](https://github.com/thomasvan), [@wilgon456](https://github.com/wilgon456))
- 修复了模型目录超过 protocol-v1 帧大小限制时 OMP Agent 无法启动的问题 ([#3184](https://github.com/getpaseo/paseo/pull/3184) by [@pi3123](https://github.com/pi3123))
- 修复了 OpenCode 模型无法回到默认变体的问题 ([#3281](https://github.com/getpaseo/paseo/pull/3281))
- 修复了已完成的 Codex 子 Agent 仍被标记为活动的问题 ([#3188](https://github.com/getpaseo/paseo/pull/3188) by [@Strainy](https://github.com/Strainy))
- 修复了 Codex 压缩后回合仍被标记为工作中的问题 ([#3211](https://github.com/getpaseo/paseo/pull/3211) by [@edihasaj](https://github.com/edihasaj))
- 修复了使用当前 Cursor 登录时的 Cursor 用量 ([#2704](https://github.com/getpaseo/paseo/pull/2704) by [@QuteSaltyFish](https://github.com/QuteSaltyFish))
- 修复了 SVG 项目图标在移动端渲染为空白的问题 ([#2579](https://github.com/getpaseo/paseo/pull/2579) by [@colonelpanic8](https://github.com/colonelpanic8))
- 修复了持久化缓存不兼容时崩溃的问题 ([#3289](https://github.com/getpaseo/paseo/pull/3289))
- 修复了打开的委派 Agent 随其父 Agent 一起被归档的问题 ([#3279](https://github.com/getpaseo/paseo/pull/3279))
- 修复了配置包含所选 Provider 不支持的模式时创建 Agent 的问题 ([#3331](https://github.com/getpaseo/paseo/pull/3331))
- 修复了 Claude Agent 需要等待 Paseo 十分钟 MCP 超时的问题 ([#3315](https://github.com/getpaseo/paseo/pull/3315))
- 修复了 Hermes Agent 的 Copy resume command ([#3300](https://github.com/getpaseo/paseo/pull/3300) by [@desmond-rai](https://github.com/desmond-rai))

## 0.3.1 - 2026-08-09

### 新增

- 可以取消分配键盘快捷键，并在快捷键帮助中查看实际生效的绑定 ([#2510](https://github.com/getpaseo/paseo/pull/2510) by [@cleiter](https://github.com/cleiter), [#2985](https://github.com/getpaseo/paseo/pull/2985) by [@cleiter](https://github.com/cleiter))
- 可以选择 Pure black 主题 ([#3012](https://github.com/getpaseo/paseo/pull/3012) by [@shrimpwtf](https://github.com/shrimpwtf))

### 改进

- 正在运行的 Agent 使用更清晰的动画状态圆环 ([c0daf8e](https://github.com/getpaseo/paseo/commit/c0daf8e066e0d7379723a2a6ddea20afc71ead20) by [@cleiter](https://github.com/cleiter))
- 在文件监视器失败、Git 活动繁重以及大型共享 worktree 仓库中，工作区 Git 更新保持响应 ([#3056](https://github.com/getpaseo/paseo/pull/3056), [#3033](https://github.com/getpaseo/paseo/pull/3033) by [@dwyanewang](https://github.com/dwyanewang), [#3078](https://github.com/getpaseo/paseo/pull/3078))
- Kimi 用量可以正确刷新，并显示五小时限额和推理级别 ([#2743](https://github.com/getpaseo/paseo/pull/2743) by [@UnbrokenHunter](https://github.com/UnbrokenHunter))
- 可以用触摸调整桌面侧边栏的大小 ([#2953](https://github.com/getpaseo/paseo/pull/2953) by [@colonelpanic8](https://github.com/colonelpanic8))

### 修复

- macOS 上的局域网直接连接恢复正常 ([#3071](https://github.com/getpaseo/paseo/pull/3071))
- 桌面端更新检查在各平台下载仍在发布时不再报告错误 ([#3076](https://github.com/getpaseo/paseo/pull/3076))
- 复制的列表跨越选区边界时保留其标记 ([#3055](https://github.com/getpaseo/paseo/pull/3055))
- 切换主机时保持选中当前活动的项目 ([#3051](https://github.com/getpaseo/paseo/pull/3051))
- New Workspace 把项目和隔离控件保持在 Composer 内 ([#3050](https://github.com/getpaseo/paseo/pull/3050))
- 可以从移动端会话菜单重命名会话 ([#2924](https://github.com/getpaseo/paseo/pull/2924) by [@kaspesi](https://github.com/kaspesi))
- 桌面通知声音恢复播放 ([#2582](https://github.com/getpaseo/paseo/pull/2582) by [@gstamp](https://github.com/gstamp))
- Codex 斜杠命令不再包含已禁用的技能 ([#2759](https://github.com/getpaseo/paseo/pull/2759) by [@jasonhnd](https://github.com/jasonhnd))
- 精确的被忽略文件路径可以正确解析 ([#3042](https://github.com/getpaseo/paseo/pull/3042) by [@cleiter](https://github.com/cleiter))
- Claude 问题通知会概括所请求的输入 ([#2925](https://github.com/getpaseo/paseo/pull/2925) by [@SihyeonJeon](https://github.com/SihyeonJeon))
- 崩溃界面保持可读，并且重试操作始终可用 ([#3043](https://github.com/getpaseo/paseo/pull/3043))

## 0.3.0 - 2026-08-08

### 新增

- 全新的移动端终端，支持文本选择、复制、粘贴和更快的渲染 ([#1607](https://github.com/getpaseo/paseo/pull/1607), [#2830](https://github.com/getpaseo/paseo/pull/2830))
- 重新设计的侧边栏，状态颜色更清晰，各行更易于浏览 ([#2340](https://github.com/getpaseo/paseo/pull/2340) by [@kaspesi](https://github.com/kaspesi), [#2335](https://github.com/getpaseo/paseo/pull/2335), [#2416](https://github.com/getpaseo/paseo/pull/2416) by [@nikuscs](https://github.com/nikuscs), [#2711](https://github.com/getpaseo/paseo/pull/2711))
  - 可以选择侧边栏工作区行显示的内容：主机、拉取请求、检查和脚本
  - 可以为每台主机命名并设置颜色 ([#2790](https://github.com/getpaseo/paseo/pull/2790))
- 可以按工作区、Agent 和分支搜索历史记录 ([#2995](https://github.com/getpaseo/paseo/pull/2995))
- 支持韩语界面 ([#2895](https://github.com/getpaseo/paseo/pull/2895) by [@himomohi](https://github.com/himomohi), [@Kesta-bos](https://github.com/Kesta-bos))
- 可以从 Command Center 执行 git 和工作区操作 ([#2749](https://github.com/getpaseo/paseo/pull/2749))
- 可以从 Command Center 更改模型、推理、模式、计划和 fast ([#2274](https://github.com/getpaseo/paseo/pull/2274) by [@kedrzu](https://github.com/kedrzu))
- 可以在 Agent 运行时 fork 它 ([#2638](https://github.com/getpaseo/paseo/pull/2638) by [@kaspesi](https://github.com/kaspesi))
- 可以直接从 New Workspace 启动终端 ([#2941](https://github.com/getpaseo/paseo/pull/2941))
- 可以在聊天中的提示词之间跳转 ([#2792](https://github.com/getpaseo/paseo/pull/2792))
- 可以预览 HTML 文件 ([#2712](https://github.com/getpaseo/paseo/pull/2712) by [@nicholas-salgueiro-britecore](https://github.com/nicholas-salgueiro-britecore), [@nickmaglowsch](https://github.com/nickmaglowsch))
- 可以在子 Agent 栏中查看 Claude workflow ([#2933](https://github.com/getpaseo/paseo/pull/2933))
- 可以选择 Paseo 安装哪些编排技能 ([#2680](https://github.com/getpaseo/paseo/pull/2680))
- 可以用一个设置批准所有 ACP 工具调用 ([#2752](https://github.com/getpaseo/paseo/pull/2752))
- 可以为直接主机连接添加自定义 HTTP 头 ([#2922](https://github.com/getpaseo/paseo/pull/2922))
- 可以选择本地分支或其对应的 origin 分支作为新 worktree 的基础 ([#2328](https://github.com/getpaseo/paseo/pull/2328) by [@mcowger](https://github.com/mcowger))
- 可以在移动端从剪贴板粘贴图片 ([#2793](https://github.com/getpaseo/paseo/pull/2793))

### 改进

- Provider 数据缓存在客户端中，启动更快
- 最近的聊天在后台保持实时，切换回去时立即显示最新消息 ([#2842](https://github.com/getpaseo/paseo/pull/2842))
- 从 Settings 返回工作区更快 ([#2791](https://github.com/getpaseo/paseo/pull/2791))
- 大型仓库中的工作区 Git 状态保持响应 ([#2979](https://github.com/getpaseo/paseo/pull/2979))
- 在繁忙的机器上 Paseo 运行更少的 git 进程 ([#2797](https://github.com/getpaseo/paseo/pull/2797))
- 复制助手回复的一部分时保留其列表、链接和格式 ([#2808](https://github.com/getpaseo/paseo/pull/2808), [#2930](https://github.com/getpaseo/paseo/pull/2930), [#2935](https://github.com/getpaseo/paseo/pull/2935) by [@cleiter](https://github.com/cleiter))
- 可以查看原生 Claude 子 Agent 的完整对话 ([#2498](https://github.com/getpaseo/paseo/pull/2498) by [@ebg1223](https://github.com/ebg1223), [#2760](https://github.com/getpaseo/paseo/pull/2760))
- OpenCode 子 Agent 显示其任务、类型、模型和 token 用量 ([#2909](https://github.com/getpaseo/paseo/pull/2909) by [@BrianAguilarWasco](https://github.com/BrianAguilarWasco))
- Pi 委派的任务显示其生命周期状态 ([#2891](https://github.com/getpaseo/paseo/pull/2891))
- Claude 会为新工作区记住模型和思考选择 ([#2912](https://github.com/getpaseo/paseo/pull/2912))
- OMP 上下文用量在回合进行中更新 ([#2503](https://github.com/getpaseo/paseo/pull/2503) by [@theslava](https://github.com/theslava))
- OpenCode 根据自身的忙碌状态报告后台活动 ([#2696](https://github.com/getpaseo/paseo/pull/2696) by [@desflynn](https://github.com/desflynn))
- 桌面浏览器标签页在焦点变化和自动化过程中保持状态 ([#2907](https://github.com/getpaseo/paseo/pull/2907))
- 新 worktree 从跟踪的上游分支开始 ([#2848](https://github.com/getpaseo/paseo/pull/2848))
- 生成的工作区标题会描述任务 ([#2755](https://github.com/getpaseo/paseo/pull/2755))
- 配对设备时，中继访问需要手动开启 ([#2706](https://github.com/getpaseo/paseo/pull/2706))
- 录音和播放停止时，语音模式会释放音频会话 ([#2866](https://github.com/getpaseo/paseo/pull/2866) by [@kaspesi](https://github.com/kaspesi))
- 工作区建议会跳过被 Git 忽略的数据 ([#2902](https://github.com/getpaseo/paseo/pull/2902))
- 重新连接消息会区分 daemon 重启和网络中断 ([#2931](https://github.com/getpaseo/paseo/pull/2931))
- 文件变化或被删除时，文件查看器显示一个准确的状态 ([#2670](https://github.com/getpaseo/paseo/pull/2670), [#2694](https://github.com/getpaseo/paseo/pull/2694))
- Nix 桌面包更小 ([#2550](https://github.com/getpaseo/paseo/pull/2550) by [@colonelpanic8](https://github.com/colonelpanic8))
- Nix 桌面应用在 Linux 和 macOS 上使用正确的图标 ([#2506](https://github.com/getpaseo/paseo/pull/2506), [#2783](https://github.com/getpaseo/paseo/pull/2783) by [@colonelpanic8](https://github.com/colonelpanic8))
- 可以在 macOS 上通过 Nix flake 构建 Paseo Desktop ([#2556](https://github.com/getpaseo/paseo/pull/2556) by [@colonelpanic8](https://github.com/colonelpanic8))

### 修复

- Pi 0.84 Agent 不再在每条提示词上陷入崩溃循环 ([#2978](https://github.com/getpaseo/paseo/pull/2978) by [@dundunHa](https://github.com/dundunHa))
- 工作区文件监视不再导致 daemon 停滞 ([#2858](https://github.com/getpaseo/paseo/pull/2858))
- 重新连接或恢复后消息不再重复或乱序到达 ([#2789](https://github.com/getpaseo/paseo/pull/2789), [#2718](https://github.com/getpaseo/paseo/pull/2718))
- 在所有桌面操作系统上，Git 状态和 diff 都能识别嵌套文件夹中的变化 ([#2775](https://github.com/getpaseo/paseo/pull/2775))
- Claude 运行时失败会报告错误，而不是让工作区停留在空闲状态 ([#2910](https://github.com/getpaseo/paseo/pull/2910) by [@nickmaglowsch](https://github.com/nickmaglowsch))
- Claude 重放不再留下过时的运行中子 Agent ([#2876](https://github.com/getpaseo/paseo/pull/2876) by [@cleiter](https://github.com/cleiter))
- Claude Opus 5 会显示 Fast 开关 ([#2939](https://github.com/getpaseo/paseo/pull/2939) by [@cleiter](https://github.com/cleiter))
- Provider 进程退出时 Agent 会以错误停止 ([#2757](https://github.com/getpaseo/paseo/pull/2757))
- 取消 OpenCode 回合不再破坏下一个回合 ([#2662](https://github.com/getpaseo/paseo/pull/2662))
- ACP 权限提示不再在回合中途消失 ([#2762](https://github.com/getpaseo/paseo/pull/2762))
- 原生子 Agent 运行时，工作区不再显示为空闲 ([#2777](https://github.com/getpaseo/paseo/pull/2777))
- 回合被中断后终端活动会停止 ([#2942](https://github.com/getpaseo/paseo/pull/2942))
- Windows 终端处理延迟的启动失败时不再崩溃
- 重新创建的工作区文件夹不再被错误地保持为已归档 ([#2987](https://github.com/getpaseo/paseo/pull/2987))
- 恢复已合并的工作区后不再处于非活动状态 ([#2714](https://github.com/getpaseo/paseo/pull/2714))
- 切换工作区不再让聊天滚离你正在阅读的位置 ([#2838](https://github.com/getpaseo/paseo/pull/2838))
- 对话重新加载时图片保持在原位
- 移动端侧边栏中的滑动和拖动手势可以正常使用 ([#2709](https://github.com/getpaseo/paseo/pull/2709))
- 语音输入的提示词在提交时不再消失 ([#2745](https://github.com/getpaseo/paseo/pull/2745))
- Android 上 Composer 保持在键盘上方
- 在移动端使用输入法输入时不再丢失组字文本
- 切换标签页时 Composer 工具栏不再闪烁 ([#2937](https://github.com/getpaseo/paseo/pull/2937))
- 切换主机时保持选中你所选的项目 ([#2700](https://github.com/getpaseo/paseo/pull/2700))
- 主机连接选项在 Settings 和桌面端刷新后保持选中 ([#2905](https://github.com/getpaseo/paseo/pull/2905))
- 切换分支后拉取请求面板会更新 ([#2699](https://github.com/getpaseo/paseo/pull/2699))
- New Workspace 会立即显示其隔离控件 ([#2702](https://github.com/getpaseo/paseo/pull/2702))
- 侧边栏快捷键会退出专注模式 ([#2717](https://github.com/getpaseo/paseo/pull/2717))
- 由 NixOS 服务启动的 Agent 不再以生产模式运行 ([#2697](https://github.com/getpaseo/paseo/pull/2697) by [@shin-sakata](https://github.com/shin-sakata))

## 0.2.5 - 2026-07-30

### 修复

- 修复了 Linux Debian 包 ([#2654](https://github.com/getpaseo/paseo/pull/2654) by [@Neumannzc](https://github.com/Neumannzc))

## 0.2.4 - 2026-07-30

### 新增

- 可以从 CLI 设置 Agent 的思考级别 ([#2533](https://github.com/getpaseo/paseo/pull/2533))
- 创建工作区时可以用 ⌘P / Ctrl+P 切换项目 ([#2110](https://github.com/getpaseo/paseo/pull/2110) by [@turtleDev](https://github.com/turtleDev))
- 可以从侧边栏打开项目或工作区文件夹 ([#2491](https://github.com/getpaseo/paseo/pull/2491) by [@PTK030](https://github.com/PTK030))
- 在聊天上向上轻扫即可收起键盘 ([#2417](https://github.com/getpaseo/paseo/pull/2417) by [@nllptrx](https://github.com/nllptrx))
- 自定义 Provider 可以读取 Agent 的工作目录 ([#2563](https://github.com/getpaseo/paseo/pull/2563))

### 修复

- 在多台机器上添加的同一个仓库在侧边栏中显示为一个项目 ([#2565](https://github.com/getpaseo/paseo/pull/2565))
- 空闲的 Agent 会保留其后台工作，而不是在未使用时关闭 ([#2590](https://github.com/getpaseo/paseo/pull/2590))
- 桌面端在恢复文件树时不再于启动时崩溃 ([#2595](https://github.com/getpaseo/paseo/pull/2595))
- 计划审批只显示最新的提案 ([#2534](https://github.com/getpaseo/paseo/pull/2534))
- Opus 5 在模型列表中只出现一次，并带有完整的 1M 上下文 ([#2497](https://github.com/getpaseo/paseo/pull/2497))
- 上下文计量不再在对话中途变为空白 ([#2494](https://github.com/getpaseo/paseo/pull/2494) by [@theslava](https://github.com/theslava))
- 非常大的工作区 diff 不再导致会话断开 ([#2488](https://github.com/getpaseo/paseo/pull/2488) by [@nikuscs](https://github.com/nikuscs))
- 中断 Pi 不再显示流错误 ([#2311](https://github.com/getpaseo/paseo/pull/2311) by [@mcowger](https://github.com/mcowger))
- Settings 中重新显示 Grok 用量 ([#2353](https://github.com/getpaseo/paseo/pull/2353) by [@jasonhnd](https://github.com/jasonhnd))
- 不报告上下文窗口的 OMP 模型现在可以加载 ([#2406](https://github.com/getpaseo/paseo/pull/2406) by [@astartsky](https://github.com/astartsky))
- Paseo 自己的工具可以直接在 OMP 中使用 ([#2418](https://github.com/getpaseo/paseo/pull/2418) by [@perezd](https://github.com/perezd))
- Codex 可以找到项目中定义的技能 ([#2423](https://github.com/getpaseo/paseo/pull/2423) by [@dwyanewang](https://github.com/dwyanewang))
- 包含 HTML 的拉取请求评论可以正确渲染 ([#2432](https://github.com/getpaseo/paseo/pull/2432) by [@mcowger](https://github.com/mcowger))
- 自托管 forge 链接保留其端口 ([#2478](https://github.com/getpaseo/paseo/pull/2478) by [@muzhi1991](https://github.com/muzhi1991))
- 从桌面打开 Linux AppImage 时可以正常启动 ([#2439](https://github.com/getpaseo/paseo/pull/2439) by [@stonegray](https://github.com/stonegray))
- 仓库搜索可以在较旧版本的 GitHub CLI 上使用 ([#2611](https://github.com/getpaseo/paseo/pull/2611))

## 0.2.3 - 2026-07-27

### 新增

- 可以从 CLI 和 Agent MCP 工具管理工作区脚本 ([#1992](https://github.com/getpaseo/paseo/pull/1992) by [@mcowger](https://github.com/mcowger))
- 可以从终端标签页菜单复制终端 ID ([#2371](https://github.com/getpaseo/paseo/pull/2371))
- 文件编辑器中较长的 Markdown 行默认自动换行 ([#2459](https://github.com/getpaseo/paseo/pull/2459))

### 改进

- 退出时桌面端会停止其管理的 daemon，除非启用了 “Keep daemon running after quit” ([#2454](https://github.com/getpaseo/paseo/pull/2454))
- 远程终端和文件流量在加密连接上占用更少带宽 ([#2480](https://github.com/getpaseo/paseo/pull/2480))
- 工作区搜索现在显示并匹配项目名称 ([#2345](https://github.com/getpaseo/paseo/pull/2345) by [@cleiter](https://github.com/cleiter))
- Claude 用量显示按模型区分的每周限额 ([#2303](https://github.com/getpaseo/paseo/pull/2303) by [@cleiter](https://github.com/cleiter))
- OMP 模型只显示其支持的思考级别 ([#2171](https://github.com/getpaseo/paseo/pull/2171) by [@bendavid](https://github.com/bendavid))

### 修复

- 图片上传保留正确的图片格式 ([#2380](https://github.com/getpaseo/paseo/pull/2380))
- 查看大文件不再导致会话断开 ([#2482](https://github.com/getpaseo/paseo/pull/2482))
- 滚动到聊天顶部时会加载完整的较早历史 ([#2481](https://github.com/getpaseo/paseo/pull/2481))
- 子 Agent 工作期间父 Agent 保持可用 ([#2458](https://github.com/getpaseo/paseo/pull/2458))
- 过时的客户端连接不再耗尽 daemon 内存 ([#2169](https://github.com/getpaseo/paseo/pull/2169))
- 侧边栏分区折叠时固定和取消固定快捷键仍然有效 ([#2299](https://github.com/getpaseo/paseo/pull/2299) by [@cleiter](https://github.com/cleiter))
- `Shift+Tab` 不再更改后台 Agent 的权限模式 ([#1848](https://github.com/getpaseo/paseo/pull/1848) by [@cleiter](https://github.com/cleiter))
- 被代理的服务在重定向中保留端口 ([#2288](https://github.com/getpaseo/paseo/pull/2288) by [@cleiter](https://github.com/cleiter))
- Provider 设置可以在模型选择器上方正确打开 ([#2476](https://github.com/getpaseo/paseo/pull/2476))
- 点击文件编辑器会正确聚焦其窗格 ([#2457](https://github.com/getpaseo/paseo/pull/2457))

## 0.2.2 - 2026-07-25

### 修复

- Claude 5 模型现在使用正确的上下文窗口。

## 0.2.1 - 2026-07-24

### 新增

- 可以使用 Claude Opus 5

## 0.2.0 - 2026-07-24

### 新增

- 可以处理来自 GitLab、Gitea、Forgejo 和 Codeberg 的拉取请求和合并请求 ([#1913](https://github.com/getpaseo/paseo/pull/1913) by [@nllptrx](https://github.com/nllptrx))
- 可以直接在 Web 和桌面应用中编辑文件 ([#2270](https://github.com/getpaseo/paseo/pull/2270), [#2309](https://github.com/getpaseo/paseo/pull/2309), [#2277](https://github.com/getpaseo/paseo/pull/2277), [#2382](https://github.com/getpaseo/paseo/pull/2382) by [@dwyanewang](https://github.com/dwyanewang))
- 新增 Oh My Pi (OMP) 作为原生 Agent Provider ([#2067](https://github.com/getpaseo/paseo/pull/2067) by [@ebg1223](https://github.com/ebg1223))
- 可以把完整的 Changes 视图作为工作区标签页打开 ([#2298](https://github.com/getpaseo/paseo/pull/2298) by [@nikuscs](https://github.com/nikuscs))
- 可以直接从 Files 和 Changes 把文件添加到聊天 ([#2275](https://github.com/getpaseo/paseo/pull/2275) by [@nikuscs](https://github.com/nikuscs))
- 可以在 Changes 中浏览工作区的提交历史并打开单个提交的 diff ([#1534](https://github.com/getpaseo/paseo/pull/1534), [#2146](https://github.com/getpaseo/paseo/pull/2146), [#2312](https://github.com/getpaseo/paseo/pull/2312) by [@adradr](https://github.com/adradr))
- 可以从 Command Center 为活动的 Agent 和新草稿切换模型 ([#2147](https://github.com/getpaseo/paseo/pull/2147) by [@kedrzu](https://github.com/kedrzu))
- 可以从 Paseo 链接或 CLI 打开已有的 Agent ([#2324](https://github.com/getpaseo/paseo/pull/2324))
- 可以用固定范围或外部分配器配置工作区服务端口 ([#2165](https://github.com/getpaseo/paseo/pull/2165) by [@mcowger](https://github.com/mcowger))
- 可以按操作、说明或按键组合搜索键盘快捷键 ([#2160](https://github.com/getpaseo/paseo/pull/2160))
- 可以为支持的 Claude 模型关闭思考 ([#2257](https://github.com/getpaseo/paseo/pull/2257))
- 支持 Pi 的 Max 思考级别 ([#2267](https://github.com/getpaseo/paseo/pull/2267) by [@ByteTrue](https://github.com/ByteTrue))
- 可以在更多已安装的编辑器和文件管理器中打开工作区文件 ([#2119](https://github.com/getpaseo/paseo/pull/2119))
- 可以从 Settings 中移除单个自定义 Provider ([#1951](https://github.com/getpaseo/paseo/pull/1951))

### 改进

- 改进了移动端的模型选择 ([#2361](https://github.com/getpaseo/paseo/pull/2361))
- 选择器弹出框在 iPad 上保持可读 ([#2360](https://github.com/getpaseo/paseo/pull/2360) by [@yzim](https://github.com/yzim))
- 项目、工作区和聊天的同步更高效 ([#2028](https://github.com/getpaseo/paseo/pull/2028), [#2185](https://github.com/getpaseo/paseo/pull/2185), [#2196](https://github.com/getpaseo/paseo/pull/2196), [#2206](https://github.com/getpaseo/paseo/pull/2206), [#2259](https://github.com/getpaseo/paseo/pull/2259), [#2263](https://github.com/getpaseo/paseo/pull/2263))
- CLI 和 MCP 工具管理工作区、Agent 和定时任务的方式更一致 ([#2186](https://github.com/getpaseo/paseo/pull/2186))
- 粘贴到 Composer 中的 PR/MR 链接会被自动选为检出选项 ([#2290](https://github.com/getpaseo/paseo/pull/2290))
- 项目创建过程更加明确 ([#2098](https://github.com/getpaseo/paseo/pull/2098), [#2187](https://github.com/getpaseo/paseo/pull/2187))
- 空闲的 Agent 会自动释放进程，并在需要时恢复 ([#2203](https://github.com/getpaseo/paseo/pull/2203), [#2209](https://github.com/getpaseo/paseo/pull/2209))
- 在支持的情况下，新的 Claude 和 Codex Agent 默认使用更安全的自动审批模式 ([#2213](https://github.com/getpaseo/paseo/pull/2213))
- 回合期间进行的权限和思考更改现在会显示何时生效 ([#2201](https://github.com/getpaseo/paseo/pull/2201))
- 接近 Provider 限额时用量条会发出警告 ([#2322](https://github.com/getpaseo/paseo/pull/2322) by [@cleiter](https://github.com/cleiter))
- 工作区专注模式限定在当前活动的工作区，并带有可见的退出控件 ([#2151](https://github.com/getpaseo/paseo/pull/2151))
- 桌面端安装最新的可用更新，而不是缓存的旧版本 ([#2149](https://github.com/getpaseo/paseo/pull/2149))
- 远程 daemon 更新失败时会显示具体的恢复步骤 ([#2120](https://github.com/getpaseo/paseo/pull/2120))
- Agent 历史错误现在立即显示，而不是在超时之后 ([#2124](https://github.com/getpaseo/paseo/pull/2124))

### 修复

- 终端配对二维码在较窄的终端中仍可扫描 ([#2381](https://github.com/getpaseo/paseo/pull/2381))
- 即使有许多活动或已归档的工作区，创建工作区也保持响应 ([#2355](https://github.com/getpaseo/paseo/pull/2355), [#2379](https://github.com/getpaseo/paseo/pull/2379))
- Agent 启动失败后不再遗留正在运行的 Provider 进程 ([#2348](https://github.com/getpaseo/paseo/pull/2348) by [@dwyanewang](https://github.com/dwyanewang))
- 迟到的元数据更新到达时，已完成的 OpenCode 回合保持空闲 ([#2336](https://github.com/getpaseo/paseo/pull/2336) by [@mcowger](https://github.com/mcowger))
- ACP 图片提示词不再出现两次 ([#2363](https://github.com/getpaseo/paseo/pull/2363))
- 非默认浏览器缩放下，Web 聊天保持固定在最新消息 ([#2368](https://github.com/getpaseo/paseo/pull/2368))
- 分组的工具调用加载动画正确显示 ([#2369](https://github.com/getpaseo/paseo/pull/2369))
- 通知现在会打开正确的工作区和 Agent ([#2331](https://github.com/getpaseo/paseo/pull/2331))
- 可以直接从 History 恢复已归档的 Agent ([#2316](https://github.com/getpaseo/paseo/pull/2316))
- 除非请求新工作区，CLI 运行的 Agent 保持在当前工作区中 ([#2315](https://github.com/getpaseo/paseo/pull/2315))
- 复用的分支不再关联不相关的已合并或已关闭的拉取请求 ([#2172](https://github.com/getpaseo/paseo/pull/2172) by [@nllptrx](https://github.com/nllptrx))
- Pi 压缩会等待较长的摘要，而不是错误地报告超时 ([#2181](https://github.com/getpaseo/paseo/pull/2181) by [@jasonhnd](https://github.com/jasonhnd))
- 空闲 Agent 恢复后，Pi 聊天的新消息与正确的历史对齐 ([#2313](https://github.com/getpaseo/paseo/pull/2313))
- 由已完成的后台工作触发的 OpenCode 后续消息现在保持可见 ([#2258](https://github.com/getpaseo/paseo/pull/2258))
- Codex 不再把父 Agent 显示为幽灵子 Agent ([#2214](https://github.com/getpaseo/paseo/pull/2214))
- Oh My Pi 的后台通知显示为任务通知，而不是原始系统文本 ([#2218](https://github.com/getpaseo/paseo/pull/2218) by [@ebg1223](https://github.com/ebg1223))
- 本地语音输入现在可以在 Nix 打包的安装中使用 ([#1587](https://github.com/getpaseo/paseo/pull/1587) by [@yhori991](https://github.com/yhori991))
- 提交语音输入的文本并返回应用后 Composer 保持可见 ([#2194](https://github.com/getpaseo/paseo/pull/2194))
- 完成录音后桌面端的语音输入快捷键保持响应 ([#2268](https://github.com/getpaseo/paseo/pull/2268))
- 可以在创建第一个工作区之前重命名项目 ([#2252](https://github.com/getpaseo/paseo/pull/2252) by [@albertodeago](https://github.com/albertodeago))
- 本地 daemon 停止时，Settings 仍显示已连接的远程主机 ([#1749](https://github.com/getpaseo/paseo/pull/1749) by [@dwyanewang](https://github.com/dwyanewang))
- 重新打开紧凑侧边栏时已固定的工作区不再短暂消失 ([#2210](https://github.com/getpaseo/paseo/pull/2210))
- 焦点或可见性变化后终端窗格不再停留在 80x24 ([#2059](https://github.com/getpaseo/paseo/pull/2059), [#2154](https://github.com/getpaseo/paseo/pull/2154) by [@cleiter](https://github.com/cleiter))
- 桌面浏览器中的登录弹窗现在可以顺利完成 ([#2137](https://github.com/getpaseo/paseo/pull/2137))
- 在浏览器中输入和使用快捷键不再提交当前的 Paseo 提示词 ([#1982](https://github.com/getpaseo/paseo/pull/1982))
- 切换工作区后 Agent 的浏览器标签页仍可控制 ([#2156](https://github.com/getpaseo/paseo/pull/2156))
- 已归档的工作区现在显示正确的 Unarchive 或 Restore 操作 ([#2002](https://github.com/getpaseo/paseo/pull/2002))
- 可以把已归档的会话重新导入当前工作区 ([#2123](https://github.com/getpaseo/paseo/pull/2123), [#2265](https://github.com/getpaseo/paseo/pull/2265) by [@nikuscs](https://github.com/nikuscs))
- 浏览器快捷键不再出现在没有浏览器标签页的地方 ([#2116](https://github.com/getpaseo/paseo/pull/2116) by [@jasonhnd](https://github.com/jasonhnd))

## 0.1.110 - 2026-07-16

### 修复

- 响应正在流式输出时，Kimi 和其他 ACP Agent 现在保持标记为运行中 ([#2148](https://github.com/getpaseo/paseo/pull/2148))

## 0.1.109 - 2026-07-16

> **重要更新通知**
>
> 如果你安装的是 Paseo Desktop 0.1.108，需要[手动下载并重新安装 Paseo](https://paseo.sh/download) 才能获得此修复。0.1.108 中的缺陷导致其自动更新程序无法安装 0.1.109。使用 0.1.107 或更早版本的用户可以正常更新。

### 修复

- Paseo Desktop 更新后不再卡在连接中或丢失原生窗口控件 ([#2111](https://github.com/getpaseo/paseo/pull/2111) by [@cleiter](https://github.com/cleiter))

## 0.1.108 - 2026-07-16

### 新增

- 可以从 Add Project 创建新的项目文件夹或克隆 GitHub 仓库 ([#1331](https://github.com/getpaseo/paseo/pull/1331), [#2045](https://github.com/getpaseo/paseo/pull/2045), [#2097](https://github.com/getpaseo/paseo/pull/2097) by [@mcowger](https://github.com/mcowger))
- 可以从搜索菜单搜索并打开工作区 ([#2096](https://github.com/getpaseo/paseo/pull/2096))
- 可以把工作区固定在侧边栏顶部 ([#1981](https://github.com/getpaseo/paseo/pull/1981) by [@half144](https://github.com/half144))
- 通过新的外观设置，可以把工具调用汇总为一个折叠的条目 ([#2031](https://github.com/getpaseo/paseo/pull/2031), [#2069](https://github.com/getpaseo/paseo/pull/2069), [#2090](https://github.com/getpaseo/paseo/pull/2090) by [@mcowger](https://github.com/mcowger))
- 浏览器 Cookie 和网站数据在标签页之间以及重启后保留 ([#2089](https://github.com/getpaseo/paseo/pull/2089))
- Claude 和 Codex 子 Agent 现在显示其实际名称，并新增归档已完成的 Claude Code、Codex 和 OpenCode 子 Agent 的选项 ([#2073](https://github.com/getpaseo/paseo/pull/2073))
- 可以从失败的回合 fork 聊天 ([#2063](https://github.com/getpaseo/paseo/pull/2063))

### 改进

- 权限模式的图标更清晰 ([#1980](https://github.com/getpaseo/paseo/pull/1980) by [@cleiter](https://github.com/cleiter))
- 桌面端在较窄的窗口中仍可使用 ([#1983](https://github.com/getpaseo/paseo/pull/1983))
- 桌面面板打开和关闭时侧边栏控件保持在原位 ([#2078](https://github.com/getpaseo/paseo/pull/2078))
- 在长草稿中输入更流畅 ([#2086](https://github.com/getpaseo/paseo/pull/2086))
- Codex 终端命令即使没有输出也始终显示在聊天中 ([#2037](https://github.com/getpaseo/paseo/pull/2037))

### 修复

- 切换项目或主机时，New Workspace 保留你的提示词和附件 ([#2030](https://github.com/getpaseo/paseo/pull/2030), [#2036](https://github.com/getpaseo/paseo/pull/2036))
- OpenCode 会话关闭时不再导致 Paseo 崩溃 ([#2027](https://github.com/getpaseo/paseo/pull/2027) by [@mcowger](https://github.com/mcowger))
- Pi 斜杠命令不再让聊天卡在运行中 ([#2066](https://github.com/getpaseo/paseo/pull/2066) by [@ebg1223](https://github.com/ebg1223))
- 后台 Agent 的更新现在显示在主回复之后 ([#2058](https://github.com/getpaseo/paseo/pull/2058) by [@1254087415](https://github.com/1254087415))
- Codex 子 Agent 不再从 Subagents 栏中消失 ([#2068](https://github.com/getpaseo/paseo/pull/2068))
- fork 的聊天在新标签页中打开后即可编辑 ([#2038](https://github.com/getpaseo/paseo/pull/2038))
- 关机被中断后 Paseo Desktop 可以正常打开 ([#1962](https://github.com/getpaseo/paseo/pull/1962))
- 键盘快捷键现在可以使用 `-`、`=`、`;` 和 `'` ([#2047](https://github.com/getpaseo/paseo/pull/2047) by [@OnCloud125252](https://github.com/OnCloud125252))
- Codebuddy Code 模型现在出现在模型选择器中 ([#1979](https://github.com/getpaseo/paseo/pull/1979) by [@park0er](https://github.com/park0er))
- 工作区搜索现在包含 OpenCode 命令和 workflow ([#2049](https://github.com/getpaseo/paseo/pull/2049))
- Nix 安装现在包含 Paseo Web 应用 ([#1978](https://github.com/getpaseo/paseo/pull/1978) by [@liamdiprose](https://github.com/liamdiprose))

## 0.1.107 - 2026-07-13

### 新增

- 可以在 Subagents 栏中查看由 Provider 创建的子 Agent 及其实时对话 ([#2013](https://github.com/getpaseo/paseo/pull/2013) by [@omercnet](https://github.com/omercnet))
- 所有受支持的 Agent Provider 都可以 fork 聊天 ([#2022](https://github.com/getpaseo/paseo/pull/2022))

### 改进

- 没有配置项目时，可以直接从 New Workspace 添加项目 ([#2026](https://github.com/getpaseo/paseo/pull/2026))
- 新终端会立即以正确的尺寸打开 ([#2023](https://github.com/getpaseo/paseo/pull/2023) by [@cleiter](https://github.com/cleiter))
- 侧边栏底部操作现在带有提示文字 ([#2025](https://github.com/getpaseo/paseo/pull/2025))
- Codex shell 工具调用只显示正在运行的命令 ([#2029](https://github.com/getpaseo/paseo/pull/2029))
- 自定义 ACP Provider 默认把文件和终端工作保留在 Agent 环境中 ([#2024](https://github.com/getpaseo/paseo/pull/2024))
- ACP Provider 目录更新到最新的注册表版本

### 修复

- 大型表格不再导致 iOS 聊天失去响应
- 滚动到底部按钮附近的聊天控件仍可点击 ([#2007](https://github.com/getpaseo/paseo/pull/2007))
- 超大的工具输出不再拖慢或淹没聊天时间线 ([#2020](https://github.com/getpaseo/paseo/pull/2020))
- 跨 Provider 的子 Agent 可以使用没有模式设置的 Provider ([#2000](https://github.com/getpaseo/paseo/pull/2000) by [@githubbzxs](https://github.com/githubbzxs))
- Pi 内部的元数据任务不再干扰正常的会话历史 ([#1999](https://github.com/getpaseo/paseo/pull/1999) by [@githubbzxs](https://github.com/githubbzxs))
- 取消扩展命令后 Pi 聊天仍可使用 ([#2019](https://github.com/getpaseo/paseo/pull/2019))

## 0.1.106 - 2026-07-12

### 新增

- 可以在 Paseo 中批准 Codex MCP 权限请求 ([#2001](https://github.com/getpaseo/paseo/pull/2001))

### 改进

- ACP Provider 目录更新到最新的注册表版本

### 修复

- 减少了 Agent 流式输出时切换工作区导致的移动端聊天冻结和白屏 ([#1989](https://github.com/getpaseo/paseo/pull/1989))
- OpenCode 会话可以可靠地启动，不再偶尔丢失第一个回合 ([#2015](https://github.com/getpaseo/paseo/pull/2015) by [@mcowger](https://github.com/mcowger))
- 在工作区之间切换不再闪白屏
- Paseo 添加自己的 MCP 工具时，Pi 保留你已有的 MCP 工具和设置 ([#1990](https://github.com/getpaseo/paseo/pull/1990) by [@mcowger](https://github.com/mcowger))

## 0.1.105 - 2026-07-10

### 新增

- 可以以可折叠的文件夹树或平铺列表浏览已更改的文件 ([#1918](https://github.com/getpaseo/paseo/pull/1918), [#1945](https://github.com/getpaseo/paseo/pull/1945) by [@cleiter](https://github.com/cleiter))
- 通过新的外观设置，可以始终展开 Agent 的推理 ([#1943](https://github.com/getpaseo/paseo/pull/1943) by [@mcowger](https://github.com/mcowger))

### 改进

- 项目选择器支持模糊搜索文件夹和桌面端原生浏览 ([#1968](https://github.com/getpaseo/paseo/pull/1968))
- 大型工作区侧边栏保持响应 ([#1966](https://github.com/getpaseo/paseo/pull/1966))
- 生成的工作区名称和 Git 文本可以使用 MiniMax M3 ([#1955](https://github.com/getpaseo/paseo/pull/1955) by [@octo-patch](https://github.com/octo-patch))
- Cursor 现在提供思考和 fast 模式 ([#1952](https://github.com/getpaseo/paseo/pull/1952))

### 修复

- 子 Agent 运行期间 Codex 保持活动并正确地流式输出 ([#1967](https://github.com/getpaseo/paseo/pull/1967))
- Android 音频中断不再导致语音模式崩溃或语音输入卡住 ([#1941](https://github.com/getpaseo/paseo/pull/1941))
- 移动端侧边栏保持同步，并保留滑动打开手势 ([#1953](https://github.com/getpaseo/paseo/pull/1953), [#1976](https://github.com/getpaseo/paseo/pull/1976))
- Pi 的纯文本模型可以接受图片提示词而不会破坏会话 ([#1960](https://github.com/getpaseo/paseo/pull/1960))
- 应用渲染失败时显示可重试的恢复界面，而不是白屏 ([#1924](https://github.com/getpaseo/paseo/pull/1924))
- 使用较旧版本的 Oh My Pi 时 Pi 上下文用量仍然可见 ([#1886](https://github.com/getpaseo/paseo/pull/1886) by [@theslava](https://github.com/theslava))
- 快速打开和关闭 Provider 用量弹出框不再报错 ([#1885](https://github.com/getpaseo/paseo/pull/1885) by [@theslava](https://github.com/theslava))
- 移动端工作区菜单隐藏仅适用于桌面端的快捷键标记 ([#1964](https://github.com/getpaseo/paseo/pull/1964))

## 0.1.104 - 2026-07-08

### 新增

- Agent 可以通过页面快照、受信任的输入、对话框和标签页控制来驱动应用内浏览器 ([#1881](https://github.com/getpaseo/paseo/pull/1881))
- 可以从浏览器标签页检查、标注页面元素并将其发送给 Agent ([#1708](https://github.com/getpaseo/paseo/pull/1708) by [@huiliaoning](https://github.com/huiliaoning))
- 新增 Schedules 界面，用于创建和管理周期性运行的 Agent ([#1246](https://github.com/getpaseo/paseo/pull/1246))
- 可以在任何地方用 Cmd+O 打开项目 ([#1849](https://github.com/getpaseo/paseo/pull/1849))
- Agent 在理解任务之后可以重命名工作区 ([#1876](https://github.com/getpaseo/paseo/pull/1876))
- 支持的 Claude 模型可以使用 Claude Ultra Code ([#1872](https://github.com/getpaseo/paseo/pull/1872))
- 新增字节跳动 TRAE CLI 作为 Agent Provider ([#1831](https://github.com/getpaseo/paseo/pull/1831), [#1896](https://github.com/getpaseo/paseo/pull/1896) by [@park0er](https://github.com/park0er))

### 改进

- 可以在桌面端设置中的同一个位置管理内置 daemon ([#1938](https://github.com/getpaseo/paseo/pull/1938))
- 定时运行和循环运行在侧边栏中各自拥有独立的工作区 ([#1909](https://github.com/getpaseo/paseo/pull/1909), [#1934](https://github.com/getpaseo/paseo/pull/1934))
- 应用中大量 Provider 和模型的刷新加载更快 ([#1895](https://github.com/getpaseo/paseo/pull/1895))
- Agent 创建的工作区现在会得到可读的生成名称 ([#1887](https://github.com/getpaseo/paseo/pull/1887))
- Agent 打开的浏览器标签页会保持在后台，直到你切换过去 ([#1875](https://github.com/getpaseo/paseo/pull/1875))
- Agent 提问时的卡片更清晰 ([#1643](https://github.com/getpaseo/paseo/pull/1643) by [@cleiter](https://github.com/cleiter))
- 诊断报告包含桌面应用日志 ([#1914](https://github.com/getpaseo/paseo/pull/1914))
- Paseo 的内置工具占用更少的上下文 ([#1939](https://github.com/getpaseo/paseo/pull/1939))

### 修复

- 重命名的主机在重新连接后保留其名称 ([#1940](https://github.com/getpaseo/paseo/pull/1940))
- 即使 shell 启动较慢，桌面端也能找到你已安装的 CLI ([#1916](https://github.com/getpaseo/paseo/pull/1916))
- 从桌面端设置重启 daemon 可以可靠地工作 ([#1915](https://github.com/getpaseo/paseo/pull/1915))
- 从内置的 CLI 重启 daemon 后，它仍由桌面应用管理 ([#1919](https://github.com/getpaseo/paseo/pull/1919))
- 从内置的 CLI 启动 daemon 时 Web UI 可以加载 ([#1899](https://github.com/getpaseo/paseo/pull/1899) by [@yzim](https://github.com/yzim))
- Worktree 设置脚本保留你的 PATH ([#1908](https://github.com/getpaseo/paseo/pull/1908))
- Docker 镜像在 Provider 清理和诊断期间保持运行 ([#1877](https://github.com/getpaseo/paseo/pull/1877))
- 归档工作区后 New Workspace 草稿得以保留 ([#1838](https://github.com/getpaseo/paseo/pull/1838))
- 切换界面后 Composer 自动补全保持打开 ([#1851](https://github.com/getpaseo/paseo/pull/1851))
- 配额窗口没有计划的重置时间时也会显示 Claude 用量 ([#1855](https://github.com/getpaseo/paseo/pull/1855))
- 侧边栏中的非 git 项目会显示 New workspace 操作 ([#1857](https://github.com/getpaseo/paseo/pull/1857) by [@cleiter](https://github.com/cleiter))

## 0.1.103 - 2026-07-01

### 新增

- Claude 模型选择器中可以使用 Claude Sonnet 5 ([#1850](https://github.com/getpaseo/paseo/pull/1850))

## 0.1.102 - 2026-06-30

### 新增

- 可以把聊天 fork 到新标签页或新 worktree ([#1788](https://github.com/getpaseo/paseo/pull/1788))
- 可以查看所有已连接主机上的工作区 ([#1538](https://github.com/getpaseo/paseo/pull/1538), [#1775](https://github.com/getpaseo/paseo/pull/1775), [#1825](https://github.com/getpaseo/paseo/pull/1825))
- daemon 现在可以提供 Web UI ([#1635](https://github.com/getpaseo/paseo/pull/1635), [#1739](https://github.com/getpaseo/paseo/pull/1739))
- 可以使用官方 Docker 镜像运行 Paseo ([#1740](https://github.com/getpaseo/paseo/pull/1740) by [@Herbrant](https://github.com/Herbrant))
- 可以从应用远程更新 daemon ([#1513](https://github.com/getpaseo/paseo/pull/1513) by [@thedavidweng](https://github.com/thedavidweng))
- 可以为语音转文字和文字转语音分别配置 OpenAI 端点 ([#1823](https://github.com/getpaseo/paseo/pull/1823))
- 可以把文件拖放到任何 Composer 中 ([#1750](https://github.com/getpaseo/paseo/pull/1750), [#1801](https://github.com/getpaseo/paseo/pull/1801))
- 配额视图中显示 MiniMax 用量 ([#1662](https://github.com/getpaseo/paseo/pull/1662) by [@ilteoood](https://github.com/ilteoood))
- 新增 C# 代码块高亮 ([#1651](https://github.com/getpaseo/paseo/pull/1651) by [@dev693](https://github.com/dev693))

### 改进

- 可以在任何地方打开 New Workspace ([#1746](https://github.com/getpaseo/paseo/pull/1746), [#1806](https://github.com/getpaseo/paseo/pull/1806))
- 项目搜索显示加载进度 ([#1762](https://github.com/getpaseo/paseo/pull/1762))
- 桌面端更新检查显示更清晰的状态 ([#1808](https://github.com/getpaseo/paseo/pull/1808), [#1815](https://github.com/getpaseo/paseo/pull/1815))
- 较慢的远程主机不再那么容易超时 ([#1789](https://github.com/getpaseo/paseo/pull/1789))
- Pi 会等待更长时间以获取扩展结果 ([#1732](https://github.com/getpaseo/paseo/pull/1732) by [@theslava](https://github.com/theslava))
- 重新访问已打开的文件标签页时会刷新 ([#1699](https://github.com/getpaseo/paseo/pull/1699) by [@cleiter](https://github.com/cleiter))
- Web 终端滚动更流畅 ([#1622](https://github.com/getpaseo/paseo/pull/1622) by [@TommyLike](https://github.com/TommyLike))

### 修复

- 新添加的项目无需重启即可编辑 ([#1761](https://github.com/getpaseo/paseo/pull/1761) by [@huiliaoning](https://github.com/huiliaoning))
- 大型仓库打开更可靠 ([#1620](https://github.com/getpaseo/paseo/pull/1620) by [@jms830](https://github.com/jms830))
- 移动端启动时恢复已保存的工作区 ([#1777](https://github.com/getpaseo/paseo/pull/1777))
- Agent 提示词不再重命名工作区 ([#1779](https://github.com/getpaseo/paseo/pull/1779))
- 延迟到达的历史不再让聊天移动位置 ([#1776](https://github.com/getpaseo/paseo/pull/1776))
- 流式输出的聊天图片保持顺序 ([#1805](https://github.com/getpaseo/paseo/pull/1805))
- 聊天操作保持在工具输出下方 ([#1827](https://github.com/getpaseo/paseo/pull/1827))
- Claude 子 Agent 的旁白不再出现在聊天中 ([#1807](https://github.com/getpaseo/paseo/pull/1807))
- Kiro 的斜杠命令和技能出现在 Paseo 中 ([#1792](https://github.com/getpaseo/paseo/pull/1792) by [@park0er](https://github.com/park0er))
- 存在过时的项目记录时 Agent 列表仍可正常显示 ([#1812](https://github.com/getpaseo/paseo/pull/1812))
- Windows 图片预览可以处理带盘符的路径 ([#1811](https://github.com/getpaseo/paseo/pull/1811))
- OpenCode 在 Windows 上可以正常关闭 ([#1771](https://github.com/getpaseo/paseo/pull/1771) by [@agamotto](https://github.com/agamotto))
- 桌面端上传的文件保留其扩展名 ([#1741](https://github.com/getpaseo/paseo/pull/1741))
- Claude Code 清理时会终止子进程 ([#1540](https://github.com/getpaseo/paseo/pull/1540) by [@TommyLike](https://github.com/TommyLike))
- OpenCode 不再索引你的主目录 ([#1704](https://github.com/getpaseo/paseo/pull/1704) by [@rex-chang](https://github.com/rex-chang))
- 打包的 macOS CLI daemon 不再显示额外的 Dock 图标 ([#1759](https://github.com/getpaseo/paseo/pull/1759) by [@yzim](https://github.com/yzim))
- `paseo daemon status` 无需加载 Agent 即可工作 ([#1810](https://github.com/getpaseo/paseo/pull/1810))
- PR worktree 正确显示已推送状态 ([#1804](https://github.com/getpaseo/paseo/pull/1804))

## 0.1.101 - 2026-06-26

### 新增

- 当支持人员需要主机、daemon、Provider 和日志详情时，可以从 Settings 复制故障排查报告 ([#1728](https://github.com/getpaseo/paseo/pull/1728))
- Claude 图片工具结果现在在聊天中渲染为图片 ([#1717](https://github.com/getpaseo/paseo/pull/1717))
- 新增日语 ([#1694](https://github.com/getpaseo/paseo/pull/1694) by [@sysCat64](https://github.com/sysCat64))
- 新增巴西葡萄牙语 ([#1653](https://github.com/getpaseo/paseo/pull/1653) by [@Alcimerio](https://github.com/Alcimerio))

### 改进

- 即使模型发现较慢，Provider 诊断仍然有用 ([#1724](https://github.com/getpaseo/paseo/pull/1724))
- 较慢的 Provider 请求不再让应用看起来像已断开 ([#1723](https://github.com/getpaseo/paseo/pull/1723))
- 关联到名称不同的跟踪分支的 worktree 可以正确找到其 PR ([#1718](https://github.com/getpaseo/paseo/pull/1718))
- 由斜杠命令提示词启动的工作区会得到更清晰的名称 ([#1709](https://github.com/getpaseo/paseo/pull/1709))
- ACP Provider 目录更新到最新的注册表版本

### 修复

- Pi 在加载新 Agent 选项时不再创建空会话 ([#1727](https://github.com/getpaseo/paseo/pull/1727))
- Windows 上的 daemon 状态能更可靠地找到 daemon 进程 ([#1725](https://github.com/getpaseo/paseo/pull/1725))
- OpenAI 语音凭据不再影响其他基于 OpenAI 的工具
- Provider 模型列表在刷新期间不再消失

## 0.1.100 - 2026-06-24

### 新增

- 可以用 Shift+Tab 循环切换 Agent 模式
- 启动时或会话中可以选择自定义的 Copilot Agent ([#1700](https://github.com/getpaseo/paseo/pull/1700))

### 改进

- ACP Provider 目录更新到最新的注册表版本

### 修复

- Claude 不再在每条消息之后发送额外的 API 请求 ([#1701](https://github.com/getpaseo/paseo/pull/1701))
- 会话结束后 OpenCode 不再遗留在后台运行的服务器 ([#1697](https://github.com/getpaseo/paseo/pull/1697))
- 斜杠命令和技能现在可以在 OMP Agent 中加载 ([#1698](https://github.com/getpaseo/paseo/pull/1698))

## 0.1.99 - 2026-06-23

### 改进

- PR 面板现在有刷新按钮和更清晰的加载状态 ([#1664](https://github.com/getpaseo/paseo/pull/1664))
- Provider 诊断和模型列表现在保持同步 ([#1660](https://github.com/getpaseo/paseo/pull/1660))

### 修复

- Grok 等 ACP Provider 不再显示重复的用户消息
- 已保存的 Composer 模式在 Provider 数据加载期间不再被重置 ([#1658](https://github.com/getpaseo/paseo/pull/1658))
- 右侧边栏在移动端不再卡住 ([#1661](https://github.com/getpaseo/paseo/pull/1661))

## 0.1.98 - 2026-06-21

### 新增

- 可以在应用内查看 Claude、Codex、Copilot、Cursor、Z.AI、Grok 和 Kimi 的套餐用量 ([#1278](https://github.com/getpaseo/paseo/pull/1278) by [@ABorakati](https://github.com/ABorakati))
- 为 Claude 新增 Ultracode ([#1625](https://github.com/getpaseo/paseo/pull/1625))
- 可以分离子 Agent 让它独立运行 ([#1612](https://github.com/getpaseo/paseo/pull/1612))
- 可以添加项目而不创建工作区
- 新增在侧边栏中显示分支名而不是标题的设置

### 改进

- 回合中途的思考和模式更改现在会说明它们在下一个回合生效
- PR 合并选项会注明其方式：squash、merge 或 rebase ([#1608](https://github.com/getpaseo/paseo/pull/1608) by [@mcowger](https://github.com/mcowger))
- 正在运行的 Agent 的模式更改会被新 Agent 记住
- 可以一键复制 Provider 的启动诊断 ([#1611](https://github.com/getpaseo/paseo/pull/1611))

### 修复

- OpenCode 在 macOS 桌面端不再扫描整个磁盘 ([#1626](https://github.com/getpaseo/paseo/pull/1626))
- OpenAI 语音没有 API 密钥时 daemon 不再崩溃 ([#1368](https://github.com/getpaseo/paseo/pull/1368) by [@mcowger](https://github.com/mcowger))
- 重新打开已归档的 Codex Agent 不再挂起
- Claude 的上下文计量不再跳到子 Agent 的用量
- 在新会话中，Claude 的上下文计量从第一条消息开始填充
- OpenCode 的模式选择器现在会遵循你禁用的模式 ([#1366](https://github.com/getpaseo/paseo/pull/1366) by [@mcowger](https://github.com/mcowger))
- 文件链接和 @ 提及可以找到点开头的文件夹和深层路径中的文件 ([#1609](https://github.com/getpaseo/paseo/pull/1609))
- 归档项目的最后一个工作区不再让项目消失 ([#1631](https://github.com/getpaseo/paseo/pull/1631))
- 折叠的侧边栏项目保持折叠

## 0.1.97 - 2026-06-18

### 新增

- **简化的工作区模型** — 无需 worktree 即可在同一份代码上运行多个工作区，每个工作区都有自己的 Agent、终端和状态 ([#1539](https://github.com/getpaseo/paseo/pull/1539))
- **从 History 重新打开已归档的工作区** — 即使 worktree 已被移除，也能恢复过去的工作区
- **终端会显示其 Agent 是在工作、空闲还是等待输入** ([#1507](https://github.com/getpaseo/paseo/pull/1507))
- **在移动端为 Agent 附加文件** ([#1501](https://github.com/getpaseo/paseo/pull/1501))
- **在文件浏览器中隐藏点文件** ([#1516](https://github.com/getpaseo/paseo/pull/1516) by [@yuruiz](https://github.com/yuruiz))
- **把终端、浏览器和新标签页按钮固定到标签栏和侧边栏**
- **用键盘快捷键创建新工作区**

### 改进

- 工作区标题来自你的第一条提示词，并且更短 ([#1563](https://github.com/getpaseo/paseo/pull/1563))
- 可以从工作区的悬停卡片复制其分支或路径
- 大量输出时终端保持流畅 ([#1500](https://github.com/getpaseo/paseo/pull/1500))
- 最后一个工作区被归档时会移除 worktree ([#1562](https://github.com/getpaseo/paseo/pull/1562))
- 完成通知包含子 Agent 的结果 ([#1558](https://github.com/getpaseo/paseo/pull/1558))
- Cursor 只列出你可以选择的模型 ([#1556](https://github.com/getpaseo/paseo/pull/1556))
- ACP Provider 目录更新到最新的注册表版本

### 修复

- daemon 的短暂变慢不再导致连接断开
- Linux AppImage 更新不再在退出时挂起或删除应用 ([#1485](https://github.com/getpaseo/paseo/pull/1485) by [@xpufx](https://github.com/xpufx))
- 在 Android 上打开 Providers 设置不再崩溃 ([#1537](https://github.com/getpaseo/paseo/pull/1537))
- 编码 Agent 的终端快捷键在 Windows 上可以使用 ([#1509](https://github.com/getpaseo/paseo/pull/1509))
- 可以再次导入 ACP 和 Kimi 会话 ([#1510](https://github.com/getpaseo/paseo/pull/1510) by [@wbxl2000](https://github.com/wbxl2000))
- ACP Agent 关闭时不再遗留孤立进程 ([#1460](https://github.com/getpaseo/paseo/pull/1460) by [@yeshan333](https://github.com/yeshan333))
- 导入会话的预览显示干净的提示词 ([#1502](https://github.com/getpaseo/paseo/pull/1502))
- 本地配对邀请使用正确的应用 URL ([#1187](https://github.com/getpaseo/paseo/pull/1187) by [@aibaiiqpl](https://github.com/aibaiiqpl))
- 应用不再因为反复重新探测 Provider 而冻结
- 从侧边栏移除项目现在会移除项目本身，而不是把它遗留下来
- 工作区快捷键数字不再显示在错误的按键上 ([#1580](https://github.com/getpaseo/paseo/pull/1580) by [@cleiter](https://github.com/cleiter))
- 消息包含不成对的反引号时聊天不再挂起 ([#1585](https://github.com/getpaseo/paseo/pull/1585) by [@thaning0](https://github.com/thaning0))

## 0.1.96 - 2026-06-13

_此版本只修复了一个 Android 问题，桌面端用户无需更新。_

### 修复

- 在 Android 上打开聊天后，侧边栏不再重新出现并卡住

## 0.1.95 - 2026-06-13

### 新增

- **在桌面端为 Agent 附加任意文件** ([#1474](https://github.com/getpaseo/paseo/pull/1474))

### 改进

- 分支领先时，git 推送按钮显示在合并操作之前 ([#1488](https://github.com/getpaseo/paseo/pull/1488))
- SVG 附件会上传到磁盘
- 切换工作区更流畅

### 修复

- 修复了可能显示过时 GitHub 数据的情况 ([#1491](https://github.com/getpaseo/paseo/pull/1491))
- PR 评论和审查讨论中上传的图片现在可以在 PR 面板中加载 ([#1486](https://github.com/getpaseo/paseo/pull/1486))
- 打开文件夹缺失的项目时显示清晰的错误 ([#1490](https://github.com/getpaseo/paseo/pull/1490))
- 新工作区标题会避开键盘 ([#1489](https://github.com/getpaseo/paseo/pull/1489))
- Android 上侧边栏不再自行打开

## 0.1.94 - 2026-06-12

### 新增

- **从 PR 面板把拉取请求的评论、审查、讨论和失败检查的日志附加到聊天** ([#1400](https://github.com/getpaseo/paseo/pull/1400))
- **支持阿拉伯语、中文、英语、法语、俄语和西班牙语界面** ([#1282](https://github.com/getpaseo/paseo/pull/1282), [#1478](https://github.com/getpaseo/paseo/pull/1478) by [@chyendongnhanh338](https://github.com/chyendongnhanh338), [@dwyanewang](https://github.com/dwyanewang))
- **从 Host 设置创建可复用的终端配置**
- **在 Antigravity 中打开工作区** ([#1424](https://github.com/getpaseo/paseo/pull/1424) by [@krumpyzoid](https://github.com/krumpyzoid))

### 改进

- 输入时 Claude 技能会出现在提示词自动补全中 ([#1464](https://github.com/getpaseo/paseo/pull/1464))
- 可以直接从文件预览标签页菜单复制文件路径 ([#1473](https://github.com/getpaseo/paseo/pull/1473))
- Agent 合并分支后 PR 状态保持最新 ([#1455](https://github.com/getpaseo/paseo/pull/1455))
- 只保留当前活动工作区的界面，使工作区标签页保持快速 ([#1472](https://github.com/getpaseo/paseo/pull/1472))

### 修复

- Composer 的发送快捷键不再与其他键盘快捷键冲突
- 多问题提示每次推进一个答案 ([#1462](https://github.com/getpaseo/paseo/pull/1462))
- 导入的 Pi 会话保留其原来的模型和思考设置 ([#1441](https://github.com/getpaseo/paseo/pull/1441) by [@thomasaull](https://github.com/thomasaull))
- 重新连接桌面主机时保留已保存的 shell 和工作区路由
- Worktree 终端不再出现在父工作区中
- 移动端重新连接时正确显示欢迎界面

## 0.1.93 - 2026-06-10

### 新增

- **Claude 模型选择器中可以使用 Claude Fable 5** ([#1443](https://github.com/getpaseo/paseo/pull/1443) by [@0-Captain](https://github.com/0-Captain))

## 0.1.92 - 2026-06-10

### 新增

- **提示词中的技能自动补全**

### 改进

- Provider 目录内嵌在 Host 设置中 ([#1423](https://github.com/getpaseo/paseo/pull/1423))
- 手动检查更新会跳过分阶段发布的延迟
- Provider 目录中 CodeWhale 取代了 DeepSeek TUI
- 更新了 ACP Provider 目录中 Cline、Codebuddy Code、DimCode、Factory Droid、Gemini、Nova 和 Qoder 的条目
- OMP 有了自己的图标和网站页面
- 模型选择器的描述更清晰
- ACP Provider 错误会显示 Provider 实际的失败消息

### 修复

- 新的 Paseo worktree 分支可以推送其第一批提交
- 导入的会话不再打开为空白或打开到错误的工作区
- Windows 资源管理器打开所选的工作区而不是 Documents ([#1412](https://github.com/getpaseo/paseo/pull/1412) by [@bjspi](https://github.com/bjspi))
- 以命令 shim 方式安装的 Windows 编辑器快捷方式可以正确启动 ([#1387](https://github.com/getpaseo/paseo/pull/1387) by [@Peter7896](https://github.com/Peter7896))
- 无法使用 MCP 服务器的 ACP Provider 可以正确启动
- 已移除的主机不再让主机页面卡在连接中
- 文件预览中的链接在外部浏览器中打开
- 输出流式显示时聊天保持固定在最新消息
- 输入时移动端 Composer 的发送按钮不再移动

## 0.1.91 - 2026-06-08

### 新增

- **打开多个桌面窗口** ([#1355](https://github.com/getpaseo/paseo/pull/1355) by [@arieel-ost](https://github.com/arieel-ost))
- **在工作区标签页中打开浏览器弹窗和链接** ([#1375](https://github.com/getpaseo/paseo/pull/1375))
- **在移动端使用 Command Center**
- **新增 OMP Provider** ([#1388](https://github.com/getpaseo/paseo/pull/1388))

### 改进

- 新工作区会记住你上次选择的 Provider、模式和思考设置
- Git 控件现在对已就绪的分支默认提供拉取请求，并隐藏不可用的拉取或推送操作
- 桌面端管理的主机在 daemon 状态过时后恢复更可靠
- daemon 状态现在会解释认证失败的原因
- 项目搜索会跳过 Python 虚拟环境 ([#1356](https://github.com/getpaseo/paseo/pull/1356))
- 配置文件可以包含 `$schema` 以获得编辑器帮助
- Claude MCP 服务器保留始终加载工具的设置 ([#1333](https://github.com/getpaseo/paseo/pull/1333) by [@nodomain](https://github.com/nodomain))
- Claude 配置保留其配置的模型 ([#1311](https://github.com/getpaseo/paseo/pull/1311) by [@ilteoood](https://github.com/ilteoood))
- 在较慢的机器上，Provider 加载可以等待更长时间 ([#1346](https://github.com/getpaseo/paseo/pull/1346) by [@nodomain](https://github.com/nodomain))
- Kimi 目录条目现在指向 Kimi Code CLI ([#1403](https://github.com/getpaseo/paseo/pull/1403) by [@wbxl2000](https://github.com/wbxl2000))
- 更新了 ACP Provider 目录中 Auggie、Claude Agent、Cline、Codebuddy Code、DimCode、Factory Droid、fast-agent、Gemini、GitHub Copilot 和 Nova 的条目
- 本地语音输入的崩溃报告显示更有用的细节 ([#1379](https://github.com/getpaseo/paseo/pull/1379))
- daemon 日志会显示被管理的 worker 退出的原因

### 修复

- Pi 的压缩斜杠命令可以正确运行 ([#1338](https://github.com/getpaseo/paseo/pull/1338) by [@chyendongnhanh338](https://github.com/chyendongnhanh338))
- 已合并 PR 的分支被删除后自动归档仍然有效 ([#1378](https://github.com/getpaseo/paseo/pull/1378))
- Worktree 可以正确检出已有的分支 ref ([#1358](https://github.com/getpaseo/paseo/pull/1358) by [@dixonl90](https://github.com/dixonl90))
- 启用 daemon 密码保护时文件下载可以正常工作 ([#1351](https://github.com/getpaseo/paseo/pull/1351) by [@nodomain](https://github.com/nodomain))
- iOS 上的 Markdown 链接可以再次点击 ([#1334](https://github.com/getpaseo/paseo/pull/1334) by [@kaspesi](https://github.com/kaspesi))
- iOS 上的 Markdown 图片正确渲染
- Windows 工作区可以正确加载其 Provider ([#1329](https://github.com/getpaseo/paseo/pull/1329))
- 移除 localhost 主机会停止其本地 daemon ([#1297](https://github.com/getpaseo/paseo/pull/1297) by [@mcowger](https://github.com/mcowger))
- Provider 设置面板正确层叠
- 新工作区界面不再在移动端侧边栏后面打开
- 全局 Agent 列表恢复正常 ([#1420](https://github.com/getpaseo/paseo/pull/1420))
- OpenCode 压缩摘要不再出现在聊天中
- 共享同一工作区的 OpenCode Agent 各自保留自己的 Paseo 工具

## 0.1.90 - 2026-06-04

### 新增

- **按状态对侧边栏分组，一眼就能看到等待你处理、可以审查、工作中和已完成的工作区** ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- **无需先选择项目，即可从全局侧边栏按钮开始一个新工作区** ([#1324](https://github.com/getpaseo/paseo/pull/1324))
- **直接在编辑器、文件管理器或 GitHub 中打开当前文件，而不只是打开工作区根目录** ([#1285](https://github.com/getpaseo/paseo/pull/1285) by [@aaronzhongg](https://github.com/aaronzhongg))
- **可以在主机设置中开启：PR 合并后自动归档干净的 PR 工作区** ([#1313](https://github.com/getpaseo/paseo/pull/1313))
- **安装较新的桌面构建后，桌面端管理的 Paseo 技能保持最新** ([#1309](https://github.com/getpaseo/paseo/pull/1309))
- **Dart 文件和 Dart 代码块现在支持语法高亮** ([#1326](https://github.com/getpaseo/paseo/pull/1326))

### 改进

- 侧边栏中可以审查或已失败的工作区可以标记为已读 ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- 跨 Provider 委派时，子 Agent 保留无人值守的权限 ([#1315](https://github.com/getpaseo/paseo/pull/1315))
- 定时运行的 Agent 打开时显示真实的提示词和标题，而不是看起来空空的 ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Git 控件优先提供让已就绪的分支得以发布的操作 ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- 多个 Agent 问题逐个显示
- 带有自由填写答案的 OpenCode 问题会在 Paseo 中显示输入的回复
- 委派的 Agent 活动在父工作区中可见
- 会话按最近活动排序
- 更新了 ACP Provider 目录中 Claude Agent、Cline、Codebuddy Code、Factory Droid 和 Qoder 的条目

### 修复

- 时间线追赶不再遗留未加载的较早消息
- 文件预览中的 Markdown 代码正确渲染
- 较长的语音输入重试不再阻塞新的音频
- 可以从主机设置页面使用 Settings 的主机选择器导航
- Diff 行号栏与更改的代码保持对齐
- 负载较高时移动端侧边栏手势保持响应
- 紧凑的底部面板保持显示其页脚和底部间距

## 0.1.89 - 2026-06-02

### 新增

- **通过公开的服务代理链接打开工作区服务** ([#1280](https://github.com/getpaseo/paseo/pull/1280) by [@mcowger](https://github.com/mcowger))
- **选择新 worktree 的创建位置** ([#1230](https://github.com/getpaseo/paseo/pull/1230) by [@mcowger](https://github.com/mcowger))
- **桌面窗口以相同的大小和位置重新打开** ([#1224](https://github.com/getpaseo/paseo/pull/1224) by [@everton-dgn](https://github.com/everton-dgn))
- **委派的 Agent 可以独立运行并定期发送 heartbeat 更新**

### 改进

- Composer 控件更适合较窄的窗格
- fork 拉取请求的徽标在 worktree 中保持可见
- ACP 目录中的 Cline 更新到 v3

### 修复

- 即使清理过程出错，归档 worktree 也能完成 ([#1260](https://github.com/getpaseo/paseo/pull/1260) by [@mcowger](https://github.com/mcowger))
- iOS 聊天消息正确渲染粗体、斜体、删除线和换行 ([#1254](https://github.com/getpaseo/paseo/pull/1254) by [@outofrange-consulting](https://github.com/outofrange-consulting))
- 在右边缘调整拆分窗格大小时不再被裁切 ([#1261](https://github.com/getpaseo/paseo/pull/1261) by [@everton-dgn](https://github.com/everton-dgn))
- Pi 扩展命令的输出不再挂起
- 委派的 Agent 不再计入工作区提醒数量

## 0.1.88 - 2026-06-01

### 新增

- **在新的 Appearance 设置中选择应用主题**
- **设置自定义界面字体**
- **设置自定义代码字体**
- **调整界面文字大小**
- **调整代码文字大小**
- **选择语法高亮主题**
- **让 cron 定时任务对齐到所选的时区** ([#1232](https://github.com/getpaseo/paseo/pull/1232) by [@damselem](https://github.com/damselem))

### 改进

- Settings 现在采用带有主机选择器的扁平侧边栏
- 工作区标签页切换更快
- 紧凑的 Composer 现在以百分比显示上下文用量
- 在工作区子目录中打开的 Agent 终端现在与其他工作区终端显示在一起
- 桌面应用打开时 macOS 显示器可以正常进入空闲 ([#1242](https://github.com/getpaseo/paseo/pull/1242) by [@fireblue](https://github.com/fireblue))
- 生成的大型 diff 现在显示清晰的“过大”占位符，而不是尝试渲染整个文件

### 修复

- 在长时间运行的工具更新前后，聊天历史可以正确追赶
- 拆分或调整窗格大小后终端窗格保持正确的尺寸
- 窗格尺寸变化后，恢复的终端快照可以正确重排
- 启动服务后工作区脚本菜单保持正确的尺寸
- iOS 聊天消息不再隐藏行内链接、URL 或带链接的文件路径 ([#1257](https://github.com/getpaseo/paseo/pull/1257) by [@outofrange-consulting](https://github.com/outofrange-consulting))

## 0.1.87 - 2026-05-30

### 新增

- OpenCode 子 Agent 的权限提示现在会在 Paseo 中显示，以便你批准或拒绝

### 修复

- 修复了动画视图绘制时 Android 间歇性崩溃的问题
- 修复了移动端底部面板关闭后无法重新打开的问题

## 0.1.86 - 2026-05-29

### 新增

- **以编码 Agent 的形式启动 Grok (xAI)**
- **Claude Opus 的 Fast 模式**
- **使用新的 Parakeet v3 语音模型进行多语言本地语音输入**

### 改进

- Edit、Write 和 Read 工具调用现在支持语法高亮
- Provider 加载失败时模型选择器会显示错误
- About 页面显示已连接主机的 daemon 版本
- 可以通过新的刷新按钮按需刷新 git diff
- 预览可以打开当前工作区之外的可读文件
- 没有图标的项目现在显示彩色图标，而不是灰色占位符
- 自动生成的 Agent 标题和 worktree 分支名现在使用你配置的 Provider 回退 ([#1219](https://github.com/getpaseo/paseo/pull/1219) by [@mcowger](https://github.com/mcowger))
- 本地语音输入不再把语音模型放在 daemon 中，从而降低其内存占用

### 修复

- 在移动端，整个 Composer 现在保持在键盘上方，子 Agent 栏和草稿胶囊不再被键盘挡住
- 重新连接后移动端 Agent 时间线会完整追赶，不会丢失消息
- 斜杠命令菜单不再显示两次 /clear

## 0.1.85 - 2026-05-29

### 新增

- **Claude 模型选择器中新增 Opus 4.8**，并提供 1M 上下文的变体

### 改进

- 归档 worktree 现在会把其 Agent 保留在已归档列表中，而不是移除它们
- 归档 Agent 时会清理以它为目标的定时任务

## 0.1.84 - 2026-05-28

### 新增

- **OpenCode Agent 自动接受工具调用**

### 改进

- 可以复制 OpenCode 的恢复命令，在 Paseo 之外继续该会话
- 模型选择器列出所有已启用的 Provider，某个 Provider 加载失败时提供 Retry 按钮
- Provider 设置更易于搜索和管理
- 通过 MCP 连接到 Paseo 的其他 Agent 看到的 Provider、模型和模式与应用中一致 ([#1198](https://github.com/getpaseo/paseo/pull/1198))
- OpenCode Edit 工具调用渲染为内联 diff
- 输入斜杠命令时最佳匹配排在最前面
- 在包含许多 git 文件夹的工作区中 daemon 启动更快
- Markdown 列表的间距更紧凑
- 流式输出 Agent 回复时卡顿更少
- 用户消息的页脚控件与聊天的其余部分对齐
- Agent 模式控件采用更简洁的单色样式
- 紧凑布局把上下文圆环移到页脚的右边缘

### 修复

- 移动端可以在聊天中选择文本 ([#1153](https://github.com/getpaseo/paseo/pull/1153) by [@muzhi1991](https://github.com/muzhi1991))
- 提交 Pi 问题后不再看起来像是打开了第二个提示词 ([#1188](https://github.com/getpaseo/paseo/pull/1188) by [@yuruiz](https://github.com/yuruiz))
- 修复了工作区 git 缓存无上限导致的 daemon 内存泄漏 ([#1200](https://github.com/getpaseo/paseo/pull/1200))
- Provider 诊断包含命令覆盖的二进制路径 ([#1191](https://github.com/getpaseo/paseo/pull/1191))
- daemon 绑定到通配地址时 OpenCode MCP 服务器可以正确连接
- 返回不符合规范输出的 MCP 服务器的工具调用不再校验失败

## 0.1.83 - 2026-05-26

### 修复

- 通过 MCP 创建 Agent 现在会等待它真正启动，因此失败会以明确的创建错误显示
- 通过 MCP 为 Agent 设置定时任务不再拒绝空白的频率占位符
- 在没有思考选项的模型上，草稿消息重新显示 Agent 模式标签

## 0.1.82 - 2026-05-26

### 新增

- **从任意一条用户消息回退聊天或文件** ([#1154](https://github.com/getpaseo/paseo/pull/1154))
- **查看 Agent 会话的累计费用** ([#1163](https://github.com/getpaseo/paseo/pull/1163))
- **把文件拖放到终端以插入其路径** ([#1173](https://github.com/getpaseo/paseo/pull/1173))
- **点击终端中的文件路径，在工作区预览中打开它** ([#1174](https://github.com/getpaseo/paseo/pull/1174))
- **为整个会话批准 OpenCode 权限** ([#1168](https://github.com/getpaseo/paseo/pull/1168))
- **工作区脚本现在显示在移动端标题栏中** ([#1093](https://github.com/getpaseo/paseo/pull/1093) by [@ayhanmalkoc](https://github.com/ayhanmalkoc))
- ACP Provider 目录新增 Devin CLI (by [@Alcimerio](https://github.com/Alcimerio))
- OpenCode Agent 显示其模式颜色

### 改进

- 打开侧边栏时移动端终端键盘会隐藏
- 读取、写入和 OpenCode 工具的活动渲染更加一致 ([#1171](https://github.com/getpaseo/paseo/pull/1171))
- 紧凑的工作区标题栏操作更整洁
- Settings 中的延迟读数更易于浏览 ([#1170](https://github.com/getpaseo/paseo/pull/1170))
- GitHub 报告 PR 已就绪后即可合并拉取请求 ([#1172](https://github.com/getpaseo/paseo/pull/1172))

### 修复

- 移动端斜杠命令自动补全不再闪烁或层级错乱
- 中断 OpenCode Agent 会让它回到空闲状态，而不是显示错误 ([#1169](https://github.com/getpaseo/paseo/pull/1169))
- 遵循按工作区选择的 Provider 模型 ([#1167](https://github.com/getpaseo/paseo/pull/1167))
- 草稿 Composer 保留你选择的权限模式 ([#1175](https://github.com/getpaseo/paseo/pull/1175))
- 终端颜色查询不再返回格式错误的回复
- 消息包含单独的 '%' 时聊天中的文件链接不再崩溃 (by [@Elliotwu-7](https://github.com/Elliotwu-7))

## 0.1.81 - 2026-05-24

### 新增

- **现在可以从支持的浏览器把 Paseo 安装为 Web 应用** ([#1144](https://github.com/getpaseo/paseo/pull/1144))
- **Pi 扩展对话框现在以 Paseo 权限提示的形式出现** ([#1134](https://github.com/getpaseo/paseo/pull/1134) by [@yuruiz](https://github.com/yuruiz))
- 侧边栏新增社区链接和主页按钮

### 改进

- **移动端终端加载更快，恢复已有输出更流畅** ([#1147](https://github.com/getpaseo/paseo/pull/1147))
- 复制助手消息时保留格式
- Agent 元数据回退失败时会记录每个 Provider 的尝试，便于调试

### 修复

- Android：从 Composer 打开的斜杠命令建议保持可交互
- macOS：Alt+字母快捷键恢复正常
- 调整大小时终端窗格不再闪烁
- OpenCode MCP 服务器只注入一次，而不是连接两次
- Import session 不再显示空会话
- Worktree 归档状态不再误报有未推送的提交 ([#1158](https://github.com/getpaseo/paseo/pull/1158))
- `/exit`、`/quit` 和 `/q` 斜杠命令别名现在显示为一行
- 浅色模式下组合快捷键标记清晰可读
- 分段控件在每个分段下方都显示轨道
- 深色模式下底部面板标题栏中的搜索文本清晰可读

## 0.1.80 - 2026-05-21

### 修复

- 在移动端打开下拉菜单不再崩溃

## 0.1.79 - 2026-05-21

### 新增

- **Pi 全面改版，获得一流支持**
  - 通过你已安装的 Pi CLI 运行，因此你的 Pi 扩展和配置都会沿用
  - 安装了 Pi MCP 扩展后，Pi Agent 可以调用 Paseo 工具
  - 可以导入你在终端中启动的 Pi 会话
  - 可以从任意 Agent 复制 Pi 的恢复命令，在终端中继续该会话
  - Windows：通过符号链接和目录联接访问的工作区路径中，Pi 会话能正确匹配
- **新的主屏幕，提供添加项目、导入会话、设置 Provider 和配对设备的快捷图块**
- **直接在一个全新的 worktree 中创建 Agent，运行结束后自动归档**
- **设置适用于你启动的每个 Agent 的自定义系统提示词**
- **重命名工作区、终端和 Agent 标签页** ([#531](https://github.com/getpaseo/paseo/pull/531))
- **ACP Provider 目录新增 DeepSeek TUI** ([#1096](https://github.com/getpaseo/paseo/pull/1096))
- **ACP Provider 目录新增 Kiro CLI** (by [@huhusmang](https://github.com/huhusmang))
- 目录中的 Provider 在模型选择器中显示其图标 ([#1098](https://github.com/getpaseo/paseo/pull/1098))
- 创建 Agent 时传入的自定义环境变量现在会传递到 Agent 进程 ([#1112](https://github.com/getpaseo/paseo/pull/1112))
- NixOS 模块支持自托管中继的公开 TLS 选项 ([#1106](https://github.com/getpaseo/paseo/pull/1106) by [@yzx9](https://github.com/yzx9))

### 改进

- **过时的主机连接会自动恢复，无需手动刷新**
- Paseo 会打开到你上次使用时所在的工作区 ([#1101](https://github.com/getpaseo/paseo/pull/1101))
- 工作区会记住你用哪个编辑器打开它们
- 过时的 daemon 在收到无法理解的命令时会建议升级
- Agent 运行时隐藏语音模式
- Agent 文件链接的提示文字显示完整解析后的文件路径 ([#1088](https://github.com/getpaseo/paseo/pull/1088))
- 工作区 git 状态在后台的刷新频率降低 ([#1102](https://github.com/getpaseo/paseo/pull/1102))

### 修复

- 显示器从睡眠中唤醒后 macOS 桌面端不再冻结 ([#745](https://github.com/getpaseo/paseo/pull/745))
- Windows：Codex 能正确识别 Microsoft Store 安装 ([#1020](https://github.com/getpaseo/paseo/pull/1020) by [@32r4](https://github.com/32r4))
- daemon 重启后工作区选择得以保留 ([#1111](https://github.com/getpaseo/paseo/pull/1111))
- Cursor Agent 会等待斜杠命令加载完成后再列出它们 ([#1099](https://github.com/getpaseo/paseo/pull/1099) by [@chrisbanes](https://github.com/chrisbanes))
- 遇到暂时性的子进程错误时 Codex 子 Agent 继续运行 (by [@xy-plus](https://github.com/xy-plus))
- iPad 终端可以从硬件键盘正确发送 Ctrl+C (by [@samatar26](https://github.com/samatar26))
- 包含非 ASCII 字符的 Git 文件名正确渲染 (by [@samatar26](https://github.com/samatar26))
- 粘贴快捷键可以在 Dvorak 键盘布局上使用 (by [@qin-nz](https://github.com/qin-nz))
- 对于路径需要 SDK 编码的项目，Claude 文件链接可以正确解析
- 聊天中不再出现重复的 Claude 结果文本 ([#1095](https://github.com/getpaseo/paseo/pull/1095))
- 动态 UI 样式不再把 CSS 规则泄漏到整个页面 ([#1103](https://github.com/getpaseo/paseo/pull/1103))
- 中继握手会拒绝试图在中途更换加密密钥的会话 ([#1037](https://github.com/getpaseo/paseo/pull/1037) by [@joaosa](https://github.com/joaosa))

## 0.1.78 - 2026-05-18

### 改进

- **移动端模型选择器更快、更直接** 选择模型、模式或思考选项所需的点击更少

### 修复

- 拆分窗格不再丢失滚动位置
- 在移动端底部面板中输入不再闪烁
- 在移动端 Web 上滑动关闭底部面板不再崩溃

## 0.1.77 - 2026-05-18

### 新增

- **结束和重启 Agent 的斜杠命令**
- **聊天中代码块的语法高亮**
- **聊天中代码块的复制按钮**
- **可配置的终端回滚缓冲区** ([#1021](https://github.com/getpaseo/paseo/pull/1021) by [@32r4](https://github.com/32r4))
- 助手文件链接包含行范围时会在该范围打开
- Agent 状态菜单中显示模式图标 ([#1059](https://github.com/getpaseo/paseo/pull/1059) by [@32r4](https://github.com/32r4))
- MCP 提供定时任务的更新、日志和单次运行工具 ([#1032](https://github.com/getpaseo/paseo/pull/1032) by [@skevetter](https://github.com/skevetter))
- 自托管中继可以为公开端点使用不同的 TLS 设置 ([#1045](https://github.com/getpaseo/paseo/pull/1045) by [@yzx9](https://github.com/yzx9))

### 改进

- 用户消息现在有独特的气泡填充色，使聊天层次更清晰
- 关闭标签页会回到其父标签页
- 悬停时 diff 行显示完整文件路径 ([#1061](https://github.com/getpaseo/paseo/pull/1061) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- `ls` 无法连接时 CLI 会显示远程 daemon 主机 ([#1043](https://github.com/getpaseo/paseo/pull/1043) by [@mturac](https://github.com/mturac))
- 通过 Nix 安装的 daemon 更小 ([#966](https://github.com/getpaseo/paseo/pull/966) by [@ixxie](https://github.com/ixxie))
- 继承用户 PATH 时，Nix 安装会遵循 home-manager 配置路径 ([#1040](https://github.com/getpaseo/paseo/pull/1040) by [@ixxie](https://github.com/ixxie))

### 修复

- OpenCode 探测不再创建空会话
- OpenCode 自定义命令不再挂起
- OpenCode 会话导入在更多环境中都能成功
- 原生 diff 行可以正确展开 ([#940](https://github.com/getpaseo/paseo/pull/940) by [@bolasblack](https://github.com/bolasblack))
- Web 上的移动端侧边栏交互可以正常工作 ([#900](https://github.com/getpaseo/paseo/pull/900) by [@nikuscs](https://github.com/nikuscs))
- 移动端 Web 的拖动手势可以可靠触发 ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- 移动端 Web 的拖放可以正确激活 ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- iOS Safari 聚焦 Composer 时不再缩放 ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- 移动端 Web Composer 中 Enter 的行为保持一致 ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- 带有长提示词时调整大小 Composer 不再闪烁
- 助手消息中的行内代码链接打开正确的文件
- 主机切换器弹出框足够宽，可以显示主机名称 ([#981](https://github.com/getpaseo/paseo/pull/981) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- Windows：导入已有会话时可以正确匹配路径 ([#1012](https://github.com/getpaseo/paseo/pull/1012) by [@kj1534](https://github.com/kj1534))

## 0.1.76 - 2026-05-15

### 新增

- **聊天时间戳和回合耗时** 每条消息都会显示发送时间，每个回合都会显示 Agent 用了多长时间
- **Claude Code 和 Codex 的 Auto Review 权限模式** Agent 在每个助手回合之后停下等待审查，而不是无人值守地运行 ([#928](https://github.com/getpaseo/paseo/pull/928), [#963](https://github.com/getpaseo/paseo/pull/963) by [@bolasblack](https://github.com/bolasblack))
- 在聊天中显示 Codex 的上下文压缩事件和 `/compact` 命令
- 可选在 PR 合并后自动归档 worktree
- 把 GitHub PR 或 issue 的 URL 粘贴到 Composer 中即可将其作为上下文附加
- 在 PR 悬停卡片中显示 GitHub 自动合并操作
- 在 PR 悬停卡片中显示所有 PR 检查的数量
- 可以重命名项目，以区分文件夹名称相同的重复项目
- 归档有未提交或未推送工作的 worktree 之前会进行确认
- Claude Code 现在会读取 `~/.claude/settings.json` 中的模型，因此自定义的模型列表会显示在模型选择器中
- 本地的 Claude Code 设置（`.claude/settings.local.json`）按工作区生效
- 通用 ACP Provider 的诊断信息显示在模型选择器中
- 可以为 Paseo 子 Agent 设置 fast 模式 ([#909](https://github.com/getpaseo/paseo/pull/909), [#910](https://github.com/getpaseo/paseo/pull/910) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

### 改进

- 在聊天中显示 Claude 的错误消息，而不是静默结束回合
- 只附加了一个 PR 时，工作区检出选择器会自动选中它
- 从分支创建时，新工作区流程会遵循当前检出的分支 ([#909](https://github.com/getpaseo/paseo/pull/908) by [@sbtobb](https://github.com/sbtobb))
- 来自控制台订阅 Provider 的 OpenCode 模型现在会出现在模型选择器中 ([#917](https://github.com/getpaseo/paseo/pull/917) by [@t2o2](https://github.com/t2o2))
- Cursor 模型选择器反映 Cursor ACP 客户端提供的模型 ([#958](https://github.com/getpaseo/paseo/pull/958) by [@chrisbanes](https://github.com/chrisbanes))

### 修复

- iPad 硬件键盘的 Enter 可以提交 Composer ([#919](https://github.com/getpaseo/paseo/pull/919) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- 对于细粒度 GitHub 令牌，PR 状态会回退到不含检查的查询 ([#932](https://github.com/getpaseo/paseo/pull/932) by [@32r4](https://github.com/32r4))
- ACP 错误显示为可读文本，而不是 `[object Object]`
- 上游 Provider 停滞时 OpenCode 在重试时不再挂起
- 上游分支被删除后 worktree 的领先提交数正确
- 从分支创建的 worktree 跟踪正确的上游
- 文件更改视图可以在还没有提交的空仓库中使用
- 助手消息中的文件链接打开正确的文件
- 默认的思考选项与所选模型的能力相匹配
- Shift+Enter 在终端输入模式中恢复正常
- 重新打开项目后不再出现重复的项目条目
- 由 Pi 支持的会话在遇到 Copilot 413 后可以恢复，而不是一直卡住
- 启动 Agent 时跳过探测无关的可执行文件候选
- 连接和断开竞争时中继的 E2EE 可以干净地重新连接
- 重新配置后工作区类型与项目类型保持同步
- zsh 集成文件安装时带有可用的运行时模式
- 创建和归档后 MCP worktree 缓存会刷新 ([#911](https://github.com/getpaseo/paseo/pull/911) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.75 - 2026-05-12

### 新增

- 可以在设置中设置语音输入和语音模式使用的语音转文字语言 ([#941](https://github.com/getpaseo/paseo/pull/941))

### 修复

- Codex 恢复失败现在会以明确的错误显示，而不是让 Agent 静默卡住 ([#947](https://github.com/getpaseo/paseo/pull/947))
- 设置了自定义 `OPENAI_BASE_URL` 的、扩展自 Codex 的自定义 Provider 现在可以正确路由 ([#915](https://github.com/getpaseo/paseo/pull/915))
- 修复了 Copilot 的 **Allow All** 模式（由 Autopilot 更名而来） ([#935](https://github.com/getpaseo/paseo/pull/935))
- 桌面端：仍在运行的 daemon 旁边留有过时的 PID 文件时，daemon 启动不再失败 ([#913](https://github.com/getpaseo/paseo/pull/913) by [@biaoma-ty](https://github.com/biaoma-ty))
- 可以从图片选择器正确附加 iPhone 的 HEIC 照片 ([#934](https://github.com/getpaseo/paseo/pull/934))
- 定时任务的 Agent 现在会在每次运行后自动归档 ([#945](https://github.com/getpaseo/paseo/pull/945))
- Windows：Codex 命令摘要会去掉 `pwsh`、`powershell` 或 `cmd` 包装 ([#931](https://github.com/getpaseo/paseo/pull/931) by [@32r4](https://github.com/32r4))
- iPad：在宽布局中，设置侧边栏和主侧边栏遵循顶部安全区域 ([#922](https://github.com/getpaseo/paseo/pull/922), [#937](https://github.com/getpaseo/paseo/pull/937) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.74 - 2026-05-11

### 修复

- **OpenCode Agent 的回合不再停滞** Paseo 现在跟随 OpenCode 的全局事件流，因此回合能可靠地流式输出，而不会退回到脆弱的恢复路径 ([#916](https://github.com/getpaseo/paseo/pull/916))

## 0.1.73 - 2026-05-10

### 修复

- **OpenCode Agent 在 OpenCode 1.14.42+ 上恢复可用** ([#895](https://github.com/getpaseo/paseo/pull/895), [#902](https://github.com/getpaseo/paseo/pull/902), [#904](https://github.com/getpaseo/paseo/pull/904) by [@atomlink-ye](https://github.com/atomlink-ye), [@plutofog](https://github.com/plutofog))
- Web：在不支持 `crypto.randomUUID` 的浏览器中打开工作区不再挂起 ([#858](https://github.com/getpaseo/paseo/pull/858) by [@cokekitten](https://github.com/cokekitten))
- Codex 子 Agent 的子工具调用现在会报告最终的失败状态，而不是一直显示“运行中” ([#899](https://github.com/getpaseo/paseo/pull/899))
- 没有显式 TLS 标志的旧中继配对 URL 恢复可用 ([#896](https://github.com/getpaseo/paseo/pull/896))
- macOS：标签页跳转快捷键不再与系统快捷键冲突 ([#859](https://github.com/getpaseo/paseo/pull/859) by [@nikuscs](https://github.com/nikuscs))
- Web：在桌面浏览器上 Composer 不再触发底部面板键盘 ([#898](https://github.com/getpaseo/paseo/pull/898) by [@nikuscs](https://github.com/nikuscs))
- Windows：git 操作不再在每次调用时闪出控制台窗口 ([#897](https://github.com/getpaseo/paseo/pull/897))
- 文件浏览器不再跟随指向工作区根目录之外的符号链接 ([#847](https://github.com/getpaseo/paseo/pull/847) by [@joaosa](https://github.com/joaosa))
- 桌面端只通过 http(s) 和 mailto 协议打开外部 URL ([#845](https://github.com/getpaseo/paseo/pull/845) by [@joaosa](https://github.com/joaosa))
- MCP 调试请求日志现在会隐去请求正文 ([#842](https://github.com/getpaseo/paseo/pull/842) by [@joaosa](https://github.com/joaosa))

## 0.1.72 - 2026-05-10

### 修复

- **Codex 审批提示不再挂起** 修复了 0.1.70 引入的回归：Codex Agent 会在命令和文件审批上永远等待——提示从未到达应用，Agent 一直卡在“运行中” ([#866](https://github.com/getpaseo/paseo/pull/866), [#869](https://github.com/getpaseo/paseo/pull/869))
- **Windows：Codex 输出非 JSON 内容时 daemon 不再崩溃** 来自 Codex CLI 的本地化 stdout 行现在会被忽略，而不会拖垮 daemon 工作进程 ([#866](https://github.com/getpaseo/paseo/pull/866))
- 现在可以把图片拖放到新建工作区屏幕上 ([#850](https://github.com/getpaseo/paseo/pull/850))
- 从工具栏归档 worktree 会立即跳转，而不会让你在失效的屏幕上停留片刻 ([#852](https://github.com/getpaseo/paseo/pull/852))
- 由 Pi 支持的会话在关闭时会干净地退出，并释放 Pi 端的扩展资源 ([#863](https://github.com/getpaseo/paseo/pull/863))

## 0.1.71 - 2026-05-09

### 新增

- **把已有的 Claude、Codex 和 OpenCode 会话导入** Paseo——在终端中开始的对话可以在应用中继续，并保留完整的时间线 ([#766](https://github.com/getpaseo/paseo/pull/766), [#833](https://github.com/getpaseo/paseo/pull/833))
- **子 Agent 现在显示在 Composer 上方的可折叠区域中**，方便你跳转到主 Agent 创建的 Agent ([#532](https://github.com/getpaseo/paseo/pull/532))
- 直接从检出窗格合并拉取请求 ([#814](https://github.com/getpaseo/paseo/pull/814))
- 自定义 Paseo 按项目用于自动生成 Agent 标题、分支名、提交信息和拉取请求描述的提示词 ([#836](https://github.com/getpaseo/paseo/pull/836))
- 无需先输入提示词即可打开空工作区 ([#834](https://github.com/getpaseo/paseo/pull/834))
- 项目设置现在分组显示，并带有指向相关文档的行内链接 ([#837](https://github.com/getpaseo/paseo/pull/837))
- 桌面端提供丰富的上下文菜单——复制链接、复制图片和拼写检查建议
- 归档由 Codex 支持的 Agent 现在也会归档底层的原生 Codex 线程 ([#827](https://github.com/getpaseo/paseo/pull/827) by [@32r4](https://github.com/32r4))

### 改进

- 打开工作区时会自动聚焦需要你关注的 Agent ([#828](https://github.com/getpaseo/paseo/pull/828))
- 无人值守的 Agent 通过 MCP 在其他 Provider 上创建子 Agent 时，子 Agent 现在也以无人值守模式启动

### 修复

- iOS 项目选择器现在会提交输入的路径 ([#831](https://github.com/getpaseo/paseo/pull/831))
- 发往多个 Agent 的系统消息和聊天提及现在能一致地送达每个接收方 ([#830](https://github.com/getpaseo/paseo/pull/830))
- 点击 Agent 输出中的 Markdown 链接时，除了打开链接，不再同时重新加载桌面应用
- macOS 桌面端标签页跳转快捷键现在使用 Cmd+Option+1-9，避免与基于 Option 的国际键盘字符（如 `@`）冲突

### 安全

- 本地状态文件（daemon 密钥对、存储的凭据、持久化的配置）现在只有所属用户可读 ([#825](https://github.com/getpaseo/paseo/pull/825) by [@joaosa](https://github.com/joaosa))

## 0.1.70 - 2026-05-08

### 破坏性变更

- **Claude Agent 现在要求 `claude` 位于 PATH 中** 运行 Claude Agent 之前请全局安装 Claude Code（`npm install -g @anthropic-ai/claude-code`）——Paseo 不再附带内置的回退二进制。这与 Codex 和 OpenCode 的做法一致，并让每个平台的桌面安装包缩小约 210 MB

### 新增

- **一键添加 ACP Provider**——从内置目录添加 Cursor、Hermes、Qwen Coder、Kimi Code 等 ACP Agent，无需手写配置
- Codex `/goal` 斜杠命令——在 Codex Agent 运行时于回合中途设置或更新目标
- 模型选择器中现在可以选择 Claude 的 Sonnet 4.6 1M 上下文模型
- 识别粘贴到 Composer 搜索中的 GitHub issue 和 PR URL
- `paseo worktree create` CLI 命令，功能与 MCP `create_worktree` 工具对等
- `paseo schedule update` 可以原地编辑定时任务，无需重新创建
- 用于 cron 式触发的 `paseo schedule run-once`，以及 `schedule` 和 `loop` 上的 `--mode`。后台运行现在默认使用无人值守模式
- 项目设置现在列出来自任意远程仓库的工作区——GitLab、Gitea、Bitbucket、自托管和 SSH 风格的 URL，而不只是 GitHub ([#681](https://github.com/getpaseo/paseo/pull/681) by [@krumpyzoid](https://github.com/krumpyzoid))

### 改进

- 技能现在按需安装、更新和卸载，而不是在每次桌面端启动时静默自动同步
- 自托管中继可以选择为 TLS 连接使用 `wss://`
- 工作区打开目标只显示当前 daemon 可访问的选项
- 组合框搜索会匹配模型描述，而不只是名称
- Codex 图片附件以路径 markdown 的形式行内渲染
- 子 Agent 任务通知不再干扰父 Agent 的时间线
- 语音模式：思考提示音更轻，界面细节更打磨
- 设置侧边栏顺序：Projects 现在位于 General 之后
- 桌面应用的 Electron 升级到 41.2.0

### 修复

- **Claude Agent：daemon 不再在回合中途崩溃**，即使底层 SDK 在连接断开后发出了多余的控制消息
- **Windows：** 终端可以可靠地启动并干净地关闭，不会留下卡住的进程
- **Linux：** 在繁忙的工作树上，工作区文件监视器不再产生事件风暴，修复了大型仓库上的 CPU 峰值 ([#794](https://github.com/getpaseo/paseo/pull/794) by [@312223105](https://github.com/312223105))
- 基于 ACP 的 Agent 可以可靠地启动终端 shell 命令 ([#793](https://github.com/getpaseo/paseo/pull/793) by [@ebg1223](https://github.com/ebg1223))
- 检出的简要统计现在会计入未跟踪的文件 ([#608](https://github.com/getpaseo/paseo/issues/608), [#762](https://github.com/getpaseo/paseo/pull/762) by [@somus](https://github.com/somus))
- 端口 443 上的中继端点会自动使用 TLS ([#774](https://github.com/getpaseo/paseo/pull/774) by [@caoer](https://github.com/caoer))
- 桌面端 CLI 透传的 TTY 处理——从桌面应用启动的交互式命令现在行为正确
- CLI 会遵循 `PASEO_PASSWORD` 环境变量来连接受密码保护的 daemon
- daemon 关闭时使用 tree-kill 干净地终止所有子进程
- Agent 启动路径能更可靠地处理缺失的可执行文件和非常规的安装布局
- OpenCode 现在会转发 Provider 的重试错误，而不是静默吞掉
- Codex 导入不再回退到错误的默认模式
- 在可编辑字段中输入时，窗格键盘快捷键不再触发
- 在 Web 上冷启动导航到工作区 URL 时，现在会落在正确的侧边栏条目上
- 修复了 Web 上的工作区导航回归
- 消除了重复的工作区外壳导航
- “Update installed”提示不再错误地闪现
- 浏览器窗格的重新加载焦点和开发者工具处理
- MCP 终端捕获现在包含回滚缓冲区
- 通过 MCP 针对已有 worktree 创建 Agent 时，worktree 分支不再被重命名
- 在已注册工作区的子目录中创建 Agent 现在会在该子目录中运行，而不是跳到父目录 ([#551](https://github.com/getpaseo/paseo/issues/551))
- 非 GitHub 项目的显示名称取自远程仓库的 owner/repo，而不是本地路径
- 桌面端 IPC 封装进共享的 mutation/query hook，修复了过时状态和间歇性失败 ([#761](https://github.com/getpaseo/paseo/issues/761))
- `paseo schedule create --host` 现在要求 `--cwd`，以免在错误的目录中运行定时任务
- `paseo schedule create --every` 默认立即运行一次，之后按配置的间隔运行
- MCP `create_agent` 会校验所请求的模式，并拒绝静默的跨 Provider 继承

## 0.1.69 - 2026-05-05

### 修复

- 内部 daemon 进程崩溃时 Paseo 现在会自动恢复——你的 Agent 保持连接而不会卡住，你也无需重启任何东西
- 回答 Claude Agent 的交互式问题现在能正确送达 Claude，而不会被丢弃 ([#760](https://github.com/getpaseo/paseo/pull/760) by [@somus](https://github.com/somus))

## 0.1.68 - 2026-05-05

### 修复

- 全新安装后首次启动桌面应用不再失败

## 0.1.67 - 2026-05-03

### 修复

- 归档 worktree 或工作区立即生效，无需等待 daemon，失败时会自动回滚
- 桌面设置中的内置 daemon 开关现在真正生效
- 旧版迁移后，桌面设置不再在应用启动时被重置
- 桌面 daemon 启动失败现在会显示在启动屏幕上并响应重试，而不是让应用静默卡住
- 内部 LLM 调用（分支名、提交信息、PR 文本）不再在你的 Provider 历史中留下临时的 Agent 会话

## 0.1.66 - 2026-05-03

### 修复

- 流式 markdown 会保留末尾的换行，因此在 Agent 仍在输出时段落间距保持正确
- Agent 初始化失败会在 30 秒内显示，而不是 5 分钟
- 终端会回复 ANSI 光标位置查询，因此询问光标位置的工具不再挂起

## 0.1.65 - 2026-05-03

### 新增

- **应用内浏览器**——在任意工作区中打开真正的 Web 浏览器来测试你的应用 ([#670](https://github.com/getpaseo/paseo/pull/670) by [@jasonkneen](https://github.com/jasonkneen))
- git diff 窗格中的行内审查评论。点击行号即可开始评论 ([#530](https://github.com/getpaseo/paseo/pull/530))
- 现在会显示 Codex、OpenCode 和 Claude 的子 Agent 活动 ([#672](https://github.com/getpaseo/paseo/pull/672), [#658](https://github.com/getpaseo/paseo/pull/658) by [@thisisryanswift](https://github.com/thisisryanswift))
- 在更改窗格的 git 操作菜单中一步完成分支的拉取和推送
- 使用 `paseo import --provider <name> <id>` 恢复已有的 Agent 会话 ([#632](https://github.com/getpaseo/paseo/pull/632))
- daemon 连接支持密码认证和 SSL ([#635](https://github.com/getpaseo/paseo/pull/635))
- 在 CLI 中使用配对邀请 URL 通过中继连接到 daemon ([#639](https://github.com/getpaseo/paseo/pull/639))
- **Windows：** 现在提供原生 ARM64 构建
- 内置的 Paseo 技能现在会在桌面应用启动时自动刷新

### 改进

- Codex 流式输出响应更快——保留消息边界，输出更早到达
- 终端会话在专用的工作进程中运行，稳定性更好
- 新 worktree 的分支名取自你的提示词和附件，而不是通用占位符
- 审查评论界面更整洁、更易浏览
- 配置了密码时，daemon 的 `/api/status` 端点现在受密码认证保护

### 修复

- **Apple Silicon Mac：** 桌面更新流水线现在以原子方式发布清单，消除了可能在 Apple Silicon Mac 上安装 Intel 构建并导致渲染进程 CPU 占用超过 100% 的竞态。受影响的用户会自动恢复——electron-updater 的 Rosetta 检测会在下一次检查更新时迁回 arm64 ([#555](https://github.com/getpaseo/paseo/issues/555))
- **Linux：** `.deb` 和 `.rpm` 包现在在程序坞和进程列表中显示为 `Paseo`，而不是 `Paseo.bin`。`--no-sandbox` 现在只作用于 AppImage，与 VS Code 的沙箱处理一致 ([#602](https://github.com/getpaseo/paseo/issues/602))
- **Windows：** Git diff 命令遇到包含特殊字符的路径不再出错 ([#629](https://github.com/getpaseo/paseo/pull/629))
- Cursor CLI 和其他 ACP 自定义 Provider 可以可靠地启动 ([#628](https://github.com/getpaseo/paseo/pull/628))
- WebSocket 客户端在流中途断开时 daemon 保持运行，崩溃时现在会写入一条致命日志，而不是静默消失 ([#613](https://github.com/getpaseo/paseo/pull/613) by [@yuruiz](https://github.com/yuruiz))
- 长 Agent 时间线可以通过中继干净地重新连接，而不会在追赶时反复断开 ([#657](https://github.com/getpaseo/paseo/pull/657) by [@fireblue](https://github.com/fireblue))
- 重新打开 Agent 时，Agent 时间线以更小的追赶请求刷新
- 终端快照在客户端重新连接之前可靠地刷新
- 当聚焦的工作区已是最新时，工作区重新连接会避免不必要的刷新工作
- Agent 标签页失去焦点时语音输入继续录音
- OpenCode 模式选择器现在列出所有模式中可用的 Agent ([#606](https://github.com/getpaseo/paseo/pull/606) by [@thisisryanswift](https://github.com/thisisryanswift))
- Codex 计划审批面板不再重复
- 导入的 Agent 会立即显示正确的标题
- OpenCode 会显示无效的模式或模型错误，而不是挂起
- 已归档的 worktree 保持隐藏，不会闪回列表 ([#640](https://github.com/getpaseo/paseo/pull/640))
- Web 下拉菜单不再意外改变大小
- 可见的更改窗格与工作树的 diff 保持同步
- 时间线上的工具详情行恢复可选择
- setup、teardown 和终端操作中的 `paseo.json` 解析错误现在会显示明确的错误，而不是静默失败
- 修复了 Web 上 diff 行号栏在某些情况下错位一行的问题
- 在回合中途加载时间线时，流式的 Agent 输出可以干净地对齐 ([#663](https://github.com/getpaseo/paseo/pull/663))
- 助手消息中的图片在加载时显示加载指示器，加载失败时显示“Image unavailable”回退，而不是一片空白
- 隔离的底部面板模态框可以关闭并重新打开，不会卡住

## 0.1.64 - 2026-04-28

### 新增

- OpenCode 现在有自动批准工具调用的 Full Access 模式 ([#595](https://github.com/getpaseo/paseo/pull/595) by [@tmih06](https://github.com/tmih06))
- OpenCode 支持可执行的斜杠命令 ([#597](https://github.com/getpaseo/paseo/pull/597) by [@tmih06](https://github.com/tmih06))

### 改进

- 在非常大的项目中 `@` 提及保持流畅 ([#600](https://github.com/getpaseo/paseo/pull/600) by [@yuruiz](https://github.com/yuruiz))

### 修复

- `paseo.json` 存在解析错误时工作区仍能加载

## 0.1.63 - 2026-04-28

### 新增

- 带有内置 `paseo.json` 编辑器的项目设置页面
- 冷启动会恢复你上次打开的工作区
- 工具调用徽标上有一个按钮，可直接打开所引用的文件
- 从工作区的打开菜单中在 GitHub 上打开当前分支 ([#583](https://github.com/getpaseo/paseo/pull/583) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- 在 Settings 中启用或停用 Provider，无需编辑配置文件
- 缺少 worktree setup 脚本时，Paseo 会提示你进行配置
- 选择关闭桌面应用时是否关闭 daemon

### 改进

- 重新设计了 Provider 设置和模型选择
- 对于兼容 OpenAI 的 Provider，可以配置语音模式的转写端点 ([#570](https://github.com/getpaseo/paseo/pull/570) by [@yuruiz](https://github.com/yuruiz))
- 添加项目不再等待 GitHub PR 状态加载
- 启动屏幕更简洁——只有 logo 和一道淡淡的微光
- `paseo.json` 的 setup 和 teardown 接受单个命令字符串，而不只是数组
- 归档 worktree 立即生效，无需等待后端确认
- 加载或流式输出时，Agent 时间线和 git diff 列表不再跳动

### 修复

- `paseo loop run` 和 `paseo run` 现在会遵循 `--provider` 和 `--model` 标志 ([#594](https://github.com/getpaseo/paseo/pull/594) by [@VincenzoRocchi](https://github.com/VincenzoRocchi))
- 只设置了 DeepSeek 或其他非 OpenAI/Anthropic/OpenRouter 的 API 密钥时，Pi Provider 也会显示
- 为新 Agent 选择默认模型时，会考虑来自 `additionalModels` 和 `profileModels` 的自定义模型
- 文件预览的行号在第 99 行之后仍保持在一行内
- 在 macOS 上 Cmd+Q 会退出桌面应用，而不是让它在后台继续运行
- 渲染出现问题后终端会话可以干净地恢复，包括 nvim 的初始尺寸调整
- 终端协议查询的响应不再泄漏到浏览器中
- 助手链接颜色重新与主题一致
- 带行号的文件链接（如 `foo.ts:42`）可以从助手消息中正确打开
- Claude 的 Grep 结果会显示在搜索详情正文中
- 重新打开 worktree 会落在正确的项目下
- 来自已停用或不可用 Provider 的 Agent 在历史中保持可见
- 新的 CLI Agent 现在要求指定 Provider，而不是静默失败
- Git diff 标题不再被截断
- Provider 诊断模态框在矮屏幕上可以滚动
- Provider 诊断显示真实的错误和底层子进程输出，而不是通用消息
- 已归档的工作区不再干扰工作目录解析
- 在消息上三击不再把选区扩展到相邻的气泡
- 打包后的桌面应用会保留你的 zsh 提示符

## 0.1.62 - 2026-04-23

### 新增

- 应用与 daemon 版本不一致时侧边栏会显示警告，并提供前往设置的快捷方式

### 改进

- 工作区在启动时立即显示在侧边栏中，无需等待 git 注册

### 修复

- 从 fork 打开的 PR 的拉取请求状态可以正确解析
- 在打包构建中，从 macOS 桌面应用安装 paseo CLI 现在可以正常工作
- 从桌面应用启动的 Agent 不再继承仅限 Electron 的环境变量

## 0.1.61 - 2026-04-23

### 新增

- Provider 配置中的 `additionalModels` 选项可以添加模型或重新命名模型，而无需替换整个列表——条目会与运行时发现的模型（ACP）或你的静态 `models` 列表合并。参见 [Provider 文档](https://paseo.sh/docs/providers)
- 新的 [Provider 文档页面](https://paseo.sh/docs/providers)，在一处涵盖一流 Provider 和所有自定义 Provider 的配置模式

### 改进

- Pi 在启动时会加载你已安装的扩展，因此其模型会显示在模型选择器中
- 调整资源管理器侧边栏大小不再重新渲染工作区的其余部分
- 助手消息中的图片（文件路径和行内 data URL）会作为本地附件保存，并在文件窗格中打开

## 0.1.60 - 2026-04-22

### 新增

- 每个 worktree 的脚本和服务——在 `paseo.json` 中定义命名命令，长时间运行的服务会被托管，拥有自己的端口和像 `http://web.my-app.localhost:6767` 这样友好的代理 URL。参见 [worktree 指南](https://paseo.sh/docs/worktrees)
- 直接从工作区标题栏为 worktree 启动脚本和服务
- 每个工作区中新增 Setup 标签页，实时显示 setup、teardown 和脚本进度
- 资源管理器侧边栏中显示 GitHub 检查和 PR 审查，并提供展示完整明细的悬停卡片
- 新的 worktree 创建流程可以选择基础分支，或检出已有的 GitHub 拉取请求
- 把 GitHub issue 和拉取请求作为提示词上下文的一部分附加给 Agent
- 工作区侧边栏中的拉取请求窗格
- 重新设计的 Settings 屏幕，采用模块化的分区导航
- 按主机配置 Provider——在每台远程主机上独立设置 Provider、模型和凭据
- 直接集成 Pi，取代 ACP 桥接，流式输出更快、卡顿更少
- Beta 发布渠道——在 Settings 中选择加入，即可在桌面 beta 构建升级为稳定版之前收到它们
- 新建工作区选择器按最近使用对分支排序，并支持快速搜索

### 改进

- 在桌面端和移动端，工作区和标签页切换大幅加快——你可以并行打开许多工作区而不会卡顿
- 在大量工具输出期间 Agent 流渲染更流畅
- 应用启动经由稳定的连接，并在不闪烁的情况下落在正确的屏幕上
- Provider 刷新更可靠，不再因暂时性故障而停滞
- Git 和 GitHub 状态与提交、切换分支和推送等本地更改保持同步
- 重新设计了 Composer 附件，采用更简洁的胶囊布局和图片灯箱
- 应用内通知会发送到你实际正在查看的界面
- 打开 Settings 时键盘快捷键仍然可用
- Escape 可以可靠地中断当前 Agent
- 检出来自 fork 的拉取请求会落在带 owner 前缀的分支上，避免多个 fork 冲突
- `paseo ls` 默认显示活跃的 Agent；传入 `-a` 可包含已归档的 Agent
- GitHub 分支和 PR 选择器加载更快——查询会推迟到选择器打开时

### 修复

- 在 Web 上发送后 Composer 文本框会缩回原来的大小
- 新工作区草稿在提交后被清除，而不会一直留着
- 替换运行中的 Agent 时会清理之前的 Agent，而不会把它留下
- Agent 通知不再被处于后台的已聚焦客户端吞掉
- 已移除的工作区文件夹重新从工作区列表中消失
- 批准计划后 Codex 保持 fast 模式 ([#526](https://github.com/getpaseo/paseo/pull/526) by [@therainisme](https://github.com/therainisme))
- 工作区标签页焦点在页面刷新后得以保留
- Settings 屏幕不再因多余的间距把标题栏往下推
- 分支切换器的标题在窄行中不再溢出
- 取消后 iOS 图片选择器不再让屏幕失去响应
- 如果之前的尝试被中断，归档 worktree 可以干净地恢复
- Agent 消息中以 `~` 开头的路径的图片可以加载，而不会一直转圈
- Agent 仍在流式输出时，移动端的工具调用块可以正确展开
- 追赶范围与投影范围重叠时时间线不再卡顿
- 替换回合正在进行时 Codex 不再闪现空闲状态
- rebase 进行中时分支状态可以正确恢复
- 工作区悬停卡片在屏幕边缘附近不再被裁切

## 0.1.59 - 2026-04-16

### 新增

- Claude 模型选择器中新增 Opus 4.7，并提供 1M 上下文的变体
- Opus 4.7 新增 Extra High 推理强度，介于 High 和 Max 之间

## 0.1.58 - 2026-04-16

### 新增

- Markdown 文件在文件窗格中渲染为格式化的 markdown ([#427](https://github.com/getpaseo/paseo/pull/427) by [@aaronflorey](https://github.com/aaronflorey))
- Cmd+L（Windows/Linux 上为 Ctrl+L）聚焦 Agent 消息输入框
- Provider 模型按新鲜度 TTL 刷新；Settings 显示上次更新时间和所有获取错误 ([#426](https://github.com/getpaseo/paseo/pull/426))
- Provider 配置中的 `disallowedTools` 选项，可以禁止 Agent 使用特定工具

### 改进

- Windows：Agent 可以从 npm `.cmd` 包装脚本、带空格的路径和 JSON 配置参数可靠地启动——修复了 `spawn EINVAL` 启动错误 ([#454](https://github.com/getpaseo/paseo/pull/454))
- OpenCode 权限提示包含发起请求的工具的上下文 ([#398](https://github.com/getpaseo/paseo/pull/398) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode 的待办和压缩事件会在时间线中渲染 ([#429](https://github.com/getpaseo/paseo/pull/429) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode 会话在关闭时干净地归档 ([#408](https://github.com/getpaseo/paseo/pull/408) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode 斜杠命令可以从 SSE 超时中恢复 ([#407](https://github.com/getpaseo/paseo/pull/407) by [@aaronflorey](https://github.com/aaronflorey))
- Paseo MCP 工具可以作用于已归档的 Agent，与 CLI 一致 ([#423](https://github.com/getpaseo/paseo/pull/423))
- 在所有 Web 视图中，原生滚动条与当前主题一致 ([#399](https://github.com/getpaseo/paseo/pull/399) by [@ethersh](https://github.com/ethersh))

### 修复

- 在 iOS 上可以选择和复制代码文件预览 ([#447](https://github.com/getpaseo/paseo/pull/447) by [@muzhi1991](https://github.com/muzhi1991))
- 重新打开同一文件时，文件预览不再显示过时的内容 ([#411](https://github.com/getpaseo/paseo/pull/411) by [@muzhi1991](https://github.com/muzhi1991))
- 页面刷新后客户端重新连接时，文件浏览器会重新初始化 ([#442](https://github.com/getpaseo/paseo/pull/442) by [@1996fanrui](https://github.com/1996fanrui))
- 通用 ACP Provider 不再收到重复的命令参数 ([#444](https://github.com/getpaseo/paseo/pull/444) by [@edvardchen](https://github.com/edvardchen))
- 非 git 工作区的标题栏不再显示分支图标
- 移动端分支切换器的布局保持稳定
- 选择器行中的模型名称不再在单词中间截断
- 在移动端重新连接后消息按正确顺序显示
- 清除 Agent 提醒时不再因超时而抛出错误

## 0.1.56 - 2026-04-14

### 修复

- 包含空 git 仓库（尚无提交）的项目不再导致应用在启动时崩溃
- 单个有问题的项目不再阻止其余工作区加载

## 0.1.55 - 2026-04-14

### 新增

- Provider 配置档——在 Paseo 配置中定义自定义 Provider，它们会与内置 Provider 一起显示。可以覆盖内置 Provider 的二进制、环境变量或模型，也可以创建全新的 Provider。参见[配置指南](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
- 支持 ACP Agent——在 Provider 配置中使用 `extends: "acp"` 即可把任何兼容 ACP 的 Agent 添加到 Paseo，无需修改代码
- 创建定时任务 Agent 时可以选择 Provider 和模型
- Opus 4.6 模型新增 Max 推理强度选项
- Cmd+,（Windows/Linux 上为 Ctrl+,）打开设置

### 改进

- Git 操作大幅加快——工作区状态、PR 检查和分支数据都使用共享的缓存快照服务，而不是在每次请求时调用 git。同时运行 20 多个工作区现在也很流畅
- 支持 Windows——daemon 和 CLI 在 Windows 上原生运行，具备正确的 shell 引号、可执行文件解析和路径处理
- iPad 和平板布局在所有屏幕尺寸下都能正确显示
- 按 Enter 时 IME 组字（中文、日文、韩文输入）不再提前提交

### 修复

- 创建 worktree 时不再短暂地把它显示为独立项目，然后才放到正确的仓库下
- worktree 创建的加载指示器在整个过程中保持可见，而不会在鼠标移开时消失
- 在同一项目的工作区之间切换时，工作区导航可以正确更新
- 在窄窗口中，桌面端工作区标题栏的对齐和模型选择器不再溢出
- 加载指示器在浅色模式下可见

## 0.1.54 - 2026-04-12

### 新增

- Agent 消息中的行内图片预览——Agent 生成的截图和图片直接在对话中渲染，而不是显示为原始的 markdown 链接

### 改进

- 默认不再向 Agent 注入 Paseo 工具——需要 Agent 之间的编排时可在 Settings 中选择开启
- Agent 的 Provider 和模式现在在服务端解析，因此 `paseo run` 等 CLI 命令无需在客户端查找即可使用一致的默认值

### 修复

- Shift+Enter 现在会在 Agent 终端输入中正确插入换行，而不是提交
- Windows：创建 Claude Agent 时 MCP 配置不再被破坏
- 没有远程跟踪分支的分支不再在计算领先/落后数时出错

## 0.1.53 - 2026-04-12

### 新增

- Agent 自动获得 Paseo 工具——每个新 Agent 都能通过 MCP 访问终端、定时任务、worktree 和其他 Agent。可在 Settings 的“Inject Paseo tools”中关闭
- Git pull——直接从工作区标题栏拉取远程更改。当你的分支落后于 origin 时会提升为主要操作
- 子 Agent 通知——子 Agent 完成、出错或需要权限审批时会自动通知父 Agent
- 重新加载 Agent——`paseo agent reload` 可以从 CLI 重启 Agent 的底层进程
- 在桌面端用鼠标中键关闭标签页
- 循环切换主题的键盘快捷键

### 改进

- 不可用的 git 操作现在会在提示中说明原因，而不是静默变灰
- 移动端的流式 markdown 渲染明显加快
- 侧边栏、分支切换器和 Agent 面板不再进行不必要的重新渲染——在大型工作区上效果明显
- Agent 时间线中的 Paseo 工具调用显示 Paseo logo 和易读的名称
- 中继和配对 URL 会从 daemon 日志中去除

### 修复

- 已关闭的 Agent 标签页在重新连接后不再重新出现
- 桌面通知徽标计数在所有工作区之间保持一致
- 在主机之间切换时主机切换器的状态可以正确同步

## 0.1.52 - 2026-04-10

### 新增

- 主题选择器——从六种主题中选择，包括 Midnight、Claude 和 Ghostty 深色变体
- 切换分支——直接从工作区标题栏切换 git 分支，未提交的更改会自动 stash 并恢复
- 自动下载更新——桌面更新会在后台静默下载，你准备好时即可安装

### 修复

- 调整窗口大小或旋转平板时布局现在能正确响应——之前应用可能在大屏幕上卡在移动端布局
- 在大量输出期间，终端不再因快照频繁抖动而导致内存暴涨
- 在终端中输入可以可靠地工作——特殊按键、Ctrl 组合键和粘贴都由终端模拟器原生处理
- 初始化中的 Agent 不再像在运行一样显示加载指示器
- 即使会话持久化不可用，也可以重新连接到正在运行的 Agent
- 桌面端的错误屏幕现在可以滚动
- 打开模型选择器时模型列表会在后台刷新
- 草稿 Agent 的功能偏好（如思考模式）会跨会话记住

## 0.1.51 - 2026-04-09

### 新增

- OpenCode 支持图片附件——在 OpenCode Agent 的提示词中附加截图和图片
- WebStorm——加入“Open in editor”列表，与 Cursor、VS Code 和 Zed 并列
- 发送行为设置——选择在 Agent 运行时按 Enter 是立即中断，还是把你的消息排入队列

### 修复

- 模型选择器在 iPad 上不再崩溃
- 配对现在使用正确的主机名，修复了某些网络环境下的连接失败
- OpenCode Agent 显示正确的终止状态，并能可靠地刷新模型
- 现在可以正确地向刚完成一个回合的 Agent 发送后续消息
- Pi Agent 的命令现在可以正确加载
- 内部调试输出不再出现在 Claude Agent 的时间线中
- 简化了二维码扫描屏幕的视觉效果

## 0.1.50 - 2026-04-07

### 新增

- 上下文窗口用量表——查看 Agent 已使用了多少上下文窗口，并在 70% 和 90% 处有颜色阈值。适用于 Claude Code、Codex 和 OpenCode
- 在编辑器中打开——从任意工作区直接跳转到 Cursor、VS Code、Zed 或文件管理器。Paseo 会记住你的选择
- 并排 diff——在统一视图和分栏 diff 视图之间切换，并可选择是否显示空白字符
- 语音消息——使用语音模式时，Agent 的语音现在作为普通消息出现在对话中，而不是原始工具输出
- 计划操作——计划卡片现在显示 Agent 支持的操作（例如“Implement”“Deny”），而不是通用的接受/拒绝按钮
- 后台 git fetch——Changes 窗格中的领先/落后计数会自动保持最新

### 改进

- 连接时工作区立即加载，无需等待完整同步
- 切换标签页时，文件浏览器和 diff 窗格会记住哪些文件夹已展开
- 关闭工作区标签页现在立即生效
- Settings 为 Provider 显示 Refresh 按钮，并行内显示错误详情
- 重新加载 Agent 的按钮移到远离关闭按钮的位置，以防误触

### 修复

- 在长时间的会话中，语音模式不再逐渐误检测到语音
- 计划卡片上文字重叠错乱
- 使用 git worktree 时，Changes 窗格可能显示过时的 diff
- 快速重启 Agent 可能导致会话崩溃
- 在 autopilot 模式下 Copilot 不再因权限提示而暂停
- 连接和配对对话框现在在平板上正确显示
- Agent 的编排错误现在会显示出来，而不是静默丢失
- 重新连接时 diff 统计不再归零

## 0.1.49 - 2026-04-07

### 修复

- 模型和 Provider 现在在首次连接时可靠地加载，无需手动刷新
- 模型选择器只显示 Agent 自身 Provider 的模型，而不是服务器上所有 Provider 的模型
- 无论先打开哪个屏幕，模型列表都保持一致

## 0.1.48 - 2026-04-05

### 新增

- Provider 诊断——在 Settings 中点击某个 Provider，即可一目了然地查看二进制路径、版本、模型数量和状态。有助于排查某种 Agent 类型为何不可用
- Provider 快照系统——daemon 现在会把实时的 Provider 可用性和模型列表推送给应用，取代旧的轮询方式。Provider 上线或下线时，模型和模式会实时更新
- Codex 问题处理——Codex Agent 现在可以在会话中途向用户提问（例如“哪个文件？”）并行内接收回答，与 Claude Code 的问题流程一致
- 重新加载标签页操作——右键点击工作区标签页即可重新加载其 Agent 列表，无需重启应用

### 改进

- 重新设计了模型选择器——按 Provider 分组并带有状态徽标、搜索，以及移动端更好的触控目标
- Enter 键现在可以提交问题卡片的回答并确认语音输入，符合预期的键盘流程
- 移除了在每次状态变化时都会弹出的嘈杂的 Agent 生命周期提示

### 修复

- 桌面应用现在会在启动时解析用户完整的登录 shell 环境，修复了从 Finder 或 Dock 启动 Paseo 时找不到 `codex`、`node`、`bun` 和 `direnv` 等工具的问题。由 Paseo 创建的终端现在继承与普通终端会话相同的 PATH 和环境变量。做法借鉴自 VS Code 久经考验的 shell 环境解析
- 运行中的 Agent 屏幕上的输入框现在可以正确获得键盘焦点
- 移动端模型选择器的对齐和尺寸

## 0.1.47 - 2026-04-05

### 修复

- Electron 中的语音 TTS——sherpa 现在请求复制的缓冲区，语音 MCP 桥接会设置 `ELECTRON_RUN_AS_NODE`，避免出现“external buffers not allowed”崩溃
- 桌面端的二维码配对——CLI JSON 输出解析现在能容忍 stdout 中的 Node 弃用警告
- STT 片段竞态——在异步转写调用之前对片段 ID 和音频缓冲区做快照，因此快速提交不再交错
- 移除了按主机的“Add connection”按钮——它把新连接限定在单个服务器上，阻碍了多主机设置

## 0.1.46 - 2026-04-04

### 修复

- 打包构建中的语音激活——Silero VAD 模型现在会从 Electron asar 归档中复制出来，以便原生代码读取
- 探测客户端的 hello 中会发送应用版本，因此 daemon 的版本门控不再在重新连接的会话中隐藏 Pi/Copilot
- `worktreeRoot` 架构改为向后兼容，适配不发送该字段的旧客户端和 daemon
- 在 CLI 和桌面 daemon 入口中屏蔽了 Punycode 弃用警告（DEP0040）

## 0.1.45 - 2026-04-04

### 新增

- Pi (pi.dev) Agent Provider——把 Pi 作为新的 Agent 类型连接，支持思考级别和工具调用
- 在修复 ACP 兼容性后重新启用了 Copilot Agent Provider
- `paseo .` 和 `paseo <path>` 会用指定的项目打开桌面应用，类似于 `code .`
- Provider 声明的功能系统——Provider 可以暴露动态的开关和选项，应用会自动渲染它们。首个使用者：Codex fast 模式
- Codex 计划模式——以仅计划模式启动 Agent，并通过专用的计划卡片界面在执行前审查拟议的更改
- OpenCode 自定义 Agent 和斜杠命令——opencode.json 中用户定义的 Agent 现在会出现在模式选择器中，斜杠命令接受可选参数
- 桌面端 Integrations 设置——直接在应用中安装 Paseo CLI 和编排技能，无需动用终端
- 桌面设置中的 daemon 状态对话框，用于快速检查运行状况
- 版本不匹配时自动重启 daemon——桌面应用会检测到运行中的 daemon 已过时并自动重启它
- 移动端欢迎屏幕上的设置提示和 paseo.sh 链接，让新的 App Store 用户知道下一步该做什么

### 改进

- 桌面端启动更快——已有的 daemon 连接会与引导过程竞速，让应用更早可用
- 重新排列了设置分区，分组更合理（集成和 daemon 放在一起）
- 侧边栏的项目和工作区现在会跨会话保留，并提供移除项目的上下文菜单

### 修复

- 切换 iOS 主题时侧边栏崩溃（Unistyles/Reanimated 交互问题）
- CircularBuffer 中的外部缓冲区模式导致的 Silero VAD 崩溃
- 批量关闭现在会正确归档已存储的 Agent，而不会留下孤儿
- 关闭标签页时，已固定的已归档 Agent 不再被清理
- 执行斜杠命令期间 OpenCode 事件流饥饿
- 多个 git worktree 共享同一根目录时出现重复的工作区
- 对于登录 shell 设置了不同 PATH 的桌面用户，`gh` 可执行文件的解析
- Agent 创建超时增加到 60 秒，以应对首次启动较慢的情况
- 前向兼容的 Provider 处理，旧版应用客户端遇到新的 Provider 类型不会出错
- Web 滚动条 hook 中输入事件监听器的竞态
- 打开项目屏幕的内容现在垂直居中
- 网站下载页面在运行时获取发布版本并校验资源，修复了过时的链接

## 0.1.44 - 2026-04-03

### 修复

- 桌面应用现在会在自动更新重启之前干净地停止 daemon
- 从 Agent 注册表中停用了 claude-acp 和 copilot Provider
- 键盘焦点作用域解析现在会检查多个候选，以获得更广泛的兼容性
- OpenCode 中断现在与工具调用流程一样达到正确的终止状态
- 针对 shell 注入、符号链接逃逸和配对端点的安全加固

## 0.1.43 - 2026-04-02

### 新增

- 通过 ACP 基础 Provider 支持 Copilot Agent——把 GitHub Copilot 作为新的 Agent 类型连接
- 可搜索的模型收藏——快速找到并固定常用的模型
- OpenCode Agent 支持斜杠命令

### 改进

- 打磨了模型选择器的体验，移动端底部面板的表现更好
- 工作区状态现在用琥珀色提醒样式表示“需要输入”状态
- 消息输入框使用带主题的滚动条，样式保持一致

### 修复

- 在 Windows 和 Linux 上，终端中的 Ctrl+C/V 复制粘贴现在可以正常工作
- 在 Windows 上，带空格的 shell 参数现在会被正确加引号
- 现在可以正确报告支持 1M 上下文的 Claude 模型

## 0.1.42 - 2026-04-01

### 修复

- 修复了 Claude Code 安装在带空格的路径（例如 `C:\Program Files\...`）时在 Windows 上无法启动的问题

## 0.1.41 - 2026-04-01

### 修复

- 修复了 Windows 上创建 Agent 的问题——所有 Provider（Claude、Codex、OpenCode）现在都使用 shell 模式，因此 npm 包装脚本和 `.cmd` 包装可以正确解析
- 修复了 Windows 上创建终端时默认使用 Unix shell 而不是 `cmd.exe` 的问题
- 修复了整个应用的路径处理，以支持 Windows 驱动器盘符路径（`C:\...`）和 UNC 路径（`\\...`）
- 修复了 Windows 上的可执行文件解析，使其能配合 `nvm4w` 等 Node 版本管理器使用
- 通过把原生窗口背景色设置为与主题一致，消除了深色模式下调整窗口大小时的白色闪烁
- 修复了标题栏拖动区域——用 VS Code 久经验证的静态 CSS `app-region: drag` 模式取代了脆弱的指针事件做法
- 修复了整个桌面应用中复制/粘贴的上下文菜单
- 修复了快捷键重新绑定界面，使其显示按住的修饰键并识别更多按键（Tab、Delete、Home、End、Page Up/Down、Insert、F1–F12）
- 移除了活动时间线输出的 40 项上限，长时间的 Agent 会话可以显示完整的历史

### 改进

- 改进了浅色模式的主题，提供专用的工作区背景、滚动条滑块颜色和更浅的阴影
- Windows/Linux 上的窗口控件覆盖层高度从 48px 降到 29px，标题栏更紧凑

## 0.1.40 - 2026-04-01

### 新增

- 现在可以批量关闭工作区标签页

### 改进

- Provider 模型列表现在按服务器和 Provider 缓存，减少了界面中多余的模型查找

### 修复

- OpenCode 的推理内容不再以重复的助手文本出现
- Codex 二进制缺失或启动失败时 daemon 不再崩溃
- 归档后，归档标签页现在会正确地协调 Agent 的可见性
- 在 Linux 上，工作区中的文件 diff 跟踪现在可以正常工作
- iPad 布局在桌面模式下可以正确渲染
- macOS 自动更新现在能正确提供 arm64 和 x64 两种二进制——之前最后构建完成的架构会覆盖另一个架构的更新清单

## 0.1.39 - 2026-03-30

### 新增

- **从 CLI 管理终端**——新的 `paseo terminal` 命令组让你无需离开终端即可列出、创建工作区终端并与之交互
- **资源管理器中的 Material 文件图标**——文件浏览器树现在显示特定语言的图标（TypeScript、JSON、Markdown 等），让你一眼认出文件

### 修复

- 修复了多余的溢出裁剪导致的 iOS 侧边栏滚动闪烁
- 把窗口控件的内边距集中到共享的 hook 中，消除了不同平台之间的布局不一致

## 0.1.38 - 2026-03-30

### 修复

- 修复了 daemon 启动竞态：由于 PID 文件在服务器就绪之前就公布了监听地址，应用在首次启动时可能连接超时
- 修复了 daemon 日志轮转丢失启动跟踪的问题——trace 级别的 WebSocket 日志不再包含完整的消息负载

## 0.1.37 - 2026-03-29

### 新增

- Windows 和 Linux 上的自定义窗口控件——原生标题栏被替换为与应用设计一致的覆盖层控件
- 使用 electron-log 的桌面端文件日志，便于调试 daemon 和应用问题

### 修复

- 修复了 Windows 上 PATH 传递失效和 Claude 二进制解析的问题
- 语音输入出错时现在会显示可见的提示，而不是静默失败

## 0.1.36 - 2026-03-27

### 修复

- 修复了整个代码库中 Windows 驱动器盘符路径的处理
- 修复了过时的 Nix 哈希，并自动检测 lockfile 的变更

### 新增

- 新增了指标收集和终端性能测试

## 0.1.35 - 2026-03-26

### 改进

- 应用启动更快：立即跳转到欢迎屏幕，并行内显示主机连接状态
- Codex 删除文件现在在 diff 中正确显示为被删除的行
- OpenCode 的问题现在会在权限界面中显示

### 修复

- 修复了转为空闲后排队提示词的派发
- 在 chat 脚本中用可移植的 `while-read` 循环取代了仅限 bash 的 `mapfile`

### 新增

- 新增了对 Nix 和 NixOS 安装的支持

## 0.1.34 - 2026-03-25

### 新增

- 新增 `paseo archive`，作为 `paseo agent archive` 的顶层别名
- 为 Claude 和 Codex Agent 新增 `PASEO_AGENT_ID` 环境变量
- 新增重新设计的命令自动补全，带有详情卡片和下拉样式
- 把 Android 下载入口链接到 Google Play 商店

### 改进

- 自主回合在被中断时现在会妥善完成，而不是被取消
- 思考/模型选择现在总是解析为一个真实的选项，而不是显示通用的 Default 选项
- 恢复了按 Provider 的表单偏好，并移除了 Auto 模型回退
- 改进了 Codex 活动日志，工具调用摘要更清晰
- 减少了 Agent 面板和输入区域中不必要的重新渲染，交互更流畅
- 提高了聊天记录的可读性

### 修复

- 修复了 `paseo send --no-wait` 不生效的问题
- 修复了中断后过时的中止结果污染替换回合的问题
- 修复了 Claude 中断处理和自主唤醒的可靠性
- 修复了嵌套 Claude Code 会话的检测和 Provider 可用性检查
- 修复了跨面板的 Agent 输入焦点作用域
- 修复了订阅时终端快照的顺序
- 修复了 `chat read --since`，使其接受消息 ID
- 修复了键盘窗格焦点与当前面板的同步
- 修复了 Web 上的助手文本选择
- 修复了已归档 Agent 的通知仍出现在聊天室中的问题
- 修复了消息 Composer 中附加图片按钮的交互
- 从 Electron 桌面构建中剔除了其他平台的原生二进制

## 0.1.33 - 2026-03-23

### 修复

- 修复了 macOS 上桌面应用关闭后无法重新打开的问题——daemon 和 Agent 进程以主应用实例的身份注册到 Launch Services，阻止了后续启动
- 修复了打包的桌面应用中语音输入无法使用的问题——hardened runtime 配置中缺少麦克风权限
- 修复了关闭 Agent 时 Claude Code 子进程泄漏的问题——SDK 查询流没有被正确关闭
- 通知测试按钮现在会显示错误，而不是静默失败

## 0.1.32 - 2026-03-23

### 新增

- 支持组合键的完全可重新绑定的键盘快捷键——所有快捷键现在都是声明式的，并正确区分 Cmd（Mac）和 Ctrl（Windows/Linux）
- 把桌面应用从 Tauri 迁移到 Electron，支持 macOS 公证、代码签名和 Linux Wayland
- 为文件预览新增行号和自动换行开关
- 新增已归档 Agent 提示，带有取消归档按钮，可以直接在聊天视图中恢复 Agent
- 在侧边栏中新增工作区类型标识（例如 worktree 与独立工作区）
- 把 diff 语法高亮扩展到更多语言
- 为项目和 Agent 状态新增状态栏提示

### 改进

- 把移动端标签页切换器重新设计为紧凑的标题行，可快速创建新 Agent 和终端
- 简化了工作区创建——worktree 现在通过一个操作行内创建，而不是多步流程
- 重新连接时 Agent 历史从磁盘流式加载，因此你会立即看到过去的消息，而不是空白屏幕
- 自动清理过时的工作区：已删除的 worktree 目录和完全归档的工作区会被自动清理
- 归档工作区后，应用现在会跳转到下一个可用的工作区，而不是让你停留在失效的屏幕上
- 重新打开已归档的 Agent 标签页现在会保持打开，而不是折叠回已归档状态
- 减少了工作区屏幕、侧边栏和 Agent 列表中不必要的重新渲染，滚动和交互更流畅
- 屏幕失去焦点时 Agent 列表不再在后台刷新，节省资源
- 桌面端按键重复在 macOS 上现在可以正常工作
- macOS 上的桌面通知更可靠
- daemon 启动不再被模型下载阻塞
- daemon 的错误消息更好——RPC 错误现在包含实际的底层细节

### 修复

- 修复了消息包含结构化内容块时，用户消息在时间线中显示为助手输出的问题
- 修复了已归档工作区的路由，导航到已归档的会话不再导致应用出错
- 修复了 Linux AppImage 在仅支持 Wayland 的桌面上无法启动的问题
- 修复了在不应应用时仍应用桌面窗口拖动坐标的问题

## 0.1.30 - 2026-03-19

### 新增

- 新增终端标签页、拆分窗格控件以及工作区布局的拖放预览
- 在主要界面中新增合并的模型选择器和 Agent 模式视觉效果
- 改进了 Open Graph 元数据，网站分享预览更丰富

### 改进

- 改进了工作区导航，更好地跟踪当前工作区，并支持键盘驱动的窗格交互
- 改进了终端滚动条行为、窗格焦点处理以及状态栏与消息输入框的间距
- 改进了项目选择器的路径显示，并整体打磨了工作区界面

### 修复

- 通过收紧 PATH 解析并在状态中显示缺失的 Provider 二进制，修复了 Agent 启动的可靠性
- 修复了工作区路由同步、拖动命中区域以及 git diff 面板标题样式的回归
- 修复了网站在移动端的水平滚动，并确保工作区音频模块在 EAS 安装期间能够构建

## 0.1.28 - 2026-03-15

### 新增

- 新增 OpenCode 的 build 和 plan 模式
- 新增 Claude Code、Codex 和 OpenCode 的网站落地页

### 改进

- 改进了 git 操作菜单，仓库操作更可靠
- 改进了移动端设置屏幕、工作区标题栏操作和欢迎屏幕的呈现
- 更新了网站首屏文案，并新增了赞助提示区域

### 修复

- 修复了助手文件链接，使其能从聊天中打开正确的工作区文件

## 0.1.27 - 2026-03-13

### 新增

- 新增语音运行时，采用新的音频引擎架构来支持语音交互
- 在 Claude 工具调用映射中新增 Grep 工具支持
- 新增直接从 Agent 聊天消息中打开工作区文件的功能
- 通过自定义原生桥接新增桌面通知

### 改进

- 改进了图片选择器、markdown 渲染和界面交互
- 使用 shell-env 改进了 shell 环境检测

### 修复

- 修复了特定平台的 markdown 链接渲染
- 修复了 Linux AppImage 的 CLI 资源路径
- 修复了 Codex 替换流被过时的回合通知终止的问题

## 0.1.26 - 2026-03-12

### 新增

- 新增桌面端单实例行为、Android APK 下载入口，并刷新了启动屏幕样式
- 在服务端内置 Codex 和 OpenCode 二进制，安装不再依赖全局安装
- 新增 Windows 支持，改进了跨平台的 shell 执行

### 改进

- 改进了 Windows 上的桌面运行时行为：隐藏控制台窗口，并把应用数据默认放在 `~/.paseo`
- 在网站导航中新增了 Discord 链接

### 修复

- 修复了从托管运行时启动桌面端 Claude Agent 的问题，并在重启时正确轮转日志
- 修复了主页路由，使其在适当时隐藏浏览器界面
- 通过更新 `exclusionList` 的导入修复了 Expo Metro 兼容性
- 修复了嘈杂的 shell 输出干扰可执行文件查找的问题
- 通过去除扩展长度路径前缀修复了 Windows 资源路径的处理

## 0.1.25 - 2026-03-11

### 修复

- 修复了在全新安装的 macOS 上桌面应用无法启动内置 daemon 的问题。DMG 未经公证，并且代码签名去除了内置 Node 运行时的权限，导致 Gatekeeper 阻止其执行
- 通过恢复 AppImage 打包格式并去除 onnxruntime 的 CUDA 依赖，修复了 Linux AppImage 构建

## 0.1.24 - 2026-03-10

### 改进

- 改进了命令中心的键盘导航和新建标签页快捷键
- 简化了桌面端发布流水线，构建更快、更可靠

## 0.1.21 - 2026-03-10

### 改进

- 通过修复 GitHub Actions 发布期间 Windows 托管运行时的构建路径，提高了桌面端发布的可靠性

### 修复

- 修复了 Windows 运行器上仅限 Unix 的服务端构建脚本导致的桌面端发布 CI 失败
- 修复了服务端 CI，使其在运行测试之前构建中继依赖，在干净的运行器上恢复了中继 E2EE 测试覆盖
- 修复了一个依赖本地安装 Claude CLI 的 Claude 重新设计测试

## 0.1.20 - 2026-03-10

### 新增

- 新增工作区侧边栏的 git 操作，带有快速 diff 统计和归档控件
- 为桌面端安装刷新了网站下载页和主页呈现

### 改进

- 桌面端发布打包现在会在 CI 期间重新构建并校验内置的托管运行时，提高了 macOS 用户安装程序的可靠性
- 改进了桌面端和 Web 的流式渲染、设置细节，以及与 React 19.1.4 的兼容性

### 修复

- 修复了 Claude 中断/重启的回归，并加强了桌面端发布中托管 daemon 的冒烟测试覆盖

## 0.1.19 - 2026-03-09

### 新增

- 新增 GitHub 草稿发布流程，维护者可以在发布最终版本之前上传并审查桌面端和 Android 发布资源

## 0.1.18 - 2026-03-06

### 新增

- 新增桌面端 `Mod+W` 快捷键，用于关闭当前标签页

### 改进

- 新建和新选中的终端现在会自动获得焦点，你可以立即输入
- 新创建的工作区和项目在侧边栏中保持更稳定的顺序
- 改进了 GitHub 远程仓库的项目命名，并把项目图标的查找扩展到 Phoenix 的 `priv/static` 资源
- 更新了网站的桌面端下载链接，改用 macOS 通用 DMG

### 修复

- 恢复了 Claude 运行时自动生成 Agent 元数据

## 0.1.17 - 2026-03-06

### 新增

- 新的以工作区为先的导航模型，提供工作区标签页、文件标签页和可排序的标签页组
- 工作区和标签页导航的键盘快捷键，侧边栏中显示快捷键徽标
- 工作区级别的归档操作，改进了 worktree 归档流程并支持上下文菜单
- 聊天中的任务通知以合成的工具调用事件渲染，状态跟踪更清晰

### 改进

- 桌面构建现在以 macOS 通用二进制（Apple Silicon + Intel）发布
- 在刷新和深层链接之间，工作区路由和标签页标识的处理更可靠
- 侧边栏的拖放行为更好，提供明确的拖动手柄和嵌套列表交互
- 终端/文件渲染更流畅，并通过 WebGL 提升了终端性能
- 更好地显示 Provider 错误，并更新了 Claude 模型/运行时的处理

### 修复

- 修复了非规范的标签页路由导致的孤儿工作区运行
- 修复了移动端终端标签页重新挂载/路由恢复的问题
- 修复了 Agent 元数据标题/分支更新的可靠性
- 修复了应用中流/时间线顺序和光标同步的问题
- 修复了聊天/工具流视图中边缘滚轮滚动方向相反的问题

## 0.1.16 - 2026-02-22

### 新增

- 直接在 Settings 中更新 Paseo 桌面应用和本地 daemon
- Settings 中的麦克风和通知权限控件
- 思考/推理模式——当 Provider 支持时，Agent 可以使用扩展思考
- 自主运行模式——让 Agent 持续工作，无需在每一步手动审批
- `paseo wait` 现在会在等待期间显示 Agent 最近活动的快照

### 改进

- 在长时间的 Agent 运行期间流式输出更流畅，界面闪烁和滚动跳动更少
- Agent 侧边栏列表渲染更快
- 归档 Agent 现在会先停止它，而不是归档一个运行到一半的会话
- 刷新时 Agent 标题不再被重置
- 中继连接更可靠

### 修复

- 修复了 Claude 后台任务导致聊天不同步的问题
- 修复了时间线中出现重复用户消息的问题
- 修复了 OpenCode SDK 更新导致的启动崩溃
- 修复了后台 Agent 活动引发的虚假“需要关注”通知

## 0.1.15 - 2026-02-19

### 新增

- 在网站上新增公开的更新日志页面，用户可以浏览发布说明

### 改进

- 把网站的入门体验重新设计为更清晰的两步流程
- 简化了网站的 GitHub 导航和更新日志标题
- 改进了应用的草稿/新 Agent 体验，工作目录占位符和空状态提示更清晰
- 在桌面端草稿屏幕上之前未处理的区域启用了拖动交互
- 在左侧边栏中隐藏了空的筛选分组

### 修复

- 通过把已归档 Agent 的路由重定向到草稿，修复了已归档 Agent 的导航
- 修复了重复的 `/rewind` 用户消息行为

## 0.1.14 - 2026-02-19

### 新增

- 新增对 Claude `/rewind` 命令的支持
- 在草稿 Agent 的 Composer 中新增斜杠命令入口
- 在聊天提示词中新增 `@` 工作区文件自动补全
- 新增把图片直接粘贴到提示词附件中的支持
- 为待发送用户消息的附件新增乐观的图片预览
- 新增桌面端/Web 共享的覆盖式滚动手柄，包括文件预览窗格

### 改进

- 改进了交付后的 worktree 流程，包括更好的已合并 PR 检测
- 选择 CWD 后立即启用资源管理器侧边栏，改进了草稿工作流
- 把 CWD 预填为主仓库，改进了新 worktree Agent 的默认值
- 改进了桌面端命令自动补全的行为，使其与组合框交互一致
- 改进了 git 同步体验：简化了同步标签，并且只在分支与 origin 分叉时显示 Sync
- 改进了桌面端的设置和权限体验
- 改进了 Web/桌面端滚动条的可见性、拖动交互、跟踪和动画时序

### 修复

- 修复了 worktree 归档/设置的生命周期问题，包括终端清理和归档时机
- 通过对 CWD 取哈希来生成不冲突的 worktree 根目录，修复了 worktree 路径冲突
- 修复了切换回 Agent 会话时的终端尺寸
- 为运行中的 shell 命令添加确认，修复了误关终端的风险
- 修复了侧边栏和 Agent 屏幕之间归档加载状态的一致性
- 修复了自动补全弹出框的稳定性和工作区建议的排序
- 修复了悬而未决的非最终片段导致的语音输入超时
- 通过使用父进程 PID 归属，修复了作为子进程启动时服务器锁的归属问题
- 修复了服务器 CWD 建议中泄漏隐藏目录的问题
- 修复了不同 Provider 之间 Agent 提醒通知负载的一致性
- 修复了 daemon 版本数据不可用时设置中 daemon 版本徽标的可见性

## 0.1.9 - 2026-02-17

### 改进

- 通过单一共享的架构校验和重试流水线统一了结构化输出的生成
- 在结构化生成的回退选择中复用了 Provider 可用性检查
- 为内部元数据和 git 文本生成新增了结构化生成的瀑布顺序：先 Claude Haiku，然后 Codex，最后 OpenCode

### 修复

- 修复了 CLI `run --output-schema`，使其使用共享的结构化输出路径，而不是临时的 JSON 解析
- 修复了 Provider 返回空 `lastMessage` 时 `run --output-schema` 失败的问题，改为从时间线的助手输出中恢复
- 修复了内部提交信息、拉取请求文本和 Agent 元数据的生成，使其遵循同一个一致的结构化流水线

## 0.1.8 - 2026-02-17

### 新增

- 为 daemon 重启新增跨平台的确认对话框流程

### 改进

- 简化了本地语音的引导和 daemon 启动锁的行为
- 更新了网站首屏文案，强调本地执行

### 修复

- 修复了应用和服务端会话处理中卡住的“运行时发送”恢复
- 修复了重新加载已有 Agent 时 Claude 会话身份的保留
- 修复了组合框选项的行为及相关交互
- 修复了桌面端文件拖放监听器的清理，避免未捕获的取消监听错误
- 修复了 Web 工具详情在滚动边缘的滚轮事件路由

## 0.1.7 - 2026-02-16

### 新增

- 改进了 Agent 工作区流程，目录建议更好
- 在网站上新增 iOS TestFlight 和 Android 应用的访问申请表单

### 改进

- 统一了开发路径和 CLI 路径的 daemon 启动行为，本地运行更可预测
- 改进了网站的应用下载和更新指引

### 修复

- 避免了桌面端组合框初次出现时在 `0,0` 位置闪烁
- 修复了 CLI 版本输出的问题
- 加固了服务端运行时对本地语音依赖的加载

## 0.1.6 - 2026-02-16

### 说明

- 此补丁版本没有明显的产品变化

## 0.1.5 - 2026-02-16

### 新增

- 新增终端重新附加支持，改进了 worktree 终端的处理
- 在应用中新增全局键盘快捷键帮助
- 新增侧边栏按主机筛选，改进了 Agent 工作流控件

### 改进

- 通过流式显示设置进度，提高了 worktree 设置的可见性
- 改进了终端流式输出的可靠性和生命周期处理
- 保留资源管理器标签页状态，导航时上下文保留得更好

## 0.1.4 - 2026-02-14

### 新增

- 在客户端新增语音能力状态报告
- 新增后台下载本地语音模型，并按运行时进行门控
- 根据服务器提供的预算新增自适应的语音输入结束时机
- 新增带宽限期的中继重新连接行为和分支建议

### 改进

- 提高了连接选择和 Agent 数据加载的可靠性
- 通过基于游标的获取改进了时间线加载
- 通过引导默认的 localhost 连接改进了首次运行体验
- 通过自动把 URL 转为链接改进了行内代码的渲染

### 修复

- 修复了 Linux 检出 diff 的监视行为，避免递归监视
- 修复了过时的中继客户端计时器行为
- 修复了折叠时不必要的 git diff 标题自动滚动

## 0.1.3 - 2026-02-12

### 新增

- 新增 CLI 引导命令
- 新增 CLI `--output-schema` 支持，用于结构化的 Agent 输出
- 新增 CLI 对 Agent 元数据中名称和标签的更新支持
- 新增 Provider 可用性检测，并规范化旧的默认模型 ID

### 改进

- 改进了文件浏览器的刷新反馈和未解析检出的回退处理
- 通过语音开始的宽限期改进了语音中断的处理
- 改进了 CLI 默认值，默认列出所有未归档的 Agent
- 改进了网站体验，安装引导更清晰，并可访问隐私政策

### 修复

- 修复了开发运行器入口的问题和 sherpa TTS 的初始化行为

## 0.1.2 - 2026-02-11

### 说明

- 此补丁版本没有明显的产品变化

## 0.1.1 - 2026-02-11

### 新增

- 首个 `0.1.x` 发布系列
