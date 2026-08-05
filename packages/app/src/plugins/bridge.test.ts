import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONTENT_SECURITY_POLICY,
  createInitMessage,
  createUpdateMessage,
  handlePluginGuestMessage,
  parsePluginGuestMessage,
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
    onResize: (height) => calls.push(`resize:${height}`),
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
        createUpdateMessage({ kind: "sidebar-panel", cwd: "/w", workspaceId: null }),
      ),
    ).toBeNull();
  });

  it("ignores malformed guest payloads", () => {
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "open-file", path: "  " })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "resize" })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "resize", height: -1 })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "resize", height: Number.NaN })).toBeNull();
    expect(parsePluginGuestMessage({ paseo: 1, type: "exfiltrate" })).toBeNull();
  });

  it("parses the three guest messages, from objects and from JSON strings", () => {
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
    expect(parsePluginGuestMessage({ paseo: 1, type: "resize", height: 240 })).toEqual({
      paseo: 1,
      type: "resize",
      height: 240,
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
    expect(handlePluginGuestMessage({ paseo: 1, type: "resize", height: 12 }, handlers)).toBe(true);

    expect(calls).toEqual(["ready", "open-file:a.ts:-", "resize:12"]);
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
      onResize: () => {},
    };

    handlePluginGuestMessage({ paseo: 1, type: "ready" }, handlers);

    expect(sent).toEqual([{ paseo: 1, type: "init", context, theme: THEME }]);
  });
});

describe("wrapPluginHtml", () => {
  it("injects the CSP as the first thing inside an existing head", () => {
    const wrapped = wrapPluginHtml("<html><head><title>x</title></head><body>hi</body></html>");

    expect(wrapped).toBe(
      `<html><head><meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}"><title>x</title></head><body>hi</body></html>`,
    );
  });

  it("creates a head when the document has none", () => {
    expect(wrapPluginHtml('<html lang="en"><body>hi</body></html>')).toBe(
      `<html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}"></head><body>hi</body></html>`,
    );
  });

  it("prepends the CSP for a bare fragment", () => {
    expect(wrapPluginHtml("<p>hi</p>")).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CONTENT_SECURITY_POLICY}"><p>hi</p>`,
    );
  });

  it("denies network and storage in the policy it injects", () => {
    expect(PLUGIN_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
    );
  });
});
