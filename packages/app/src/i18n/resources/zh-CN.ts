import type { TranslationResources } from "./en";

export const zhCN: TranslationResources = {
  common: {
    back: "返回",
    loading: "加载中...",
  },
  settings: {
    title: "设置",
    loading: "正在加载设置...",
    groups: {
      app: "应用",
      host: "主机",
    },
    backToWorkspace: "返回",
    addHost: "添加主机",
    projects: "项目",
    sections: {
      general: "通用",
      appearance: "外观",
      shortcuts: "快捷键",
      integrations: "集成",
      permissions: "权限",
      diagnostics: "诊断",
      about: "关于",
    },
    hostSections: {
      connections: "连接",
      orchestration: "编排",
      providers: "Provider",
      daemon: "Daemon",
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
