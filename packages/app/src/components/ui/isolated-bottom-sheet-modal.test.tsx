// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import React from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "./isolated-bottom-sheet-modal";

const { modalMethods, modalProps } = vi.hoisted(() => ({
  modalMethods: {
    present: vi.fn(),
    close: vi.fn(),
    snapToIndex: vi.fn(),
    dismiss: vi.fn(),
  },
  modalProps: vi.fn(),
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const React = await import("react");
  const MockBottomSheetModal = React.forwardRef(
    (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
      modalProps(props);
      React.useImperativeHandle(ref, () => modalMethods);
      return React.createElement(
        "div",
        { "data-testid": "bottom-sheet" },
        props.children as ReactNode,
      );
    },
  );

  return {
    BottomSheetModal: MockBottomSheetModal,
    BottomSheetModalProvider: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "bottom-sheet-provider" }, children),
  };
});

vi.mock("@gorhom/portal", async () => {
  const React = await import("react");
  return {
    Portal: ({ children, hostName }: { children: ReactNode; hostName?: string }) =>
      React.createElement("div", { "data-host": hostName, "data-testid": "app-portal" }, children),
  };
});

function Harness({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { sheetRef, handleSheetChange } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={["50%"]}
      onChange={handleSheetChange}
    >
      <div>Sheet content</div>
    </IsolatedBottomSheetModal>
  );
}

describe("IsolatedBottomSheetModal", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("forces sheet isolation and keeps modal content mounted while hidden", () => {
    const onClose = vi.fn();
    const { getByTestId, rerender } = render(<Harness visible={false} onClose={onClose} />);

    expect(getByTestId("app-portal").getAttribute("data-host")).toBe("root");
    expect(modalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enableDismissOnClose: false,
        stackBehavior: "replace",
      }),
    );
    expect(modalMethods.present).not.toHaveBeenCalled();

    rerender(<Harness visible onClose={onClose} />);
    expect(modalMethods.present).toHaveBeenCalledTimes(1);

    rerender(<Harness visible={false} onClose={onClose} />);
    expect(modalMethods.close).toHaveBeenCalledTimes(1);
    expect(modalMethods.dismiss).not.toHaveBeenCalled();

    rerender(<Harness visible onClose={onClose} />);
    expect(modalMethods.present).toHaveBeenCalledTimes(1);
    expect(modalMethods.snapToIndex).toHaveBeenCalledWith(0);
  });

  it("only reports a user close when the sheet was visible", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness visible onClose={onClose} />);

    const latestProps = modalProps.mock.lastCall?.[0] as { onChange: (index: number) => void };
    latestProps.onChange(-1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Harness visible={false} onClose={onClose} />);
    const closedProps = modalProps.mock.lastCall?.[0] as { onChange: (index: number) => void };
    closedProps.onChange(-1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("allows nested sheets inside a parent sheet without creating a sibling provider", () => {
    const { getAllByTestId } = render(
      <IsolatedBottomSheetModal index={0} snapPoints={["90%"]}>
        <IsolatedBottomSheetModal index={0} snapPoints={["60%"]} onChange={() => {}}>
          <div>Nested model picker</div>
        </IsolatedBottomSheetModal>
      </IsolatedBottomSheetModal>,
    );

    expect(getAllByTestId("bottom-sheet-provider")).toHaveLength(1);
    expect(modalProps).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stackBehavior: "replace",
      }),
    );
    expect(modalProps).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stackBehavior: "push",
      }),
    );
  });
});
