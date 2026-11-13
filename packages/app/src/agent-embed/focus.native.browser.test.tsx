import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusOwnerScope } from "@/components/ui/focus-owner/index.native";
import { useEmbedFocus } from "./focus.native";
import { embedState, mountEmbedFocusScreen, touchStart } from "./test-utils/embed-focus-screen";

// The native scope runs here on React DOM, whose touch events follow the React tree as React
// Native's do. The shared `Portal` must re-open the native scope, not the web one.
vi.mock("@/components/ui/focus-owner", () => import("@/components/ui/focus-owner/index.native"));
vi.stubGlobal("React", React);

const screen = mountEmbedFocusScreen({ useEmbedFocus, FocusOwnerScope });
afterEach(screen.unmount);

describe("native embed focus follows the React tree, across portals", () => {
  it("a touch in an embed's gorhom portal focuses that embed and blurs the other", () => {
    screen.render();
    touchStart("right-root");
    expect(embedState("right")).toBe("focused");
    touchStart("left-gorhom");
    expect(embedState("left")).toBe("focused");
    expect(embedState("right")).toBe("blurred");
  });

  it("a touch in an embed's portal that keeps the React tree focuses that embed", () => {
    screen.render();
    touchStart("left-root");
    touchStart("right-dom");
    expect(embedState("right")).toBe("focused");
    expect(embedState("left")).toBe("blurred");
  });

  it("a touch outside every embed leaves the last one focused", () => {
    screen.render();
    touchStart("left-gorhom");
    touchStart("outside");
    expect(embedState("left")).toBe("focused");
  });
});
