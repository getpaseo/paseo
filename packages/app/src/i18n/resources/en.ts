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
  composer: {
    placeholders: {
      desktop: "Message the agent, tag @files, or use /commands and /skills",
      mobile: "Message, @files, /commands",
      fallback: "Message...",
    },
    input: {
      accessibilityLabel: "Message agent...",
      focusHint: "{{shortcut}} to focus",
      addAttachment: "Add attachment",
      interruptAgent: "Interrupt agent",
      queueMessage: "Queue message",
      sendAndInterrupt: "Send and interrupt",
      sendMessage: "Send message",
      queue: "Queue",
      send: "Send",
    },
    cancel: {
      cancelingAgent: "Canceling agent",
      stopAgent: "Stop agent",
      interrupt: "Interrupt",
    },
    voice: {
      enableVoiceMode: "Enable Voice mode",
      voiceMode: "Voice mode",
      unmuteVoiceMode: "Unmute Voice mode",
      muteVoiceMode: "Mute Voice mode",
      stopDictation: "Stop dictation",
      startDictation: "Start dictation",
      unmuteVoice: "Unmute voice",
      muteVoice: "Mute voice",
      dictation: "Dictation",
      interruptBeforeVoice: "Interrupt the agent before starting voice mode",
    },
    attachments: {
      addImage: "Add image",
      addIssueOrPr: "Add issue or PR",
      editQueuedMessage: "Edit queued message",
      sendQueuedMessageNow: "Send queued message now",
      openImage: "Open image attachment",
      removeImage: "Remove image attachment",
      openGithub: "Open {{kind}} #{{number}}",
      removeGithub: "Remove {{kind}} #{{number}}",
    },
    github: {
      searching: "Searching...",
      noResults: "No results found.",
      searchPlaceholder: "Search issues and PRs...",
      title: "Attach issue or PR",
    },
  },
  agentControls: {
    provider: {
      fallback: "Provider",
      select: "Select agent provider",
    },
    thinking: {
      title: "Thinking",
      unknown: "Unknown",
      select: "Select thinking option",
      selectWithValue: "Select thinking option ({{value}})",
    },
    features: {
      title: "Features",
      open: "Open agent features",
      on: "On",
      off: "Off",
    },
    mode: {
      title: "Mode",
      searchPlaceholder: "Search modes...",
      selectWithValue: "Select agent mode ({{value}})",
    },
    hints: {
      thinking: "Thinking mode",
      model: "Change model",
      mode: "Change permission mode",
    },
  },
  agentStream: {
    empty: "Start chatting with this agent...",
    scrollToBottom: "Scroll to bottom",
    permission: {
      plan: "Plan",
      required: "Permission Required",
      deny: "Deny",
      accept: "Accept",
      implement: "Implement",
      question: "How would you like to proceed?",
      proposedPlan: "Proposed plan",
    },
  },
  agentPanel: {
    states: {
      notFound: "Agent not found",
      failedToLoad: "Failed to load agent",
      reconnecting: "Reconnecting...",
      archivingTitle: "Archiving agent...",
      archivingSubtitle: "Please wait while we archive this agent.",
    },
    unavailable: {
      selectedHost: "Selected host",
      unknownHost:
        "Cannot open this agent because {{serverLabel}} is not configured on this device.",
      addHost: "Add the host in Settings or open an agent on a configured server to continue.",
      preparingSession: "Preparing {{serverLabel}} session...",
      connecting: "Connecting to {{serverLabel}}...",
      showSoon: "We will show this agent in a moment.",
      showWhenOnline: "We will show this agent once the host is online.",
      reconnectingTo: "Reconnecting to {{serverLabel}}...",
      showAgainWhenReachable: "We will show this agent again as soon as the host is reachable.",
    },
  },
  panels: {
    draft: {
      newAgent: "New Agent",
      creatingAgent: "Creating agent",
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
