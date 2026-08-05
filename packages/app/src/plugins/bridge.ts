/**
 * The host bridge from docs/plugins.md. One postMessage channel, every message
 * shaped `{ paseo: 1, type, ... }`; anything else is ignored.
 *
 * This module is platform-agnostic on purpose: `sandbox.web.tsx` and
 * `sandbox.tsx` both drive the exact same parse/serialise code so the two
 * sandboxes cannot drift apart.
 */

/** Bump only if the message envelope itself changes shape. */
export const PLUGIN_BRIDGE_VERSION = 1;

export type PluginContext =
  | { kind: "file-preview"; path: string; content: string }
  | { kind: "sidebar-panel"; cwd: string; workspaceId: string | null };

/** Resolved design tokens handed to the plugin so it can match the app chrome. */
export interface PluginThemeTokens {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  foregroundMuted: string;
  border: string;
  accent: string;
  fontFamily: string;
  monoFontFamily: string;
  fontSize: number;
}

export type PluginHostMessage =
  | {
      paseo: typeof PLUGIN_BRIDGE_VERSION;
      type: "init";
      context: PluginContext;
      theme: PluginThemeTokens;
    }
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "update"; context: PluginContext };

export type PluginGuestMessage =
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "ready" }
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "open-file"; path: string; lineStart?: number }
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "resize"; height: number };

export interface PluginGuestHandlers {
  onReady(): void;
  onOpenFile(input: { path: string; lineStart?: number }): void;
  onResize(height: number): void;
}

/** Props implemented identically by `sandbox.web.tsx` and `sandbox.tsx`. */
export interface PluginSandboxProps {
  /** The plugin's entry HTML, exactly as `plugins.get_entry` returned it. */
  html: string;
  context: PluginContext;
  onOpenFile?(input: { path: string; lineStart?: number }): void;
  /** Sidebar panels only; file previews fill their pane. */
  onResize?(height: number): void;
  testID?: string;
}

export const PLUGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}">`;

/**
 * Inject the plugin CSP into the plugin's own HTML. The meta tag has to be the
 * first thing in `<head>` — a CSP meta only governs what the parser has not
 * seen yet, so injecting it later would leave earlier scripts ungoverned.
 */
export function wrapPluginHtml(html: string): string {
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}${CSP_META_TAG}${html.slice(at)}`;
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${CSP_META_TAG}</head>${html.slice(at)}`;
  }
  // No document shell: the parser hoists a leading meta into the head it
  // synthesises, which is exactly where we need it.
  return `${CSP_META_TAG}${html}`;
}

export function createInitMessage(
  context: PluginContext,
  theme: PluginThemeTokens,
): PluginHostMessage {
  return { paseo: PLUGIN_BRIDGE_VERSION, type: "init", context, theme };
}

export function createUpdateMessage(context: PluginContext): PluginHostMessage {
  return { paseo: PLUGIN_BRIDGE_VERSION, type: "update", context };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse an inbound message from a plugin. Returns null for anything that is not
 * a well-formed `{ paseo: 1, ... }` guest message, including host messages
 * echoed back by the native forwarder.
 */
export function parsePluginGuestMessage(data: unknown): PluginGuestMessage | null {
  const raw = typeof data === "string" ? safeParseJson(data) : data;
  if (!isRecord(raw) || raw.paseo !== PLUGIN_BRIDGE_VERSION) {
    return null;
  }
  if (raw.type === "ready") {
    return { paseo: PLUGIN_BRIDGE_VERSION, type: "ready" };
  }
  if (raw.type === "open-file") {
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
      return null;
    }
    const lineStart =
      typeof raw.lineStart === "number" && Number.isFinite(raw.lineStart) && raw.lineStart > 0
        ? Math.floor(raw.lineStart)
        : undefined;
    return {
      paseo: PLUGIN_BRIDGE_VERSION,
      type: "open-file",
      path: raw.path,
      ...(lineStart === undefined ? {} : { lineStart }),
    };
  }
  if (raw.type === "resize") {
    if (typeof raw.height !== "number" || !Number.isFinite(raw.height) || raw.height < 0) {
      return null;
    }
    return { paseo: PLUGIN_BRIDGE_VERSION, type: "resize", height: raw.height };
  }
  return null;
}

/** Dispatch one raw inbound message. Returns true when it was a guest message. */
export function handlePluginGuestMessage(data: unknown, handlers: PluginGuestHandlers): boolean {
  const message = parsePluginGuestMessage(data);
  if (!message) {
    return false;
  }
  if (message.type === "ready") {
    handlers.onReady();
    return true;
  }
  if (message.type === "open-file") {
    handlers.onOpenFile({
      path: message.path,
      ...(message.lineStart === undefined ? {} : { lineStart: message.lineStart }),
    });
    return true;
  }
  handlers.onResize(message.height);
  return true;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
