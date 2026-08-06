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
          try {
            var realm = document.createElement("iframe");
            realm.srcdoc =
              "<script>parent.parent.postMessage({exfil:1,type:'child'," +
              "rtc:typeof RTCPeerConnection},'*');<\\/script>";
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
});
