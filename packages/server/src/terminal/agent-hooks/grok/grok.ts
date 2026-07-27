import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { type ClaudeSettings, claudeSettingsFormat } from "../claude/claude-settings.js";

const GROK_EVENT_STATES: Record<string, AgentHookActivityState> = {
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  Stop: "idle",
  StopFailure: "idle",
  SessionEnd: "idle",
};

export const grokAgentHookProvider: AgentHookProvider<ClaudeSettings> = {
  id: "grok",
  events: [
    { event: "UserPromptSubmit" },
    { event: "PreToolUse" },
    { event: "PostToolUse" },
    { event: "Stop" },
    { event: "StopFailure" },
    { event: "SessionEnd" },
    { event: "Notification" },
  ],
  install: {
    kind: "config-file",
    configDir: ".grok",
    configFile: "hooks/paseo-terminal-activity.json",
    configDirEnvOverride: "GROK_HOME",
    hookMarker: "hooks grok",
    format: claudeSettingsFormat,
  },
  async resolveActivity({ event, input }) {
    if (event === "Notification") {
      const raw = input.isTTY ? null : await input.read();
      return isIdlePrompt(raw) ? "needs-input" : null;
    }

    return GROK_EVENT_STATES[event] ?? null;
  },
};

function isIdlePrompt(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const notification = JSON.parse(raw) as unknown;
    if (!notification || typeof notification !== "object") return false;
    const payload = notification as { matcher?: unknown; reason?: unknown };
    return payload.matcher === "idle_prompt" || payload.reason === "idle_prompt";
  } catch {
    return false;
  }
}
