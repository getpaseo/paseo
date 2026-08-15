/**
 * @vitest-environment jsdom
 */
import React from "react";
import { PortalProvider } from "@gorhom/portal";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { SelectedTextAnnotations } from "./selected-text-annotations";

beforeEach(() => vi.stubGlobal("React", React));

const labels = { count: "1 comment", remove: "Remove", noComment: "No comment" };

describe("SelectedTextAnnotations", () => {
  it("starts collapsed and keeps an explicit collapse after hover ends", async () => {
    const onOpen = vi.fn();
    const view = render(
      <PortalProvider>
        <FloatingPanelPortalHost />
        <SelectedTextAnnotations
          annotations={Array.from({ length: 20 }, (_, index) => ({
            kind: "selected_text" as const,
            id: `selected_text:${index + 1}`,
            text: `selected response text ${index + 1}`,
            comment: "Explain this",
          }))}
          disabled={false}
          isPaneFocused
          labels={labels}
          onOpen={onOpen}
          onRemove={vi.fn()}
        />
      </PortalProvider>,
    );

    const root = view.getByTestId("composer-selected-text-annotations");
    const trigger = view.getByTestId("composer-selected-text-annotations-trigger");
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();

    fireEvent.pointerEnter(root);
    await waitFor(() =>
      expect(view.getByTestId("composer-selected-text-annotations-details")).toBeTruthy(),
    );
    const details = view.getByTestId("composer-selected-text-annotations-details");
    const list = view.getByTestId("composer-selected-text-annotations-list");
    expect(details.style.maxHeight).not.toBe("");
    expect(["auto", "scroll"]).toContain(window.getComputedStyle(list).overflowY);
    expect(document.getElementById("content-adornment-root")?.contains(details)).toBe(true);

    fireEvent.click(trigger);
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();

    fireEvent.pointerLeave(root);
    fireEvent.pointerEnter(root);
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(view.getByTestId("composer-selected-text-annotations-details")).toBeTruthy(),
    );

    fireEvent.pointerDown(document.body);
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(view.getByTestId("composer-selected-text-annotations-details")).toBeTruthy(),
    );

    fireEvent.blur(window);
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(view.getByTestId("composer-selected-text-annotations-details")).toBeTruthy(),
    );

    fireEvent.click(view.getByTestId("composer-selected-text-annotation-selected_text:1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId("composer-selected-text-annotations-details")).toBeNull();
  });
});
