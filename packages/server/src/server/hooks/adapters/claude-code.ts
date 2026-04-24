import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import { AGENT_TOOL_MAP, type CanonicalTool, type HubcodeHook } from "../types.js";

/**
 * Translates Hubcode hooks into Claude Code's `settings.json` hook entries.
 *
 * Protocol reference:
 *   - hooks live under `hooks.<TriggerName>[]` in `~/.claude/settings.json`.
 *   - each entry: `{ matcher: "Read|Grep", hooks: [{ type: "command", command: "..." }] }`.
 *   - we mark ours with a sentinel key `hubcodeHookId` so round-trips remove
 *     the right entries without clobbering the user's own hooks.
 *
 * Adapter contract:
 *   - `syncAll(hooks)` — take the current set of enabled hubcode hooks and
 *     make the settings file match (add missing, update changed, remove
 *     orphaned hubcode entries, preserve user entries).
 *   - `removeAll()` — called when crg is uninstalled or user toggles off
 *     the last built-in; strips all hubcode entries, keeps user entries.
 */

const TRIGGER_MAP: Record<HubcodeHook["trigger"], string> = {
  "post-tool-use": "PostToolUse",
  "pre-tool-use": "PreToolUse",
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
};

const SENTINEL_KEY = "hubcodeHookId";

export interface ClaudeCodeAdapterDeps {
  logger: Logger;
  /** Override for tests; defaults to `~/.claude/settings.json`. */
  settingsPath?: string;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

interface SettingsJson {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: "command"; command: string; timeout?: number }>;
  [key: string]: unknown;
}

export class ClaudeCodeHookAdapter {
  private readonly logger: Logger;
  private readonly settingsPath: string;

  constructor(deps: ClaudeCodeAdapterDeps) {
    this.logger = deps.logger.child({ module: "hooks-adapter", agent: "claude-code" });
    this.settingsPath = deps.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  }

  async syncAll(enabledHooks: HubcodeHook[]): Promise<void> {
    const settings = await this.readSettings();
    settings.hooks = settings.hooks ?? {};

    // Strip any prior hubcode entries across every trigger bucket. We'll
    // re-add only the ones still enabled.
    for (const bucket of Object.keys(settings.hooks)) {
      settings.hooks[bucket] = (settings.hooks[bucket] ?? []).filter(
        (entry) => !entry[SENTINEL_KEY],
      );
      if (settings.hooks[bucket].length === 0) delete settings.hooks[bucket];
    }

    for (const hook of enabledHooks) {
      const triggerName = TRIGGER_MAP[hook.trigger];
      const matcher = matcherFor(hook);
      const command = commandFor(hook);
      if (!command) {
        this.logger.warn({ id: hook.id }, "Skipping hook — unsupported runtime");
        continue;
      }
      const entry: HookEntry = {
        [SENTINEL_KEY]: hook.id,
        matcher,
        hooks: [
          {
            type: "command",
            command,
            timeout: Math.max(1, Math.ceil(hook.timeoutMs / 1_000)),
          },
        ],
      };
      settings.hooks[triggerName] = settings.hooks[triggerName] ?? [];
      settings.hooks[triggerName].push(entry);
    }

    // If every bucket ended up empty (user disabled everything AND had no
    // user hooks), drop the `hooks` key entirely so we don't leave a
    // dangling `{}` in the user's settings.
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await this.writeSettings(settings);
  }

  async removeAll(): Promise<void> {
    // Equivalent to syncAll([]) — keeps user hook entries intact, drops
    // anything with our sentinel.
    await this.syncAll([]);
  }

  private async readSettings(): Promise<Writable<SettingsJson>> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Writable<SettingsJson>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn({ err, path: this.settingsPath }, "Failed to read Claude settings");
      }
    }
    return {};
  }

  private async writeSettings(settings: SettingsJson): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.hubcode.tmp`;
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
    await fs.rename(tmp, this.settingsPath);
  }
}

function matcherFor(hook: HubcodeHook): string {
  const tools = hook.matcher.tools ?? [];
  if (tools.length === 0) return ".*";
  const mapping = AGENT_TOOL_MAP["claude-code"];
  const nativeNames = new Set<string>();
  for (const canonical of tools) {
    for (const native of mapping[canonical as CanonicalTool] ?? []) {
      nativeNames.add(native);
    }
  }
  if (nativeNames.size === 0) return ".*";
  // Escape minor regex-specials even though tool names today are alnum only
  // — future tools with dots/underscores shouldn't break matching.
  const escaped = [...nativeNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.length === 1 ? `^${escaped[0]}$` : `^(${escaped.join("|")})$`;
}

function commandFor(hook: HubcodeHook): string | null {
  switch (hook.runtime) {
    case "node":
      return `node ${shellEscape(hook.source)}`;
    case "bash":
      return `bash ${shellEscape(hook.source)}`;
    case "python":
      return `python3 ${shellEscape(hook.source)}`;
    case "inline":
      // Inline execution is handled by the Hubcode GUI adapter (SDK-mode);
      // Claude Code requires a filesystem path, so inline hooks are skipped.
      return null;
    default:
      return null;
  }
}

function shellEscape(s: string): string {
  // Wrap in single quotes and escape any single quote inside.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
