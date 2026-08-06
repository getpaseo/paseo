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
 * Turns off DNS prefetching for the whole document, including hints a plugin
 * script adds later. CSP has no directive for it: a `dns-prefetch` hint makes no
 * request, so nothing is ever checked against a policy, and the payload rides in
 * the subdomain labels of the hostname.
 */
const DNS_PREFETCH_META_TAG = `<meta http-equiv="x-dns-prefetch-control" content="off">`;

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
 * `object`/`embed` are already denied by `object-src 'none'`, and `fencedframe`
 * has no way to navigate on an opaque origin — a `FencedFrameConfig` only comes
 * from `runAdAuction` or `sharedStorage`, neither of which is exposed there. They
 * are in the selector so it is the set of elements that can become a browsing
 * context, not the subset that happens to be reachable today.
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
 * The rule, in two halves, because each half was learned by shipping the other
 * one alone:
 *
 * 1. **Nothing here may call a method it did not capture at init.** `observe`
 *    broke this — `watch()` looked it up on `MutationObserver.prototype` at call
 *    time, and the wrapper calls `watch()` after the plugin has run, so a no-op
 *    `observe` left every shadow root unwatched and a frame inside a `closed`
 *    one invisible to everything. Written `obj.method(...)`, it is a bug; use
 *    `A(captured, obj, [...])`.
 * 2. **Nothing here may hand a web API an object whose prototype the plugin can
 *    reach.** Capturing the callee does nothing for the argument. A dictionary
 *    parameter is converted with one `Get` per member, so every member the
 *    object does not own comes off `Object.prototype`: with
 *    `Object.prototype.attributeFilter = 1` the sequence conversion throws and
 *    `observe` never runs, and with `Object.prototype.clonable = true` a
 *    `cloneNode` mints a shadow root the `attachShadow` wrapper never sees.
 *    Build them with `bare()`.
 * 3. **Nothing here may resolve a global at call time.** `bare()` satisfied both
 *    clauses above and still handed the plugin the object: it read
 *    `Object.create` when called, and the wrapper calls it on every
 *    `attachShadow`. A replaced `Object.create` returning an accessor pair
 *    swallows `options.mode = "open"`, so the plugin gets the `closed` root the
 *    wrapper exists to deny — and a `clonable` one, whose `cloneNode` copy no
 *    sweep can ever see into. `Object.create` and `Object.defineProperty` are
 *    captured for this reason; `lock()` was safe only by the accident that every
 *    call site is at init.
 *
 * Follow shadow roots. A `MutationObserver` on `document` is never notified of
 * mutations inside a shadow root and `querySelectorAll` does not cross the
 * boundary, so a frame hidden in one is invisible to both — a `closed` root is
 * invisible to everything afterwards. `attachShadow` is wrapped to observe each
 * root it hands out, which is the only moment a closed one is reachable.
 *
 * The sweep's own scan for open roots is belt and braces, not the mechanism:
 * every root that can exist here comes from that wrapper, since the plugin's
 * markup never reaches the HTML parser. It is what would still catch a frame if
 * that ever stopped being true. The cost is a `querySelectorAll("*")` per added
 * subtree, which is nothing for the one-shot markup path and quadratic for a
 * plugin that appends in a loop — the plugin pays it, and only if it does that.
 *
 * `webview` is Electron's, and it is the worst of them: the desktop renderer runs
 * with `webviewTag: true`, and a `<webview>` guest is a separate `WebContents`
 * with its own session. The plugin document's CSP does not describe it, the
 * iframe's `sandbox` flags are not inherited by it, and the neuter script never
 * runs in it — a fresh realm with a full network stack. Electron's
 * `will-attach-webview` gate is a companion control, not a substitute: it checks
 * the destination, and the partition name it requires is published source.
 *
 * `link` is in the selector for a different reason: `rel="dns-prefetch"` and
 * `rel="preconnect"` resolve a hostname without ever making a request, so no CSP
 * directive is consulted and the payload rides in the subdomain labels — the
 * same DNS exfiltration `RTCPeerConnection` is deleted to close. A hint fires
 * when the element is connected, before this observer's microtask, so removal is
 * cleanup rather than prevention; the prevention is that plugin markup is
 * sanitised while it is still detached, plus `x-dns-prefetch-control`. Nothing
 * legitimate is lost: CSP denies every resource a `<link>` could fetch anyway.
 * See the residual note in docs/plugins.md — a plugin *script* can still open one
 * `preconnect`, and no web platform primitive denies it.
 */
const KILL_CHILD_REALMS = `
var A = Reflect.apply;
var ObjectRef = Object;
var own = Object.getOwnPropertyDescriptor;
var create = Object.create;
var defineProp = Object.defineProperty;
var ErrorRef = Error;
var fail = function () { throw new ErrorRef("denied in the Paseo plugin sandbox"); };
var bare = function () { return A(create, ObjectRef, [null]); };
var lock = function (target, name, value) {
  // The descriptor is bare for the same reason \`WATCH\` is: \`ToPropertyDescriptor\`
  // does a \`HasProperty\` for \`get\` and \`set\`, which walks the prototype chain, so
  // an object literal here lets \`Object.prototype.get = 1\` make every \`lock()\`
  // throw. Every call site is at init today, which is not a reason to leave it.
  var descriptor = bare();
  descriptor.value = value;
  descriptor.writable = false;
  descriptor.configurable = false;
  try { A(defineProp, ObjectRef, [target, name, descriptor]); } catch (e) {}
};
var deny = function () { fail(); };
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
var startWatching = MutationObserver.prototype.observe;
// The last entry is not a browsing context: it is the one script type the
// platform acts on when the element is connected, and it names URLs to fetch.
// The detached sanitiser drops it out of plugin markup; without it here, a
// plugin script could just append one at runtime and the two paths would
// disagree. Everything else stays out of \`script\`, which plugins need.
var SELECTOR =
  'iframe,frame,object,embed,link,webview,fencedframe,script[type="speculationrules" i]';
// \`WATCH\` is null-prototype, because a dictionary argument is a lookup surface.
// Converting this to a \`MutationObserverInit\` is one Get per member, and every
// member it does not own would be read off \`Object.prototype\` — which the plugin
// owns. \`Object.prototype.attributeFilter = 1\` makes the sequence conversion
// throw, and \`observe\` then never runs.
var WATCH = bare();
WATCH.childList = true;
WATCH.subtree = true;
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
  // Guarded: one unreachable root must not abort the loop that is still
  // sweeping the rest of an inserted subtree.
  try {
    var root = A(shadowOf, element, []);
    if (root) watch(root);
  } catch (e) {}
}
function watch(root) {
  // Guarded, and the sweep runs either way: a throw here used to skip it, which
  // left the root both unwatched and unswept.
  try { A(startWatching, observer, [root, WATCH]); } catch (e) {}
  sweep(root);
}
var observer = new MutationObserver(function (records) {
  for (var i = 0; i < records.length; i++) {
    var added = A(addedOf, records[i], []);
    // Per node, so one throw cannot abandon the records after it.
    for (var j = 0, n = A(countOf, added, []); j < n; j++) {
      try { sweep(A(at, added, [j])); } catch (e) {}
    }
  }
});
A(startWatching, observer, [document, WATCH]);
var attach = Element.prototype.attachShadow;
if (attach) {
  lock(Element.prototype, "attachShadow", function (init) {
    // Forced open. A closed root is reachable only through this wrapper, so if
    // the watch is ever defeated again the frame inside one would be invisible
    // to every later sweep as well. Open leaves \`follow()\` a way back in.
    //
    // Null-prototype for the same reason as \`WATCH\`, and the plugin's own
    // members are copied across explicitly: on a plain object literal,
    // \`clonable\`, \`slotAssignment\` and \`serializable\` would be read off
    // \`Object.prototype\`, and \`clonable\` there mints a shadow root from
    // \`cloneNode\` with no \`attachShadow\` call to wrap.
    // Anything the platform would reject is handed straight to it, so a missing
    // argument or a typo'd \`mode\` still throws where the author expects rather
    // than quietly succeeding with a root they did not ask for.
    var mode = init && init.mode;
    var options = init;
    if (mode === "open" || mode === "closed") {
      options = bare();
      options.mode = "open";
      // Forwarded, not dropped: \`slotAssignment: "manual"\` is what makes
      // \`HTMLSlotElement.assign()\` work, and \`clonable\`/\`serializable\` are what
      // carry the root through \`cloneNode\` and \`getHTML\`. A bad value here is
      // still the platform's to reject.
      options.delegatesFocus = init.delegatesFocus;
      options.slotAssignment = init.slotAssignment;
      options.clonable = init.clonable;
      options.serializable = init.serializable;
    }
    var root = A(attach, this, [options]);
    // Verified, not assumed. Forcing \`open\` is what leaves every later sweep a
    // way into this root, so a wrapper that cannot confirm it got an open one
    // has to fail closed: the host goes, and with it anything under the root.
    if (A(shadowOf, this, []) !== root) {
      drop(this);
      fail();
    }
    // Guarded so a throw cannot leave the element holding a root that was never
    // watched: nothing sweeps an already-connected host again on its own.
    try { watch(root); } catch (e) {}
    return root;
  });
}
lock(Document.prototype, "write", deny);
lock(Document.prototype, "writeln", deny);
lock(Document, "parseHTMLUnsafe", deny);
if (Element.prototype.setHTMLUnsafe) lock(Element.prototype, "setHTMLUnsafe", deny);
if (ShadowRoot.prototype.setHTMLUnsafe) lock(ShadowRoot.prototype, "setHTMLUnsafe", deny);
// The Sanitizer API's *safe* halves are the same HTML document parser with a
// filter bolted on the end, and they parse with declarative shadow roots
// enabled. \`setHTML\` with a config naming \`template\` and \`shadowrootmode\` mints
// a real closed root on a connected element — no \`attachShadow\` call to wrap —
// and \`attachInternals().shadowRoot\` hands it straight back, because a root the
// parser made is available to element internals. A frame appended in there is
// invisible to every sweep: an observer on \`document\` is not told about
// mutations inside a shadow tree and \`shadowRoot\` reads \`null\` on a closed one.
// Measured: ICE gathering started from that child realm.
if (Element.prototype.setHTML) lock(Element.prototype, "setHTML", deny);
if (ShadowRoot.prototype.setHTML) lock(ShadowRoot.prototype, "setHTML", deny);
if (Document.parseHTML) lock(Document, "parseHTML", deny);
// XSLT with \`<xsl:output method="html"/>\` builds its result tree through the HTML
// *document* parser, which honours \`<template shadowrootmode="closed">\` — so a
// stylesheet mints a closed root with no \`attachShadow\` call to wrap, and
// \`adoptNode\` moves it into the live document with whatever is inside it (a move,
// not a clone, so \`clonable\` never comes into it). \`transformToFragment\` is
// fragment parsing and does not honour DSD today; it is denied anyway, because
// that distinction is one Chromium version from moving and no plugin needs either.
if (typeof XSLTProcessor === "function") {
  lock(XSLTProcessor.prototype, "transformToDocument", deny);
  lock(XSLTProcessor.prototype, "transformToFragment", deny);
}
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
 * in document order afterwards: inline scripts still run before
 * `DOMContentLoaded`, in order, because this shell script sits at the end of
 * `<body>`. What differs from a document parse is written down under "Writing
 * one" in docs/plugins.md — `type="module"` runs after the classic scripts, and
 * a script sees the whole document rather than only the markup above it.
 *
 * Attributes are copied because they are load-bearing: `type` decides whether an
 * element is script at all (`application/json` is data and must be left alone),
 * and plugins read `id` and `data-*` off `document.currentScript`.
 *
 * Everything is captured before the first plugin script runs, for the reason
 * `KILL_CHILD_REALMS` gives. No plugin code runs during this script — `holder` is
 * detached, so the re-created scripts execute only at the single `append` on the
 * last line — but the shell script that installed `KILL_CHILD_REALMS` ran before
 * this one, and a plugin's markup is not the only thing that can have poisoned a
 * global by then.
 */
const INSERT_PLUGIN_HTML = `
var A = Reflect.apply;
var own = Object.getOwnPropertyDescriptor;
var insert = Element.prototype.insertAdjacentHTML;
var findAll = Element.prototype.querySelectorAll;
var make = Document.prototype.createElement;
var swap = Node.prototype.replaceChild;
var detach = Node.prototype.removeChild;
var readAttr = Element.prototype.getAttribute;
var writeAttr = Element.prototype.setAttribute;
var attrsOf = own(Element.prototype, "attributes").get;
var parentOf = own(Node.prototype, "parentNode").get;
var textOf = own(Node.prototype, "textContent").get;
var setText = own(HTMLScriptElement.prototype, "text").set;
var countOf = own(NodeList.prototype, "length").get;
var at = NodeList.prototype.item;
var attrCountOf = own(NamedNodeMap.prototype, "length").get;
var attrAt = NamedNodeMap.prototype.item;
var nameOf = own(Attr.prototype, "name").get;
var valueOf = own(Attr.prototype, "value").get;
var trim = String.prototype.trim;
var lower = String.prototype.toLowerCase;
var indexOf = String.prototype.indexOf;
// The HTML spec's legacy JavaScript MIME types, plus "module". A hand-rolled
// pattern silently drops \`text/jscript\` and \`application/x-javascript\`, which a
// document parse runs — left inert here, with no error anywhere.
var JS = " module application/ecmascript application/javascript" +
  " application/x-ecmascript application/x-javascript text/ecmascript text/javascript" +
  " text/javascript1.0 text/javascript1.1 text/javascript1.2 text/javascript1.3" +
  " text/javascript1.4 text/javascript1.5 text/jscript text/livescript" +
  " text/x-ecmascript text/x-javascript ";
var append = Node.prototype.appendChild;
var makeFragment = Document.prototype.createDocumentFragment;
var firstOf = own(Node.prototype, "firstChild").get;
var host = document.currentScript;
var body = document.body;
// Out of the tree first, so \`body > :first-child\` is the plugin's own first
// element, and so the plugin cannot read this script's source back out.
var hostParent = A(parentOf, host, []);
if (hostParent) { try { A(detach, hostParent, [host]); } catch (e) {} }
// Detached: nothing in here is browsing-context connected, so a resource hint
// has not fired and a frame has not loaded.
var holder = A(make, document, ["div"]);
A(insert, holder, ["beforeend", PLUGIN_HTML]);
var junk = A(findAll, holder, ["link,iframe,frame,object,embed,webview,fencedframe"]);
for (var j = 0, jn = A(countOf, junk, []); j < jn; j++) {
  var dead = A(at, junk, [j]);
  var deadParent = A(parentOf, dead, []);
  if (deadParent) { try { A(detach, deadParent, [dead]); } catch (e) {} }
}
var scripts = A(findAll, holder, ["script"]);
for (var i = 0, n = A(countOf, scripts, []); i < n; i++) {
  var old = A(at, scripts, [i]);
  if (old === host) continue;
  var type = A(readAttr, old, ["type"]);
  if (type) {
    // Trimmed, because the parser does: \` text/javascript \` is script. The
    // space check keeps the list an exact-membership test — without it a value
    // spanning two adjacent entries would match the join rather than a member.
    var kind = A(lower, A(trim, type, []), []);
    if (kind && (A(indexOf, kind, [" "]) >= 0 || A(indexOf, JS, [" " + kind + " "]) < 0)) {
      // Left in place, because a non-JS script element is data: \`application/json\`
      // blocks are what plugins read back out. \`speculationrules\` is the
      // exception — it is not data, the platform acts on it when it is inserted,
      // and it names URLs to fetch. Dropped rather than carried over.
      // (No literal tag names in here: this whole string is inlined into a
      // script element, and \`wrapPluginHtml\`'s own test enforces it.)
      if (kind === "speculationrules") {
        var rulesParent = A(parentOf, old, []);
        if (rulesParent) { try { A(detach, rulesParent, [old]); } catch (e) {} }
      }
      continue;
    }
  }
  var parent = A(parentOf, old, []);
  if (!parent) continue;
  var next = A(make, document, ["script"]);
  var attrs = A(attrsOf, old, []);
  for (var a = 0, m = A(attrCountOf, attrs, []); a < m; a++) {
    var attr = A(attrAt, attrs, [a]);
    try { A(writeAttr, next, [A(nameOf, attr, []), A(valueOf, attr, [])]); } catch (e) {}
  }
  A(setText, next, [A(textOf, old, [])]);
  try { A(swap, parent, [next, old]); } catch (e) {}
}
// Connecting the markup is what runs its scripts, so it is the last step — and
// it is one step. Moving the nodes over individually would connect each script
// while its own siblings were still detached, so \`getElementById\` would not find
// them; a fragment connects the whole subtree before the first script runs.
var frag = A(makeFragment, document, []);
var kid;
while ((kid = A(firstOf, holder, []))) { A(append, frag, [kid]); }
A(append, body, [frag]);
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
  return `<!doctype html><html><head>${CSP_META_TAG}${DNS_PREFETCH_META_TAG}<script>${PLUGIN_NEUTER_SCRIPT}</script></head><body><script>(function(){${insert}})();</script></body></html>`;
}

/**
 * A JS string literal safe to sit inside a `<script>` element.
 *
 * Every `<` goes, not just `</script`. The script-data tokenizer has three
 * states, and an unterminated `<!--` moves it into "escaped" where a later
 * `<script` moves it into "double escaped" — in which our own real `</script>`
 * no longer ends the element. The whole shell is then one unterminated script,
 * a SyntaxError, and a blank plugin with nothing reported anywhere.
 */
function toScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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
  return `<!doctype html><html><head>${CSP_META_TAG}${DNS_PREFETCH_META_TAG}<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style><script>${PLUGIN_HOST_RELAY}</script></head><body><iframe id="paseo-plugin" sandbox="allow-scripts" srcdoc="${guest}"></iframe></body></html>`;
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
    // The bridge is injected by the WebView, and this script now runs in
    // <head>. A throw here loses \`ready\` for good: the plugin sends it once,
    // and ten seconds later the user gets the timeout screen.
    if (!window.ReactNativeWebView) return;
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
