import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMcpServer } from "@getpaseo/protocol/agent-types";
import { en } from "@/i18n/resources/en";
import { McpServersPanel } from "./panel";
import type { AgentMcpServersView } from "./types";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A local instance rather than the app's own, which pulls the whole runtime in behind it. The
 * assertions read real English copy, so the resource has to be the real one.
 */
const i18n = createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    compatibilityJSON: "v4",
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

/**
 * The real menu engine in a real browser, for the same reason the track panel test uses one:
 * the popover only exists there, and the popover is where the header title and the row rail are.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function byTestId(testID: string): HTMLElement | null {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  return element instanceof HTMLElement ? element : null;
}

function trigger(): HTMLElement {
  const element = byTestId("mcp-panel-trigger");
  if (!element) throw new Error("MCP trigger did not render");
  return element;
}

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function readyView(
  servers: AgentMcpServer[],
  isRefreshing = false,
  source: "live" | "startup" | "configured" = "live",
): AgentMcpServersView {
  return { kind: "ready", servers, source, isRefreshing };
}

function panelElement(
  view: AgentMcpServersView,
  onRefresh: () => void,
  onOpenChange = vi.fn(),
  open = false,
) {
  return (
    <I18nextProvider i18n={i18n}>
      <McpServersPanel
        view={view}
        open={open}
        onOpenChange={onOpenChange}
        onRefresh={onRefresh}
        glyphSize={16}
      />
    </I18nextProvider>
  );
}

function mountPanel(view: AgentMcpServersView, onRefresh = vi.fn()) {
  mount(panelElement(view, onRefresh, vi.fn(), true));
  return onRefresh;
}

// A read-only `ComposerTrackRow` renders its accessibility label but not its testID, so rows are
// addressed the way a screen reader would address them.
function row(name: string): HTMLElement | null {
  const element = document.querySelector(`[aria-label^="${name}"]`);
  return element instanceof HTMLElement ? element : null;
}

const MIXED: AgentMcpServer[] = [
  { name: "codex", status: "connected" },
  { name: "claude.ai Stripe", status: "needs_auth" },
  { name: "salt-brain", status: "failed", error: "spawn ENOENT" },
];

describe("MCP servers panel", () => {
  it("lists one row per server, in the order the daemon reported them", () => {
    mountPanel(readyView(MIXED));

    for (const server of MIXED) {
      expect(row(server.name)).not.toBeNull();
    }
    const panel = byTestId("mcp-panel");
    const text = panel?.textContent ?? "";
    expect(text.indexOf("codex")).toBeLessThan(text.indexOf("claude.ai Stripe"));
    expect(text.indexOf("claude.ai Stripe")).toBeLessThan(text.indexOf("salt-brain"));
  });

  it("labels only the servers a reader has to act on", () => {
    mountPanel(readyView(MIXED));

    const text = byTestId("mcp-panel")?.textContent ?? "";
    expect(text).toContain("Needs auth");
    expect(text).toContain("Failed");
    // The check is the whole statement for a healthy server; a "Connected" column next to
    // every one of them buries the two rows that need reading.
    expect(text).not.toContain("Connected");
  });

  it("shows a failed server's error next to its name", () => {
    mountPanel(readyView(MIXED));

    expect(row("salt-brain")?.textContent).toContain("spawn ENOENT");
  });

  it("titles the popover, which the menu engine does not do for it", () => {
    mountPanel(readyView(MIXED));

    expect(byTestId("mcp-panel")?.textContent).toContain("MCP servers");
  });

  it("refreshes on demand, and disables the control while the refresh is in flight", () => {
    const onRefresh = mountPanel(readyView(MIXED));

    const refresh = byTestId("mcp-panel-refresh");
    expect(refresh).not.toBeNull();
    click(refresh as Element);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      mounted[0]?.root.render(panelElement(readyView(MIXED, true), onRefresh, vi.fn(), true));
    });
    click(byTestId("mcp-panel-refresh") as Element);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("speaks a status for every row, including the ones that show none", () => {
    mountPanel(readyView(MIXED));

    // The tick is decorative, so a connected row would otherwise be announced as a bare
    // name and be indistinguishable from a configured or unrecognised one.
    const connected = document.querySelector('[aria-label^="codex,"]');
    expect(connected?.getAttribute("aria-label")).toContain("Connected");

    const needsAuth = document.querySelector('[aria-label^="claude.ai Stripe,"]');
    expect(needsAuth?.getAttribute("aria-label")).toContain("Needs auth");
  });

  it("announces a configured row as unverified rather than connected", () => {
    mountPanel(readyView([{ name: "paseo", status: "unknown" }], false, "configured"));

    const configuredRow = document.querySelector('[aria-label^="paseo,"]');
    expect(configuredRow?.getAttribute("aria-label")).toContain("connection not reported");
  });

  it("puts the source caveat above the rows so it cannot fall below the fold", () => {
    mountPanel(readyView([{ name: "paseo", status: "unknown" }], false, "configured"));

    const text = byTestId("mcp-panel")?.textContent ?? "";
    expect(text.indexOf("does not report whether they connected")).toBeLessThan(
      text.indexOf("paseo"),
    );
  });

  it("does not imply health for a live server whose state was not recognised", () => {
    mountPanel(readyView([{ name: "paseo", status: "unknown" }]));

    const text = byTestId("mcp-panel")?.textContent ?? "";
    expect(text).toContain("paseo");
    expect(text).toContain("Unknown");
  });

  it("reports its open state, which is what gates the fetch", () => {
    const onOpenChange = vi.fn();
    mount(panelElement({ kind: "loading" }, vi.fn(), onOpenChange, false));

    // Closed on mount and nothing requested: a Codex agent answers this in ~3.5s and
    // 1.1MB, far too much to spend on every agent someone clicks on.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(byTestId("mcp-panel")).toBeNull();

    click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("says once that a configured report is unverified, rather than flagging every row", () => {
    mountPanel(readyView([{ name: "paseo", status: "unknown" }], false, "configured"));

    const text = byTestId("mcp-panel")?.textContent ?? "";
    expect(text).toContain("paseo");
    expect(text).toContain("does not report whether they connected");
    // No per-row "Unknown": a column of warnings over a healthy setup is noise.
    expect(text).not.toContain("Unknown");
  });

  it("marks a startup report as possibly out of date", () => {
    mountPanel(readyView([{ name: "paseo", status: "connected" }], false, "startup"));

    expect(byTestId("mcp-panel")?.textContent).toContain("session started");
  });

  it("renders nothing at all when the provider cannot report MCP status", () => {
    mount(panelElement({ kind: "unsupported" }, vi.fn(), vi.fn(), true));

    // Not an empty panel and not an error inside one — no trigger in the toolbar.
    expect(byTestId("mcp-panel-trigger")).toBeNull();
    expect(byTestId("mcp-panel")).toBeNull();
  });

  it("says so when the agent has no MCP servers at all", () => {
    mountPanel(readyView([]));

    expect(byTestId("mcp-panel")?.textContent).toContain("No MCP servers");
  });

  it("surfaces a fetch failure instead of an empty list", () => {
    mountPanel({ kind: "error", message: "Host connection lost" });

    expect(byTestId("mcp-panel")?.textContent).toContain("Host connection lost");
  });
});
