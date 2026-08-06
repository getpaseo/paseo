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
 * Non-configurable so the plugin cannot restore them. A fresh realm gets them
 * back untouched and we cannot inject into it, so the rest of this shell is
 * about denying the plugin a fresh realm in the first place.
 */
export const PLUGIN_NEUTERED_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
] as const;

/**
 * Deleting the constructors only covers the realm the script runs in. A plugin
 * that gets a fresh browsing context gets `RTCPeerConnection` back intact, and
 * we cannot inject into it: `about:srcdoc` is exempt from `frame-src`, and
 * without `allow-same-origin` the child is cross-origin so its `contentWindow`
 * is unreachable. So the plugin does not get to have one at all.
 *
 * Removing frames as they are inserted is the part that keeps losing. Three
 * rounds of review have found a door it does not watch, so it is now the last
 * line rather than the only one, and every API that can mint a browsing context
 * out of markup is denied outright above it. Denying an API is a policy;
 * removing an element is a race.
 *
 * `object`/`embed` are already denied by `object-src 'none'`; they are in the
 * selector so it is the set of elements that can become a browsing context, not
 * a subset that happens to be reachable today.
 *
 * Three things this has to get right, each found by breaking an earlier version:
 *
 * Observe `document`, not `document.documentElement`. A post-load
 * `document.write()` implies `document.open()`, which throws away the whole tree
 * and builds a fresh `documentElement` — an observer bound to the old node is
 * left watching something detached and never fires again. (`document.write` is
 * denied outright now, but the observer target still has to survive one.)
 *
 * Capture every method and accessor up front. The plugin's script runs *after*
 * this one, so anything looked up at mutation time is something it can replace:
 * with `Element.prototype.remove = function(){}` the observer still fires and
 * quietly does nothing. Non-configurable constructors are worth little if the
 * machinery that enforces the removal is left writable.
 *
 * Follow shadow roots. A `MutationObserver` on `document` is never notified of
 * mutations inside a shadow root and `querySelectorAll` does not cross the
 * boundary, so a frame hidden in one is invisible to both — a `closed` root is
 * invisible to everything afterwards. `attachShadow` is wrapped to observe each
 * root it hands out, which is the only moment a closed one is reachable.
 */
const KILL_CHILD_REALMS = `
var A = Reflect.apply;
var own = Object.getOwnPropertyDescriptor;
var lock = function (target, name, value) {
  try { Object.defineProperty(target, name, { value: value, writable: false, configurable: false }); } catch (e) {}
};
var deny = function () { throw new Error("denied in the Paseo plugin sandbox"); };
var matches = Element.prototype.matches;
var findAll = Element.prototype.querySelectorAll;
var findAllIn = DocumentFragment.prototype.querySelectorAll;
var detach = Node.prototype.removeChild;
var parentOf = own(Node.prototype, "parentNode").get;
var typeOf = own(Node.prototype, "nodeType").get;
var shadowOf = own(Element.prototype, "shadowRoot").get;
var addedOf = own(MutationRecord.prototype, "addedNodes").get;
var countOf = own(NodeList.prototype, "length").get;
var at = NodeList.prototype.item;
var SELECTOR = "iframe,frame,object,embed";
var WATCH = { childList: true, subtree: true };
function drop(node) {
  var parent = A(parentOf, node, []);
  if (parent) { try { A(detach, parent, [node]); } catch (e) {} }
}
function sweep(node) {
  if (!node) return;
  var type = A(typeOf, node, []);
  if (type === 1) {
    if (A(matches, node, [SELECTOR])) { drop(node); return; }
  } else if (type !== 11) {
    return;
  }
  var found = A(type === 1 ? findAll : findAllIn, node, [SELECTOR]);
  for (var i = 0, n = A(countOf, found, []); i < n; i++) drop(A(at, found, [i]));
  if (type === 1) follow(node);
  var hosts = A(type === 1 ? findAll : findAllIn, node, ["*"]);
  for (var j = 0, m = A(countOf, hosts, []); j < m; j++) follow(A(at, hosts, [j]));
}
function follow(element) {
  var root = A(shadowOf, element, []);
  if (root) watch(root);
}
function watch(root) {
  observer.observe(root, WATCH);
  sweep(root);
}
var observer = new MutationObserver(function (records) {
  for (var i = 0; i < records.length; i++) {
    var added = A(addedOf, records[i], []);
    for (var j = 0, n = A(countOf, added, []); j < n; j++) sweep(A(at, added, [j]));
  }
});
observer.observe(document, WATCH);
var attach = Element.prototype.attachShadow;
if (attach) {
  lock(Element.prototype, "attachShadow", function (init) {
    var root = A(attach, this, [init]);
    watch(root);
    return root;
  });
}
lock(Document.prototype, "write", deny);
lock(Document.prototype, "writeln", deny);
lock(Document, "parseHTMLUnsafe", deny);
if (Element.prototype.setHTMLUnsafe) lock(Element.prototype, "setHTMLUnsafe", deny);
if (ShadowRoot.prototype.setHTMLUnsafe) lock(ShadowRoot.prototype, "setHTMLUnsafe", deny);
`;

export const PLUGIN_NEUTER_SCRIPT = `(function(){${JSON.stringify(
  PLUGIN_NEUTERED_GLOBALS,
)}.forEach(function(name){try{delete window[name];}catch(e){}try{Object.defineProperty(window,name,{value:undefined,writable:false,configurable:false});}catch(e){}});${KILL_CHILD_REALMS}})();`;

/**
 * The plugin's markup is inserted, never parsed as the document.
 *
 * Declarative shadow DOM (`<template shadowrootmode="closed">`) is honoured by
 * the HTML parser and by nothing else — fragment parsing leaves it an inert
 * `<template>`. Parsed as the document, a plugin gets a shadow root no script
 * can ever see into, and an `<iframe>` inside it is a browsing context nothing
 * can find. Inserting the same string with `insertAdjacentHTML` takes that away,
 * and it is the only door to a closed root that is not a method call we can deny.
 *
 * Inserted markup does not run its `<script>` elements, so they are re-created
 * in document order afterwards. That is the plugin's own contract restored, not
 * a workaround: inline scripts still run before `DOMContentLoaded`, in order,
 * because this shell script sits at the end of `<body>`.
 */
const INSERT_PLUGIN_HTML = `
var host = document.currentScript;
document.body.insertAdjacentHTML("beforeend", PLUGIN_HTML);
var scripts = document.body.querySelectorAll("script");
for (var i = 0; i < scripts.length; i++) {
  var old = scripts[i];
  if (old === host) continue;
  var next = document.createElement("script");
  next.text = old.textContent;
  old.parentNode.replaceChild(next, old);
}
`;

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
  const insert = INSERT_PLUGIN_HTML.replace("PLUGIN_HTML", () => toScriptString(html));
  return `<!doctype html><html><head>${CSP_META_TAG}<script>${PLUGIN_NEUTER_SCRIPT}</script></head><body><script>(function(){${insert}})();</script></body></html>`;
}

/** A JS string literal safe to sit inside a `<script>` element. */
function toScriptString(value: string): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
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
  return `<!doctype html><html><head>${CSP_META_TAG}<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style><script>${PLUGIN_HOST_RELAY}</script></head><body><iframe id="paseo-plugin" sandbox="allow-scripts" srcdoc="${guest}"></iframe></body></html>`;
}

/**
 * Relays between the plugin frame and the native bridge. Guest messages go up to
 * `ReactNativeWebView`; host messages come back down through `postMessage` on
 * the frame, so the plugin receives them the same way it does on web.
 *
 * Only the plugin frame is listened to, and only guest message types are
 * forwarded, so nothing the host sends can be echoed back to it.
 *
 * It runs in `<head>`, before the frame exists, and looks the frame up per
 * message rather than capturing it. The listener is then attached before the
 * plugin can possibly post, which matches what `frame.web.ts` does — and a lost
 * `ready` is unrecoverable, since the plugin only sends it once and the host
 * shows the timeout UI ten seconds later.
 */
const PLUGIN_HOST_RELAY = `(function(){
  function pluginWindow() {
    var frame = document.getElementById("paseo-plugin");
    return frame ? frame.contentWindow : null;
  }
  window.addEventListener("message", function (event) {
    if (!event.source || event.source !== pluginWindow()) return;
    var data = event.data;
    if (!data || data.paseo !== 1) return;
    if (data.type === "init" || data.type === "update") return;
    window.ReactNativeWebView.postMessage(JSON.stringify(data));
  });
  window.__paseoPost = function (message) {
    var target = pluginWindow();
    if (target) target.postMessage(message, "*");
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
