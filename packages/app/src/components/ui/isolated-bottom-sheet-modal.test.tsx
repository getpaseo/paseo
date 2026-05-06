// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import React from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "./isolated-bottom-sheet-modal";

const SNAP_POINTS_50: (string | number)[] = ["50%"];
const SNAP_POINTS_60: (string | number)[] = ["60%"];
const SNAP_POINTS_90: (string | number)[] = ["90%"];

function noop(): void {}

interface CapturedModalProps {
  onChange?: (index: number) => void;
  onDismiss?: () => void;
}

const { modalMethods, modalProps, shouldExposeModalRef } = vi.hoisted(() => ({
  modalMethods: {
    present: vi.fn(),
    close: vi.fn(),
    snapToIndex: vi.fn(),
    dismiss: vi.fn(),
  },
  modalProps: vi.fn(),
  shouldExposeModalRef: { current: true },
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const React = await import("react");
  const MockBottomSheetModal = React.forwardRef(
    (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
      modalProps(props);
      React.useImperativeHandle(ref, () => (shouldExposeModalRef.current ? modalMethods : null));
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
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={SNAP_POINTS_50}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
    >
      <div>Sheet content</div>
    </IsolatedBottomSheetModal>
  );
}

function latestModalProps(): CapturedModalProps {
  const props = modalProps.mock.lastCall?.[0];
  expect(props).toBeDefined();
  return props as CapturedModalProps;
}

describe("IsolatedBottomSheetModal", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    shouldExposeModalRef.current = true;
  });

  it("forces sheet isolation and uses the modal dismissal lifecycle", () => {
    const onClose = vi.fn();
    const { getByTestId, rerender } = render(<Harness visible={false} onClose={onClose} />);

    expect(getByTestId("app-portal").getAttribute("data-host")).toBe("root");
    expect(modalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enableDismissOnClose: true,
        stackBehavior: "replace",
      }),
    );
    expect(modalMethods.present).not.toHaveBeenCalled();

    rerender(<Harness visible onClose={onClose} />);
    expect(modalMethods.present).toHaveBeenCalledTimes(1);

    rerender(<Harness visible={false} onClose={onClose} />);
    expect(modalMethods.dismiss).toHaveBeenCalledTimes(1);
    expect(modalMethods.close).not.toHaveBeenCalled();

    rerender(<Harness visible onClose={onClose} />);
    expect(modalMethods.present).toHaveBeenCalledTimes(2);
    expect(modalMethods.snapToIndex).not.toHaveBeenCalled();
  });

  it("only reports a user close when the sheet was visible", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness visible onClose={onClose} />);

    latestModalProps().onChange?.(-1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Harness visible={false} onClose={onClose} />);
    latestModalProps().onChange?.(-1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a dismiss while visible as a close request", () => {
    const onClose = vi.fn();
    render(<Harness visible onClose={onClose} />);

    latestModalProps().onDismiss?.();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deduplicates close notifications from change and dismiss callbacks", () => {
    const onClose = vi.fn();
    render(<Harness visible onClose={onClose} />);

    const props = latestModalProps();
    props.onChange?.(-1);
    props.onDismiss?.();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("presents when the sheet ref becomes available after opening", () => {
    shouldExposeModalRef.current = false;
    const onClose = vi.fn();
    const { rerender } = render(<Harness visible onClose={onClose} />);

    expect(modalMethods.present).not.toHaveBeenCalled();
    expect(modalMethods.snapToIndex).not.toHaveBeenCalled();

    shouldExposeModalRef.current = true;
    rerender(<Harness visible onClose={onClose} />);

    expect(modalMethods.present).toHaveBeenCalledTimes(1);
    expect(modalMethods.snapToIndex).not.toHaveBeenCalled();
  });

  it("allows nested sheets inside a parent sheet without creating a sibling provider", () => {
    const { getAllByTestId } = render(
      <IsolatedBottomSheetModal index={0} snapPoints={SNAP_POINTS_90}>
        <IsolatedBottomSheetModal index={0} snapPoints={SNAP_POINTS_60} onChange={noop}>
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
