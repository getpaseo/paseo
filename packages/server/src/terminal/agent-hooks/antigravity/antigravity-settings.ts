import {
  type AgentHookConfigFormat,
  type AgentHookEventDefinition,
  type AgentHookProvider,
  buildAgentHookShellCommand,
  buildAgentHookWindowsCommand,
} from "../agent-hook-installer.js";

const PASEO_HOOK_KEY = "paseo-terminal-activity";
const GROUPED_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

interface AntigravityCommandHook {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface AntigravityMatcherGroup {
  matcher?: unknown;
  hooks?: unknown;
}

export interface AntigravityHooksFile {
  [hookName: string]: unknown;
}

function buildAntigravityHookCommand(
  provider: AgentHookProvider<AntigravityHooksFile>,
  event: AgentHookEventDefinition,
): string {
  return process.platform === "win32"
    ? buildAgentHookWindowsCommand(provider, event)
    : buildAgentHookShellCommand(provider, event);
}

export const antigravityHooksFormat: AgentHookConfigFormat<AntigravityHooksFile> = {
  empty() {
    return {};
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed;
  },
  stringify(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
  },
  install(config, provider) {
    const next: AntigravityHooksFile = { ...config };
    const paseoEntry: Record<string, unknown> = {};
    for (const event of provider.events) {
      const handler = {
        type: "command",
        command: buildAntigravityHookCommand(provider, event),
        timeout: 10,
      };
      paseoEntry[event.event] = GROUPED_TOOL_EVENTS.has(event.event)
        ? [{ matcher: "*", hooks: [handler] }]
        : [handler];
    }
    next[PASEO_HOOK_KEY] = paseoEntry;
    return next;
  },
  uninstall(config, provider) {
    const marker = provider.install.hookMarker;
    const next: AntigravityHooksFile = { ...config };
    const existing = next[PASEO_HOOK_KEY];
    if (isRecord(existing)) {
      const cleaned = stripPaseoHandlers(existing, provider.events, marker);
      if (Object.keys(cleaned).length > 0) {
        next[PASEO_HOOK_KEY] = cleaned;
      } else {
        delete next[PASEO_HOOK_KEY];
      }
    }
    return next;
  },
  isInstalled(config, provider) {
    const entry = config[PASEO_HOOK_KEY];
    if (!isRecord(entry) || entry.enabled === false) {
      return false;
    }
    const marker = provider.install.hookMarker;
    return provider.events.every((event) =>
      eventHasMarker(entry[event.event], event.event, marker),
    );
  },
};

function stripPaseoHandlers(
  entry: Record<string, unknown>,
  events: readonly AgentHookEventDefinition[],
  marker: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...entry };
  for (const event of events) {
    const current = next[event.event];
    if (!Array.isArray(current)) continue;
    const remaining = GROUPED_TOOL_EVENTS.has(event.event)
      ? removeMarkedMatcherGroups(current, marker)
      : current.filter((item) => !isMarkedCommandHook(item, marker));
    if (remaining.length > 0) {
      next[event.event] = remaining;
    } else {
      delete next[event.event];
    }
  }
  return next;
}

function removeMarkedMatcherGroups(entries: unknown[], marker: string): AntigravityMatcherGroup[] {
  const remaining: AntigravityMatcherGroup[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
    const hooks = entry.hooks.filter((hook) => !isMarkedCommandHook(hook, marker));
    if (hooks.length > 0) {
      remaining.push({ ...entry, hooks });
    }
  }
  return remaining;
}

function eventHasMarker(value: unknown, eventName: string, marker: string): boolean {
  if (!Array.isArray(value)) return false;
  if (GROUPED_TOOL_EVENTS.has(eventName)) {
    return value.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((hook) => isMarkedCommandHook(hook, marker)),
    );
  }
  return value.some((hook) => isMarkedCommandHook(hook, marker));
}

function isMarkedCommandHook(value: unknown, marker: string): boolean {
  if (!isRecord(value)) return false;
  const hook = value as AntigravityCommandHook;
  return typeof hook.command === "string" && hook.command.includes(marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
