/**
 * The host bridge from docs/plugins.md. One postMessage channel, every message
 * shaped `{ paseo: 1, type, ... }`; anything else is ignored.
 *
 * This module is platform-agnostic on purpose: `sandbox.web.tsx` and
 * `sandbox.tsx` both drive the exact same parse/serialise code so the two
 * sandboxes cannot drift apart.
 */

import { isAbsolutePath } from "@/utils/path";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

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
  | {
      paseo: typeof PLUGIN_BRIDGE_VERSION;
      type: "update";
      context: PluginContext;
      theme: PluginThemeTokens;
    };

export type PluginGuestMessage =
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "ready" }
  | { paseo: typeof PLUGIN_BRIDGE_VERSION; type: "open-file"; path: string; lineStart?: number };

export interface PluginGuestHandlers {
  onReady(): void;
  onOpenFile(input: { path: string; lineStart?: number }): void;
}

/** Props implemented identically by `sandbox.web.tsx` and `sandbox.tsx`. */
export interface PluginSandboxProps {
  /** The plugin's entry HTML, exactly as `plugins.get_entry` returned it. */
  html: string;
  context: PluginContext;
  onOpenFile?(input: { path: string; lineStart?: number }): void;
  testID?: string;
}

/**
 * `form-action` and `base-uri` do not fall back to `default-src`, so without
 * them a form POST is a live exfiltration path — and on native there is no
 * iframe `sandbox` attribute to deny forms for us.
 */
export const PLUGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}">`;

/**
 * Wrap the plugin's HTML in our own document shell. A CSP meta only governs what
 * the parser has not seen yet, so it has to be the first element in `<head>`.
 *
 * Never look for the plugin's own `<head>`: the HTML is attacker-controlled, and
 * any textual match can be faked (`<!-- <head> -->`, `<p title="<head>">`) so the
 * meta lands somewhere the parser never treats it as an element and the document
 * ships with no CSP at all. Emitting our own shell makes the meta unconditionally
 * first; a nested html/head from the plugin is ignored by the parser.
 */
export function wrapPluginHtml(html: string): string {
  return `<!doctype html><html><head>${CSP_META_TAG}</head><body>${html}</body></html>`;
}

function isHomeRelative(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

/**
 * `open-file` is the only verb that names a path, so it is the only place a
 * plugin could turn the bridge into an arbitrary-file-read primitive: it asks
 * for `~/.npmrc`, the pane opens it, and — if the plugin also claims that
 * extension — hands the secret straight back as its next context.
 *
 * Only workspace-relative paths that stay inside the workspace are allowed.
 * `resolveWorkspaceFilePaths` yields `relativePath: null` for anything that
 * escapes the root; the root passed here is a placeholder because only the
 * relative half of the answer is used.
 */
export function resolvePluginOpenFilePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || isAbsolutePath(trimmed) || isHomeRelative(trimmed)) {
    return null;
  }
  return resolveWorkspaceFilePaths({ path: trimmed, workspaceRoot: "/" })?.relativePath ?? null;
}

export function createInitMessage(
  context: PluginContext,
  theme: PluginThemeTokens,
): PluginHostMessage {
  return { paseo: PLUGIN_BRIDGE_VERSION, type: "init", context, theme };
}

/**
 * `update` carries the theme as well as the context: a live plugin has no other
 * way to learn the app switched between light and dark.
 */
export function createUpdateMessage(
  context: PluginContext,
  theme: PluginThemeTokens,
): PluginHostMessage {
  return { paseo: PLUGIN_BRIDGE_VERSION, type: "update", context, theme };
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
    if (typeof raw.path !== "string") {
      return null;
    }
    const path = resolvePluginOpenFilePath(raw.path);
    if (!path) {
      return null;
    }
    const lineStart =
      typeof raw.lineStart === "number" && Number.isFinite(raw.lineStart) && raw.lineStart > 0
        ? Math.floor(raw.lineStart)
        : undefined;
    return {
      paseo: PLUGIN_BRIDGE_VERSION,
      type: "open-file",
      path,
      ...(lineStart === undefined ? {} : { lineStart }),
    };
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
  handlers.onOpenFile({
    path: message.path,
    ...(message.lineStart === undefined ? {} : { lineStart: message.lineStart }),
  });
  return true;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
