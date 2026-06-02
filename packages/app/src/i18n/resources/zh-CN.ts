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
