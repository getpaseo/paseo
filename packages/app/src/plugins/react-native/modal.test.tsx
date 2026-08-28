/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sheet = vi.hoisted(() => ({
  props: null as null | {
    visible: boolean;
    header: { title: string };
    onClose(): void;
    contextBridge(children: React.ReactNode): React.ReactNode;
  },
}));

vi.mock("@getpaseo/plugin/host", () => ({
  usePluginRuntimeContextBridge: () => (children: React.ReactNode) => children,
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: (props: typeof sheet.props & { children: React.ReactNode }) => {
    sheet.props = props;
    if (!props?.visible) return null;
    return <>{props.contextBridge(props.children)}</>;
  },
}));

import { Modal } from "./modal";

describe("plugin React Native Modal", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sheet.props = null;
    vi.unstubAllGlobals();
  });

  it("maps controlled state and dismissal onto Paseo's adaptive modal", () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Modal open onOpenChange={onOpenChange} title="Edit issue">
            <span>Issue form</span>
          </Modal>
        </QueryClientProvider>,
      );
    });

    expect(sheet.props?.visible).toBe(true);
    expect(sheet.props?.header.title).toBe("Edit issue");
    expect(container.textContent).toBe("Issue form");

    act(() => sheet.props?.onClose());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
