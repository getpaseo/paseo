export const en = {
  common: {
    back: "Back",
    loading: "Loading...",
    actions: {
      back: "Back",
      close: "Close",
      dismiss: "Dismiss",
      search: "Search",
    },
    states: {
      loading: "Loading...",
      starting: "Starting...",
      downloadComplete: "Download complete",
      downloadFailed: "Download failed",
    },
  },
  shell: {
    menu: {
      toggleSidebar: "Toggle sidebar",
      open: "Open menu",
      close: "Close menu",
    },
    commandCenter: {
      placeholder: "Type a command or search agents...",
      noMatches: "No matches",
      actions: "Actions",
      agents: "Agents",
      newAgent: "New agent",
    },
  },
  settings: {
    title: "Settings",
    loading: "Loading settings...",
    groups: {
      app: "App",
      host: "Host",
    },
    hostPicker: {
      switchHost: "Switch host",
      local: "Local",
    },
    backToWorkspace: "Back",
    addHost: "Add host",
    projects: "Projects",
    sections: {
      general: "General",
      daemon: "Daemon",
      appearance: "Appearance",
      shortcuts: "Shortcuts",
      integrations: "Integrations",
      permissions: "Permissions",
      diagnostics: "Diagnostics",
      about: "About",
    },
    hostSections: {
      connections: "Connections",
      agents: "Agents",
      workspaces: "Workspaces",
      providers: "Providers",
      host: "Host",
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

type WidenStringLeaves<T> = {
  [K in keyof T]: T[K] extends string ? string : WidenStringLeaves<T[K]>;
};

export type TranslationResources = WidenStringLeaves<typeof en>;
