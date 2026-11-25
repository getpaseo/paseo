import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { BlockCopyButton } from "./block-copy-button";

const LABEL = "Copy quote";

let errors: string[] = [];
const toast: ToastApi = {
  show: () => () => {},
  copied: () => {},
  error: (message) => errors.push(message),
};

describe("BlockCopyButton", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    errors = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  function render(onCopy: () => Promise<boolean>, visible = true) {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ToastApiProvider api={toast}>
            <BlockCopyButton onCopy={onCopy} visible={visible} label={LABEL} />
          </ToastApiProvider>
        </I18nextProvider>,
      ),
    );
  }

  function button(name = LABEL): HTMLElement {
    return within(host).getByRole("button", { name });
  }

  it("shows Copied after a write and returns to its label", async () => {
    let calls = 0;
    render(async () => {
      calls += 1;
      return true;
    });

    await userEvent.click(button());
    await vi.waitFor(() => expect(button("Copied")).toBeTruthy());
    await vi.waitFor(() => expect(button()).toBeTruthy(), { timeout: 2500 });
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each([
    ["resolves false", async () => false],
    [
      "rejects",
      async (): Promise<boolean> => {
        throw new Error("Clipboard denied");
      },
    ],
  ])("tells the user and never shows Copied when the write %s", async (_case, failure) => {
    let calls = 0;
    render(() => {
      calls += 1;
      return calls === 1 ? failure() : Promise.resolve(true);
    });

    await userEvent.click(button());
    await vi.waitFor(() => expect(errors).toEqual(["Unable to copy"]));
    expect(within(host).queryByRole("button", { name: "Copied" })).toBeNull();

    await userEvent.click(button());
    await vi.waitFor(() => expect(button("Copied")).toBeTruthy());
    expect(calls).toBe(2);
  });

  it("does not write twice while a write is pending", async () => {
    let finish!: (written: boolean) => void;
    let calls = 0;
    render(() => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });

    await userEvent.click(button());
    await userEvent.click(button());
    expect(calls).toBe(1);

    finish(true);
    await vi.waitFor(() => expect(button("Copied")).toBeTruthy());
    expect(calls).toBe(1);
  });

  it("stays hidden until its block reveals it or it takes keyboard focus", async () => {
    render(async () => true, false);
    expect(getComputedStyle(button()).opacity).toBe("0");

    await userEvent.tab();
    expect(document.activeElement).toBe(button());
    await vi.waitFor(() => expect(getComputedStyle(button()).opacity).toBe("1"));
  });
});
