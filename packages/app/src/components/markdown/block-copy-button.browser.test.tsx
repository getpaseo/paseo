import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { i18n as testI18n } from "@/i18n/i18next";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { BlockCopyButton } from "./block-copy-button";

const EMPTY_STYLE = {};

describe("BlockCopyButton", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  function render(onCopy: () => Promise<boolean>) {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={testI18n}>
          <BlockCopyButton onCopy={onCopy} visible label="Copy quote" />
        </I18nextProvider>,
      ),
    );
  }

  function button(): HTMLElement {
    return within(host).getByRole("button", { name: "Copy quote" });
  }

  it("shows success feedback and resets to idle", async () => {
    let calls = 0;
    render(async () => {
      calls += 1;
      return true;
    });

    const control = button();
    control.focus();
    expect(control.style.opacity).toBe("1");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(control.getAttribute("aria-label")).toBe("Copied"));
    expect(control.getAttribute("aria-busy")).toBe("false");

    await vi.waitFor(() => expect(button().getAttribute("aria-label")).toBe("Copy quote"), {
      timeout: 2500,
    });
    expect(calls).toBe(1);
  });

  it("keeps a thrown failure visible and lets the user retry", async () => {
    let calls = 0;
    render(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Clipboard denied");
      return true;
    });

    await userEvent.click(button());
    await vi.waitFor(() =>
      expect(within(host).getByRole("alert").textContent).toContain("Copy failed"),
    );
    expect(within(host).queryByRole("button", { name: "Copied" })).toBeNull();

    await userEvent.click(within(host).getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(within(host).queryByRole("alert")).toBeNull());
    await vi.waitFor(() =>
      expect(within(host).getByRole("button", { name: "Copied" }).getAttribute("aria-label")).toBe(
        "Copied",
      ),
    );
    expect(calls).toBe(2);
  });

  it("treats a false result as a deliberate no-op", async () => {
    let calls = 0;
    render(async () => {
      calls += 1;
      return false;
    });

    await userEvent.click(button());
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(within(host).queryByRole("alert")).toBeNull();
    expect(within(host).queryByRole("button", { name: "Copied" })).toBeNull();
    expect(button().getAttribute("aria-label")).toBe("Copy quote");
  });

  it("suppresses duplicate writes while a write is pending", async () => {
    let finish!: () => void;
    let calls = 0;
    render(() => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      });
    });

    const control = button();
    await userEvent.click(control);
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.hasAttribute("disabled")).toBe(true);

    control.click();
    expect(calls).toBe(1);

    finish();
    await vi.waitFor(() =>
      expect(within(host).getByRole("button", { name: "Copied" }).getAttribute("aria-label")).toBe(
        "Copied",
      ),
    );
  });
});

describe("HighlightedCodeBlock copy", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  function renderCode(writeToClipboard: (text: string) => Promise<boolean>) {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={testI18n}>
          <HighlightedCodeBlock
            code={"  **literal**\nnext\n\n"}
            language="text"
            inheritedStyles={EMPTY_STYLE}
            textStyle={EMPTY_STYLE}
            writeToClipboard={writeToClipboard}
          />
        </I18nextProvider>,
      ),
    );
  }

  async function copyCodeWithKeyboard() {
    const control = within(host).getByRole("button", { name: "Copy code" });
    control.focus();
    await userEvent.keyboard("{Enter}");
  }

  it("copies literal code without terminal line breaks", async () => {
    const written: string[] = [];
    renderCode(async (text) => {
      written.push(text);
      return true;
    });

    await copyCodeWithKeyboard();
    await vi.waitFor(() => expect(written).toEqual(["  **literal**\nnext"]));
    await vi.waitFor(() =>
      expect(within(host).getByRole("button", { name: "Copied" }).getAttribute("aria-label")).toBe(
        "Copied",
      ),
    );
  });

  it("surfaces a false result and retries the literal payload", async () => {
    let allowWrite = false;
    const written: string[] = [];
    renderCode(async (text) => {
      written.push(text);
      return allowWrite;
    });

    await copyCodeWithKeyboard();
    await vi.waitFor(() =>
      expect(within(host).getByRole("alert").textContent).toContain("Copy failed"),
    );
    expect(within(host).queryByRole("button", { name: "Copied" })).toBeNull();

    allowWrite = true;
    await userEvent.click(within(host).getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(within(host).queryByRole("alert")).toBeNull());
    await vi.waitFor(() =>
      expect(within(host).getByRole("button", { name: "Copied" }).getAttribute("aria-label")).toBe(
        "Copied",
      ),
    );
    expect(written).toEqual(["  **literal**\nnext", "  **literal**\nnext"]);
  });
});
