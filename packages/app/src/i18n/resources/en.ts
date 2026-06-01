export const en = {
  common: {
    back: "Back",
    loading: "Loading...",
  },
  settings: {
    title: "Settings",
    loading: "Loading settings...",
    groups: {
      app: "App",
      host: "Host",
    },
    backToWorkspace: "Back",
    addHost: "Add host",
    projects: "Projects",
    sections: {
      general: "General",
      appearance: "Appearance",
      shortcuts: "Shortcuts",
      integrations: "Integrations",
      permissions: "Permissions",
      diagnostics: "Diagnostics",
      about: "About",
    },
    hostSections: {
      connections: "Connections",
      orchestration: "Orchestration",
      providers: "Providers",
      daemon: "Daemon",
    },
    general: {
      title: "General",
      defaultSend: {
        label: "Default send",
        description: "What happens when you press Enter while the agent is running",
        options: {
          interrupt: "Interrupt",
          queue: "Queue",
        },
      },
      serviceUrls: {
        label: "Service URLs",
        description: "Where to open URLs from running scripts",
        options: {
          ask: "Ask",
          inApp: "In Paseo",
          external: "External browser",
        },
      },
      terminalScrollback: {
        label: "Terminal scrollback",
        description: "Lines kept in the built-in terminal buffer",
        accessibilityLabel: "Terminal scrollback lines",
      },
      language: {
        label: "Language",
        description: "App language",
        options: {
          system: "System",
          en: "English",
          zhCN: "Simplified Chinese",
        },
      },
    },
  },
} as const;

export type TranslationResources = typeof en;
