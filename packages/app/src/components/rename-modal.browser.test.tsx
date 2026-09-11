import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { AdaptiveRenameModal } from "./rename-modal";

function noop(): void {}

const INPUT_LABEL = "Rename workspace";
const SUBMIT_LABEL = "Rename";
const PENDING_LABEL = "Saving...";
const CANCEL_LABEL = "Cancel";

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
        title={INPUT_LABEL}
        initialValue={initialValue}
        submitLabel={SUBMIT_LABEL}
        onClose={onClose ?? noop}
        onSubmit={onSubmit ?? noop}
        validate={validate}
        testID="rename-modal"
      />,
    );
  });
  mountedModals.push({ root, container });
}

function accessibleName(element: HTMLElement): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

function queryNamedInput(name: string): HTMLInputElement {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
    (candidate) => accessibleName(candidate) === name,
  );
  if (!input) throw new Error(`No textbox named "${name}" is rendered`);
  return input;
}

function queryNamedButton(name: string): HTMLElement {
  const button = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
    (candidate) => accessibleName(candidate) === name,
  );
  if (!button) throw new Error(`No button named "${name}" is rendered`);
  return button;
}

function queryError(): HTMLElement {
  const error = document.querySelector<HTMLElement>('[data-testid="rename-modal-error"]');
  if (!error) throw new Error("Rename modal did not render its error text");
  return error;
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

/**
 * The modal focuses and selects on a 50 ms timeout after mount. Poll the
 * observable readiness condition rather than a wall-clock delay so the test
 * passes deterministically regardless of scheduler jitter.
 */
async function waitForFullySelectedInput(
  input: HTMLInputElement,
  expectedValue: string,
): Promise<void> {
  const expectedEnd = expectedValue.length;
  await vi.waitFor(
    () => {
      if (document.activeElement !== input) {
        throw new Error("rename input is not focused yet");
      }
      if (input.selectionStart !== 0 || input.selectionEnd !== expectedEnd) {
        throw new Error("rename input is not fully selected yet");
      }
    },
    { timeout: 5000, interval: 10 },
  );
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
    const input = queryNamedInput(INPUT_LABEL);
    expect(input.value).toBe("main");

    await waitForFullySelectedInput(input, "main");

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("main".length);
  });

  it("submits on Enter keypress in the input when the value has changed", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderModal({ initialValue: "feature", onSubmit, onClose });

    typeInto(queryNamedInput(INPUT_LABEL), "feature-2");
    pressEnter(queryNamedInput(INPUT_LABEL));
    await flush();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("feature-2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the cancel button is pressed", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onClose, onSubmit });

    press(queryNamedButton(CANCEL_LABEL));
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables submit when the draft equals the initial value and re-enables after a change", async () => {
    const onSubmit = vi.fn();
    renderModal({ initialValue: "main", onSubmit });

    expect(isDisabled(queryNamedButton(SUBMIT_LABEL))).toBe(true);

    pressEnter(queryNamedInput(INPUT_LABEL));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto(queryNamedInput(INPUT_LABEL), "main-v2");
    await flush();
    expect(isDisabled(queryNamedButton(SUBMIT_LABEL))).toBe(false);

    typeInto(queryNamedInput(INPUT_LABEL), "main");
    await flush();
    expect(isDisabled(queryNamedButton(SUBMIT_LABEL))).toBe(true);
  });

  it("surfaces validate errors inline and blocks submission", async () => {
    const onSubmit = vi.fn();
    const validate = vi.fn((value: string) => (value === "bad" ? "Invalid name" : null));
    renderModal({ initialValue: "ok", validate, onSubmit });

    typeInto(queryNamedInput(INPUT_LABEL), "bad");
    expect(isDisabled(queryNamedButton(SUBMIT_LABEL))).toBe(true);

    pressEnter(queryNamedInput(INPUT_LABEL));
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(queryError().textContent).toContain("Invalid name");
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

    typeInto(queryNamedInput(INPUT_LABEL), "main-renamed");
    press(queryNamedButton(SUBMIT_LABEL));
    await flush();

    // While pending the submit button swaps its accessible name to "Saving...".
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(isDisabled(queryNamedButton(PENDING_LABEL))).toBe(true);
    expect(isDisabled(queryNamedButton(CANCEL_LABEL))).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("keeps the modal open with an error when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Server said no"));
    const onClose = vi.fn();
    renderModal({ initialValue: "main", onSubmit, onClose });

    typeInto(queryNamedInput(INPUT_LABEL), "main-renamed");
    press(queryNamedButton(SUBMIT_LABEL));
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(queryError().textContent).toContain("Server said no");
    expect(isDisabled(queryNamedButton(SUBMIT_LABEL))).toBe(false);
  });
});
