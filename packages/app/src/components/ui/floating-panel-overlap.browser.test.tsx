import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";
import { Portal, PortalProvider } from "@gorhom/portal";
import { FloatingPanelPortalHost, measureFloatingPanelPortalHost } from "./floating-panel-portal";

describe("Floating panel host lifetime", () => {
  test("removing the newest host preserves the surviving host measurement", async () => {
    const container = document.createElement("div");
    container.style.cssText = "position:relative;width:800px;height:600px";
    document.body.appendChild(container);
    const root = createRoot(container);
    function Content({ overlap }: { overlap: boolean }) {
      return (
        <PortalProvider shouldAddRootHost={false}>
          <FloatingPanelPortalHost name="workspace" />
          {overlap && <FloatingPanelPortalHost name="workspace" />}
          <Portal hostName="workspace" name="picker">
            <div data-testid="picker">Commands</div>
          </Portal>
        </PortalProvider>
      );
    }
    try {
      await act(async () => root.render(<Content overlap={true} />));
      expect(await measureFloatingPanelPortalHost("workspace")).not.toBeNull();
      await act(async () => root.render(<Content overlap={false} />));
      expect(await measureFloatingPanelPortalHost("workspace")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
