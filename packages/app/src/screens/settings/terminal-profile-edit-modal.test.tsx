import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalProfileEditModal, type ProfileDraft } from "./terminal-profile-edit-modal";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 3: 12, 4: 16 },
    fontSize: { sm: 13, base: 15, xs: 11 },
    fontWeight: { medium: 500 },
    borderRadius: { lg: 8 },
    colors: {
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      palette: { red: { 300: "#f87171" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const inputPropsByTestID = vi.hoisted(() => ({
  map: new Map<string, { onChangeText?: (next: string) => void; onSubmitEditing?: () => void }>(),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    visible,
    title,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    testID?: string;
  }) => {
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID ?? "adaptive-modal-sheet", "data-modal-title": title },
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": "adaptive-modal-sheet-close",
          onClick: onClose,
        },
        "Close",
      ),
      children,
    );
  };
  const AdaptiveTextInput = ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>(
    (props, ref) => {
      const p = props as {
        initialValue?: string;
        defaultValue?: string;
        editable?: boolean;
        testID?: string;
        onChangeText?: (next: string) => void;
        onSubmitEditing?: () => void;
      };
      if (p.testID) {
        inputPropsByTestID.map.set(p.testID, {
          onChangeText: p.onChangeText,
          onSubmitEditing: p.onSubmitEditing,
        });
      }
      return ReactModule.createElement("input", {
        ref,
        defaultValue: p.initialValue ?? p.defaultValue ?? "",
        disabled: p.editable === false,
        "data-testid": p.testID,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === "Enter") {
            e.preventDefault();
            p.onSubmitEditing?.();
          }
        },
      });
    },
  );
  return { AdaptiveModalSheet, AdaptiveTextInput };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": testID,
          disabled: disabled || undefined,
          onClick: () => !disabled && onPress?.(),
        },
        children,
      ),
  };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface RenderOptions {
  visible?: boolean;
  title?: string;
  initialDraft?: ProfileDraft;
  onClose?: () => void;
  onSave?: (draft: ProfileDraft) => Promise<void>;
}

function renderModal(options: RenderOptions = {}): void {
  const {
    visible = true,
    title = "Add terminal profile",
    initialDraft = { name: "", command: "", args: "" },
    onClose = vi.fn(),
    onSave = vi.fn().mockResolvedValue(undefined),
  } = options;
  act(() => {
    root?.render(
      <TerminalProfileEditModal
        visible={visible}
        title={title}
        initialDraft={initialDraft}
        onClose={onClose}
        onSave={onSave}
        testID="terminal-profile-edit-modal"
      />,
    );
  });
}

function queryInput(testID: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
}

function querySubmit(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="terminal-profile-save-button"]');
}

function queryCancel(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="terminal-profile-cancel-button"]',
  );
}

function queryError(testID: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function click(element: Element | null): void {
  if (!element) throw new Error("Cannot click null element");
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(testID: string, value: string): void {
  act(() => {
    const input = queryInput(testID);
    if (!input) throw new Error(`Input ${testID} not found`);
    input.value = value;
    inputPropsByTestID.map.get(testID)?.onChangeText?.(value);
  });
}

function pressEnter(testID: string): void {
  act(() => {
    inputPropsByTestID.map.get(testID)?.onSubmitEditing?.();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalProfileEditModal", () => {
  it("renders with the initial draft pre-filled", () => {
    renderModal({
      initialDraft: { name: "Claude Code", command: "claude", args: "--skip" },
    });

    expect(queryInput("terminal-profile-name-input")?.value).toBe("Claude Code");
    expect(queryInput("terminal-profile-command-input")?.value).toBe("claude");
    expect(queryInput("terminal-profile-args-input")?.value).toBe("--skip");
  });

  it("calls onSave with trimmed values and closes on success", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderModal({ onSave, onClose });

    typeInto("terminal-profile-name-input", "  Codex  ");
    typeInto("terminal-profile-command-input", "  codex  ");
    typeInto("terminal-profile-args-input", "  --flag  ");
    click(querySubmit());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: "Codex",
      command: "codex",
      args: "  --flag  ",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows inline validation errors for empty required fields", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSave });

    click(querySubmit());
    await flush();

    expect(onSave).not.toHaveBeenCalled();
    expect(queryError("terminal-profile-name-field-error")?.textContent).toContain(
      "settings.host.terminalProfiles.nameRequired",
    );
    expect(queryError("terminal-profile-command-field-error")?.textContent).toContain(
      "settings.host.terminalProfiles.commandRequired",
    );
  });

  it("clears validation errors when the user types", async () => {
    renderModal();

    click(querySubmit());
    await flush();
    expect(queryError("terminal-profile-name-field-error")).not.toBeNull();

    typeInto("terminal-profile-name-input", "Codex");
    await flush();
    expect(queryError("terminal-profile-name-field-error")).toBeNull();
  });

  it("disables save and cancel while onSave is pending", async () => {
    let resolve: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    renderModal({ onSave });

    typeInto("terminal-profile-name-input", "Codex");
    typeInto("terminal-profile-command-input", "codex");
    click(querySubmit());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(querySubmit()?.disabled).toBe(true);
    expect(queryCancel()?.disabled).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("keeps the modal open with an error when onSave rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Server said no"));
    const onClose = vi.fn();
    renderModal({ onSave, onClose });

    typeInto("terminal-profile-name-input", "Codex");
    typeInto("terminal-profile-command-input", "codex");
    click(querySubmit());
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLElement>('[data-testid="terminal-profile-submit-error"]')
        ?.textContent,
    ).toContain("Server said no");
    expect(querySubmit()?.disabled).toBe(false);
  });

  it("calls onClose when the cancel button is clicked", () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onClose, onSave });

    click(queryCancel());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits the form when Enter is pressed in the args field", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSave });

    typeInto("terminal-profile-name-input", "Codex");
    typeInto("terminal-profile-command-input", "codex");
    pressEnter("terminal-profile-args-input");
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: "Codex",
      command: "codex",
      args: "",
    });
  });
});
