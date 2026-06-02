import type { TranslationResources } from "./en";

export const zhCN: TranslationResources = {
  common: {
    back: "返回",
    loading: "加载中...",
    actions: {
      back: "返回",
      close: "关闭",
      dismiss: "关闭",
      search: "搜索",
    },
    states: {
      loading: "加载中...",
      starting: "正在开始...",
      downloadComplete: "下载完成",
      downloadFailed: "下载失败",
    },
  },
  shell: {
    menu: {
      toggleSidebar: "切换侧边栏",
      open: "打开菜单",
      close: "关闭菜单",
    },
    commandCenter: {
      placeholder: "输入命令或搜索 Agent...",
      noMatches: "没有匹配项",
      actions: "操作",
      agents: "Agents",
      newAgent: "新建 Agent",
    },
  },
  composer: {
    placeholders: {
      desktop: "给 Agent 发消息，标记 @files，或使用 /commands 和 /skills",
      mobile: "发消息，@files，/commands",
      fallback: "输入消息...",
    },
    input: {
      accessibilityLabel: "给 Agent 发消息...",
      focusHint: "{{shortcut}} 聚焦",
      addAttachment: "添加附件",
      interruptAgent: "中断 Agent",
      queueMessage: "消息排队",
      sendAndInterrupt: "发送并中断",
      sendMessage: "发送消息",
      queue: "排队",
      send: "发送",
    },
    cancel: {
      cancelingAgent: "正在取消 Agent",
      stopAgent: "停止 Agent",
      interrupt: "中断",
    },
    voice: {
      enableVoiceMode: "启用语音模式",
      voiceMode: "语音模式",
      unmuteVoiceMode: "取消静音语音模式",
      muteVoiceMode: "静音语音模式",
      stopDictation: "停止听写",
      startDictation: "开始听写",
      unmuteVoice: "取消静音",
      muteVoice: "静音",
      dictation: "听写",
      interruptBeforeVoice: "启动语音模式前请先中断 Agent",
    },
    attachments: {
      addImage: "添加图片",
      addIssueOrPr: "添加 issue 或 PR",
      editQueuedMessage: "编辑排队消息",
      sendQueuedMessageNow: "立即发送排队消息",
      openImage: "打开图片附件",
      removeImage: "移除图片附件",
      openGithub: "打开 {{kind}} #{{number}}",
      removeGithub: "移除 {{kind}} #{{number}}",
    },
    github: {
      searching: "正在搜索...",
      noResults: "没有结果。",
      searchPlaceholder: "搜索 issues 和 PRs...",
      title: "附加 issue 或 PR",
    },
  },
  agentControls: {
    provider: {
      fallback: "Provider",
      select: "选择 Agent Provider",
    },
    thinking: {
      title: "Thinking",
      unknown: "未知",
      select: "选择 thinking 选项",
      selectWithValue: "选择 thinking 选项（{{value}}）",
    },
    model: {
      unknown: "未知 Model",
    },
    features: {
      title: "Features",
      open: "打开 Agent features",
      on: "开启",
      off: "关闭",
    },
    mode: {
      title: "Mode",
      searchPlaceholder: "搜索 modes...",
      selectWithValue: "选择 Agent mode（{{value}}）",
    },
    hints: {
      thinking: "Thinking mode",
      model: "切换 Model",
      mode: "切换权限 Mode",
    },
  },
  agentStream: {
    empty: "开始和这个 Agent 对话...",
    scrollToBottom: "滚动到底部",
    permission: {
      plan: "Plan",
      required: "需要权限",
      deny: "拒绝",
      accept: "接受",
      implement: "实施",
      question: "你想如何继续？",
      proposedPlan: "建议计划",
    },
  },
  agentPanel: {
    states: {
      notFound: "未找到 Agent",
      failedToLoad: "加载 Agent 失败",
      reconnecting: "正在重连...",
      archivingTitle: "正在归档 Agent...",
      archivingSubtitle: "请稍候，我们正在归档这个 Agent。",
    },
    unavailable: {
      selectedHost: "选中的 Host",
      unknownHost: "无法打开此 Agent，因为此设备上未配置 {{serverLabel}}。",
      addHost: "请在设置中添加 Host，或打开已配置 server 上的 Agent 后继续。",
      preparingSession: "正在准备 {{serverLabel}} 会话...",
      connecting: "正在连接 {{serverLabel}}...",
      showSoon: "稍后将显示此 Agent。",
      showWhenOnline: "Host 在线后将显示此 Agent。",
      reconnectingTo: "正在重新连接 {{serverLabel}}...",
      showAgainWhenReachable: "Host 可访问后将再次显示此 Agent。",
    },
  },
  panels: {
    draft: {
      newAgent: "新建 Agent",
      creatingAgent: "正在创建 Agent",
    },
  },
  settings: {
    title: "设置",
    loading: "正在加载设置...",
    groups: {
      app: "应用",
      host: "主机",
    },
    hostPicker: {
      switchHost: "切换主机",
      local: "本机",
    },
    backToWorkspace: "返回",
    addHost: "添加主机",
    projects: "项目",
    sections: {
      general: "通用",
      daemon: "Daemon",
      appearance: "外观",
      shortcuts: "快捷键",
      integrations: "集成",
      permissions: "权限",
      diagnostics: "诊断",
      about: "关于",
    },
    hostSections: {
      connections: "连接",
      agents: "Agents",
      workspaces: "Workspaces",
      providers: "Providers",
      host: "Host",
    },
    general: {
      title: "通用",
      defaultSend: {
        label: "默认发送",
        description: "Agent 运行时按 Enter 的行为",
        options: {
          interrupt: "中断",
          queue: "排队",
        },
      },
      serviceUrls: {
        label: "服务 URL",
        description: "运行脚本中的 URL 打开位置",
        options: {
          ask: "询问",
          inApp: "在 Paseo 中",
          external: "外部浏览器",
        },
      },
      terminalScrollback: {
        label: "终端回滚",
        description: "内置终端缓冲区保留的行数",
        accessibilityLabel: "终端回滚行数",
      },
      language: {
        label: "语言",
        description: "应用语言",
        options: {
          system: "系统",
          en: "English",
          zhCN: "简体中文",
        },
      },
    },
  },
};
