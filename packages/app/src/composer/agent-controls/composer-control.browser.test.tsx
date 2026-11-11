import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Scan } from "lucide-react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { ComposerControls, type ComposerControlItem } from "./composer-control";
import { useAgentControlItems } from "./control-items";
import { resolveComposerControlPresentation } from "./layout";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(cleanup);

const base = { id: "x", title: "Context", icon: Scan };
// The sheet lays its rows out in a column, which is what stretches a row across it.
const SHEET_COLUMN = { display: "flex", flexDirection: "column", width: 382 } as const;

type RecordingToast = ToastApi & { error: ReturnType<typeof vi.fn> };

function createToast(): RecordingToast {
  return { error: vi.fn() } as unknown as RecordingToast;
}

function ignoreOpenChange() {}

function Controls({
  items,
  surface,
  toast,
}: {
  items: ComposerControlItem[];
  surface: "toolbar" | "sheet";
  toast: ToastApi;
}) {
  return (
    <ToastApiProvider api={toast}>
      <ComposerControls
        items={items}
        surface={surface}
        openId={null}
        onOpenIdChange={ignoreOpenChange}
      />
    </ToastApiProvider>
  );
}

function renderControls(items: ComposerControlItem[], surface: "toolbar" | "sheet" = "toolbar") {
  const toast = createToast();
  render(<Controls items={items} surface={surface} toast={toast} />);
  return toast;
}

describe("ComposerControls", () => {
  it("shows a select's chosen label, or only its icon when asked", () => {
    const select: ComposerControlItem = {
      ...base,
      type: "select",
      value: "large",
      choices: [
        { value: "small", label: "Small" },
        { value: "large", label: "Large" },
      ],
      onChange: () => undefined,
    };
    renderControls([select]);
    expect(screen.getByRole("button", { name: "Context" }).textContent).toContain("Large");
  });

  it("names the choice on an icon-only select, without drawing it", () => {
    renderControls([
      {
        ...base,
        type: "select",
        value: "large",
        iconOnly: true,
        choices: [{ value: "large", label: "Large" }],
        onChange: () => undefined,
      },
    ]);
    const trigger = screen.getByRole("button", { name: "Context: Large" });
    expect(trigger.textContent).not.toContain("Large");
  });

  it("flips a toggle on press in the toolbar", () => {
    const onChange = vi.fn();
    renderControls([{ ...base, type: "toggle", value: true, onChange }]);
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("lists a toggle as On or Off in the sheet", () => {
    renderControls([{ ...base, type: "toggle", value: true, onChange: () => undefined }], "sheet");
    expect(screen.getByRole("button", { name: "Context" }).textContent).toContain("On");
  });

  it("gives a sheet row's value the row's width, so a short value is not truncated", () => {
    const toast = createToast();
    render(
      <div style={SHEET_COLUMN}>
        <Controls
          items={[
            {
              ...base,
              type: "select",
              value: "full",
              choices: [{ value: "full", label: "Full access" }],
              onChange: () => undefined,
            },
          ]}
          surface="sheet"
          toast={toast}
        />
      </div>,
    );
    const value = screen.getByText("Full access");
    expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
  });

  it("reports a failed command the way a built-in control does, and frees the control", async () => {
    let reject: (error: Error) => void = () => undefined;
    const onPress = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const toast = renderControls([{ ...base, type: "action", onPress }]);
    const button = screen.getByRole("button", { name: "Context" });

    fireEvent.click(button);
    // While the command is in flight the control cannot be pressed again.
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);

    reject(new Error("Unknown or unavailable provider: x"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Unknown or unavailable provider: x"),
    );
    await waitFor(() => expect(button.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("reports a command that throws before it returns", () => {
    const toast = renderControls([
      {
        ...base,
        type: "action",
        onPress: () => {
          throw new Error("No such control");
        },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(toast.error).toHaveBeenCalledWith("No such control");
  });
});

const FAST_ON = { fast_mode: true };

describe("provider option controls", () => {
  const fastMode: AgentOptionControl = {
    type: "toggle",
    key: "fast_mode",
    label: "Fast",
    defaultValue: false,
  };
  function OptionControls({
    options,
    onSetOption,
  }: {
    options: Record<string, unknown>;
    onSetOption: (key: string, value: unknown) => void;
  }) {
    const optionControls = React.useMemo(
      () => ({ controls: [fastMode], options, onSetOption }),
      [onSetOption, options],
    );
    const items = useAgentControlItems({
      surface: "toolbar",
      presentation: resolveComposerControlPresentation("full"),
      thinking: null,
      optionControls,
    });
    return <Controls items={items.features} surface="toolbar" toast={TOAST} />;
  }
  const TOAST = createToast();

  function recordWrites(writes: Array<[string, unknown]>) {
    return (key: string, value: unknown) => void writes.push([key, value]);
  }

  it("write the toggled option from the agent's current options", () => {
    const writes: Array<[string, unknown]> = [];
    const onSetOption = recordWrites(writes);
    render(<OptionControls options={FAST_ON} onSetOption={onSetOption} />);
    fireEvent.click(screen.getByTestId("agent-feature-fast_mode"));
    expect(writes).toEqual([["fast_mode", false]]);
  });
});
