import React, { act, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusOwnerScope } from "@/components/ui/focus-owner/index.web";
import { useEmbedFocus } from "./focus.web";
import {
  byTestId,
  embedState,
  mountEmbedFocusScreen,
  pointerDown,
} from "./test-utils/embed-focus-screen";

vi.stubGlobal("React", React);

const screen = mountEmbedFocusScreen({ useEmbedFocus, FocusOwnerScope });
afterEach(screen.unmount);

describe("web embed focus follows the React tree, across portals", () => {
  it("gorhom's portal re-mounts its children under the host, outside the embed's nodes", () => {
    screen.render();
    expect(byTestId("left-root").contains(byTestId("left-gorhom"))).toBe(false);
    expect(byTestId("left-root").contains(byTestId("left-dom"))).toBe(false);
  });

  it("a press in an embed's gorhom portal focuses that embed and blurs the other", () => {
    screen.render();
    pointerDown("right-root");
    expect(embedState("right")).toBe("focused");
    pointerDown("left-gorhom");
    expect(embedState("left")).toBe("focused");
    expect(embedState("right")).toBe("blurred");
  });

  it("a press in an embed's react-dom portal focuses that embed and blurs the other", () => {
    screen.render();
    pointerDown("left-root");
    pointerDown("right-dom");
    expect(embedState("right")).toBe("focused");
    expect(embedState("left")).toBe("blurred");
  });

  it("a press outside every embed blurs the focused one", () => {
    screen.render();
    pointerDown("left-gorhom");
    expect(embedState("left")).toBe("focused");
    pointerDown("outside");
    expect(embedState("left")).toBe("blurred");
  });

  it("a focus move React makes while it commits still focuses the embed it lands in", () => {
    // A closing picker hands focus back to its trigger from its unmount; React drops the
    // synthetic `focusin` of a move made during its commit.
    function FocusOnUnmount() {
      useLayoutEffect(() => () => byTestId("left-input").focus(), []);
      return null;
    }
    screen.render(
      <>
        <input data-testid="unused" />
        <FocusOnUnmount />
      </>,
    );
    const input = document.createElement("input");
    input.setAttribute("data-testid", "left-input");
    act(() => byTestId("left-root").appendChild(input));
    pointerDown("right-root");
    screen.render();
    expect(document.activeElement).toBe(input);
    expect(embedState("left")).toBe("focused");
    act(() => input.remove());
  });

  it("a focus move into an embed's portal focuses it", () => {
    screen.render();
    const input = document.createElement("input");
    act(() => {
      byTestId("right-dom").appendChild(input);
      input.focus();
    });
    expect(embedState("right")).toBe("focused");
    act(() => input.remove());
  });
});
