import React, { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { BrowserChrome } from "./chrome";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
const urlInputRef = createRef<EditingTextInputHandle>();

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderChrome(url: string, onNavigate: (next: string) => void) {
  act(() => {
    root?.render(
      <BrowserChrome
        url={url}
        canGoBack={false}
        canGoForward={false}
        isLoading={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onNavigate={onNavigate}
        urlInputRef={urlInputRef}
      />,
    );
  });
  const input = container?.querySelector("input");
  if (!input) {
    throw new Error("url input did not render");
  }
  return input;
}

function submit(input: HTMLInputElement, text: string) {
  act(() => {
    input.focus();
  });
  input.value = text;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("BrowserChrome", () => {
  it("gives a scheme-less draft a scheme so the daemon accepts it", () => {
    const onNavigate = vi.fn();
    const input = renderChrome("https://a.test/", onNavigate);

    submit(input, "  google.com  ");

    expect(onNavigate).toHaveBeenCalledWith("https://google.com");
  });

  it("navigates a localhost draft over http", () => {
    const onNavigate = vi.fn();
    const input = renderChrome("https://a.test/", onNavigate);

    submit(input, "localhost:8081");

    expect(onNavigate).toHaveBeenCalledWith("http://localhost:8081");
  });

  it("ignores a blank draft", () => {
    const onNavigate = vi.fn();
    const input = renderChrome("https://a.test/", onNavigate);

    submit(input, "   ");

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("shows the url the tab moved to, replacing whatever was typed", () => {
    const onNavigate = vi.fn();
    const input = renderChrome("https://a.test/", onNavigate);
    input.value = "half-typed";

    renderChrome("https://b.test/", onNavigate);

    expect(input.value).toBe("https://b.test/");
  });
});
