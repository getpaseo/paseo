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
 *
 * This does NOT deny every outbound request. `default-src 'none'` does not cover
 * WebRTC, and there is no CSP directive that does — Chromium rejects `webrtc`
 * as an unrecognised directive and sends the packets anyway. See
 * `PLUGIN_NEUTER_SCRIPT`.
 */
export const PLUGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}">`;

/**
 * The one exfiltration channel CSP cannot express.
 *
 * `RTCPeerConnection` lets a plugin choose the ICE server's host, port,
 * username and credential, so both the destination and the payload are its own:
 * the STUN/TURN Allocate carries ~500 bytes of whatever it wants per
 * connection, and the hostname alone is enough for DNS exfiltration even with
 * no server answering. `default-src 'none'` does not gate it, `frame-src` is
 * irrelevant (nothing navigates), and `sandbox="allow-scripts"` does not
 * withhold the API. Deleting the constructors from the realm does.
 *
 * Non-configurable so the plugin cannot restore them. Recovering a fresh realm
 * fails on web because a nested frame under `sandbox` without
 * `allow-same-origin` gets its own opaque origin and reading its `contentWindow`
 * throws; on native the sandboxes inject this into subframes as well.
 */
export const PLUGIN_NEUTERED_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
] as const;

/**
 * Deleting the constructors only covers the realm the script runs in. A plugin
 * that appends a `srcdoc` iframe gets a brand new realm with `RTCPeerConnection`
 * intact, and we cannot inject into it: `about:srcdoc` is exempt from
 * `frame-src`, and without `allow-same-origin` the child is cross-origin so its
 * `contentWindow` is unreachable. So the plugin does not get to have child
 * browsing contexts at all — this rips out any frame-ish element as it is
 * inserted, before the child document begins parsing.
 *
 * `object`/`embed` are already denied by `object-src 'none'`; they are here so
 * the list is the set of elements that can become a browsing context, not a
 * subset that happens to be reachable today.
 *
 * Two things this has to get right, both found by breaking earlier versions:
 *
 * Observe `document`, not `document.documentElement`. A post-load
 * `document.write()` implies `document.open()`, which throws away the whole tree
 * and builds a fresh `documentElement` — an observer bound to the old node is
 * left watching something detached and never fires again, while the `<iframe>`
 * written in that same call parses and runs. The `Document` survives that, so a
 * subtree observer on it does too.
 *
 * Capture every method and accessor up front. The plugin's script runs *after*
 * this one, so anything looked up at mutation time is something it can replace:
 * with `Element.prototype.remove = function(){}` the observer still fires and
 * quietly does nothing. Non-configurable constructors are worth little if the
 * machinery that enforces the removal is left writable.
 */
const KILL_CHILD_REALMS = `
var A = Reflect.apply;
var own = Object.getOwnPropertyDescriptor;
var matches = Element.prototype.matches;
var findAll = Element.prototype.querySelectorAll;
var detach = Node.prototype.removeChild;
var parentOf = own(Node.prototype, "parentNode").get;
var typeOf = own(Node.prototype, "nodeType").get;
var addedOf = own(MutationRecord.prototype, "addedNodes").get;
var countOf = own(NodeList.prototype, "length").get;
var at = NodeList.prototype.item;
var SELECTOR = "iframe,frame,object,embed";
function drop(node) {
  var parent = A(parentOf, node, []);
  if (parent) { try { A(detach, parent, [node]); } catch (e) {} }
}
function sweep(node) {
  if (!node || A(typeOf, node, []) !== 1) return;
  if (A(matches, node, [SELECTOR])) { drop(node); return; }
  var found = A(findAll, node, [SELECTOR]);
  for (var i = 0, n = A(countOf, found, []); i < n; i++) drop(A(at, found, [i]));
}
new MutationObserver(function (records) {
  for (var i = 0; i < records.length; i++) {
    var added = A(addedOf, records[i], []);
    for (var j = 0, n = A(countOf, added, []); j < n; j++) sweep(A(at, added, [j]));
  }
}).observe(document, { childList: true, subtree: true });
`;

export const PLUGIN_NEUTER_SCRIPT = `(function(){${JSON.stringify(
  PLUGIN_NEUTERED_GLOBALS,
)}.forEach(function(name){try{delete window[name];}catch(e){}try{Object.defineProperty(window,name,{value:undefined,writable:false,configurable:false});}catch(e){}});${KILL_CHILD_REALMS}})();`;

/**
 * Wrap the plugin's HTML in our own document shell. A CSP meta only governs what
 * the parser has not seen yet, so it has to be the first element in `<head>`,
 * and the neutering script has to run before any plugin script.
 *
 * Never look for the plugin's own `<head>`: the HTML is attacker-controlled, and
 * any textual match can be faked (`<!-- <head> -->`, `<p title="<head>">`) so the
 * meta lands somewhere the parser never treats it as an element and the document
 * ships with no CSP at all. Emitting our own shell makes the meta unconditionally
 * first; a nested html/head from the plugin is ignored by the parser.
 */
export function wrapPluginHtml(html: string): string {
  return `<!doctype html><html><head>${CSP_META_TAG}<script>${PLUGIN_NEUTER_SCRIPT}</script></head><body>${html}</body></html>`;
}

/**
 * The document a WebView loads, which then renders the plugin in a sandboxed
 * iframe exactly as the web sandbox does.
 *
 * The WebView used to load the plugin as its own top document, and that is what
 * made native the odd one out. With no `sandbox` attribute anywhere, a frame the
 * plugin creates *inherits* the parent's origin instead of getting a fresh
 * opaque one, so parent and child are same-origin: the plugin reads
 * `frames[0].RTCPeerConnection` synchronously, in the same task as the
 * insertion, and no `MutationObserver` gets a turn in between. On web the same
 * line throws, and only because `sandbox="allow-scripts"` mints an opaque origin
 * for the child.
 *
 * So native stops being a second sandbox model. `allow-same-origin` is withheld
 * here for the same reason as on web, `frame-src 'none'` on this host document
 * is what denies the plugin frame navigating itself out, and the plugin sees the
 * identical contract: post to `window.parent`, listen on `window`.
 */
export function wrapPluginHostDocument(html: string): string {
  const guest = wrapPluginHtml(html)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id="paseo-plugin" sandbox="allow-scripts" srcdoc="${guest}"></iframe><script>${PLUGIN_HOST_RELAY}</script></body></html>`;
}

/**
 * Relays between the plugin frame and the native bridge. Guest messages go up to
 * `ReactNativeWebView`; host messages come back down through `postMessage` on
 * the frame, so the plugin receives them the same way it does on web.
 *
 * Only the plugin frame is listened to, and only guest message types are
 * forwarded, so nothing the host sends can be echoed back to it.
 */
const PLUGIN_HOST_RELAY = `(function(){
  var frame = document.getElementById("paseo-plugin");
  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.paseo !== 1) return;
    if (data.type === "init" || data.type === "update") return;
    window.ReactNativeWebView.postMessage(JSON.stringify(data));
  });
  window.__paseoPost = function (message) {
    frame.contentWindow.postMessage(message, "*");
  };
})();`;

function isHomeRelative(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

/**
 * The workspace-relative path a plugin sees, and sends back. `null` when the
 * file is outside the workspace, which is what makes a plugin preview
 * workspace-only — see `isPluginPreviewablePath`.
 *
 * Plugins are handed the relative path rather than the absolute one for two
 * reasons: the absolute path leaks the user's home directory into untrusted
 * HTML, and `open-file` only accepts relative paths, so handing over an
 * absolute one gives the plugin a value the host then refuses back.
 */
export function toPluginRelativePath(workspaceRoot: string, absolutePath: string): string | null {
  return resolveWorkspaceFilePaths({ path: absolutePath, workspaceRoot })?.relativePath ?? null;
}

/**
 * The file pane can preview `~`-relative files and absolute files outside the
 * workspace (`file-explorer/preview-target.ts`). Plugins do not get those: there
 * is no relative path to hand over, so the plugin would receive an absolute path
 * — leaking the home directory — and could never send it back through
 * `open-file`. Those files fall back to the built-in code view.
 */
export function isPluginPreviewablePath(workspaceRoot: string, path: string): boolean {
  return toPluginRelativePath(workspaceRoot, path) !== null;
}

/** Re-absolutise a path that came back through `open-file`, for host consumers. */
export function fromPluginRelativePath(workspaceRoot: string, relativePath: string): string {
  return `${workspaceRoot.replace(/\/+$/, "")}/${relativePath}`;
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
