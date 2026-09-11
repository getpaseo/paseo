import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { AdaptiveRenameModal } from "./rename-modal";

function noop(): void {}

interface MountedModal {
  root: Root;
  container: HTMLDivElement;
}

const mountedModals: MountedModal[] = [];

interface RenderModalProps {
  initialValue: string;
  onSubmit?: (value: string) => Promise<void> | void;
  onClose?: () => void;
  validate?: (value: string) => string | null;
}

function renderModal({ initialValue, onSubmit, onClose, validate }: RenderModalProps): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AdaptiveRenameModal
        visible
        title="Rename workspace"
        initialValue={initialValue}
        submitLabel="Rename"
        onClose={onClose ?? noop}
        onSubmit={onSubmit ?? noop}
        validate={validate}
        testID="rename-modal"
      />,
    );
  });
  mountedModals.push({ root, container });
}

function queryInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-testid="rename-modal-input"]');
  if (!input) throw new Error("Rename modal did not render its input");
  return input;
}

function queryButton(suffix: "submit" | "cancel"): HTMLElement {
  const button = document.querySelector<HTMLElement>(`[data-testid="rename-modal-${suffix}"]`);
  if (!button) throw new Error(`Rename modal did not render its ${suffix} button`);
  return button;
}

function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true";
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    valueSetter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  });
}

function pressEnter(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

function press(button: HTMLElement): void {
  act(() => {
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
    );
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const mounted of mountedModals.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

beforeAll(function pinEnglishLocale() {
  // Importing the i18n module initializes the real i18next instance the
  // modal's useTranslation binds to; pin English so label assertions stay
  // deterministic regardless of the host machine.
  void i18n.changeLanguage("en");
});

describe("AdaptiveRenameModal", () => {
  it("renders the initial value pre-filled, focused, and fully selected after open", async () => {
    renderModal({ initialValue: "main" });
    const input = queryInput();
    expect(input.value).toBe("main");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("main".length);
  });

  it("submits on Enter keypress in the input when the value has changed", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderModal({ initialValue: "feature", onSubmit, onClose });

    typeInto(queryInput(), "feature-2");
    pressEnter(queryInput());
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("feature-2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the cancel button is pressed", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onClose, onSubmit });

    press(queryButton("cancel"));
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables submit when the draft equals the initial value and re-enables after a change", async () => {
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onSubmit });

    expect(isDisabled(queryButton("submit"))).toBe(true);

    pressEnter(queryInput());
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto(queryInput(), "main-v2");
    await flush();
    expect(isDisabled(queryButton("submit"))).toBe(false);

    typeInto(queryInput(), "main");
    await flush();
    expect(isDisabled(queryButton("submit"))).toBe(true);
  });

  it("surfaces validate errors inline and blocks submission", async () => {
    const onSubmit = vi.fn();
    const validate = vi.fn((value: string) => (value === "bad" ? "Invalid name" : null));
    renderModal({ initialValue: "ok", validate, onSubmit });

    typeInto(queryInput(), "bad");
    expect(isDisabled(queryButton("submit"))).toBe(true);

    pressEnter(queryInput());
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    const error = document.querySelector<HTMLElement>('[data-testid="rename-modal-error"]');
    expect(error?.textContent).toContain("Invalid name");
  });

  it("disables the submit and cancel buttons while onSubmit is pending", async () => {
    let resolve: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    renderModal({ initialValue: "main", onSubmit });

    typeInto(queryInput(), "main-renamed");
    press(queryButton("submit"));
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(isDisabled(queryButton("submit"))).toBe(true);
    expect(isDisabled(queryButton("cancel"))).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("keeps the modal open with an error when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Server said no"));
    const onClose = vi.fn();
    renderModal({ initialValue: "main", onSubmit, onClose });

    typeInto(queryInput(), "main-renamed");
    press(queryButton("submit"));
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    const error = document.querySelector<HTMLElement>('[data-testid="rename-modal-error"]');
    expect(error?.textContent).toContain("Server said no");
    expect(isDisabled(queryButton("submit"))).toBe(false);
  });
});
