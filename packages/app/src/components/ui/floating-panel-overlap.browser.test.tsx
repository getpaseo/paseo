import React, { act, Profiler, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";
import { Portal, PortalHost, PortalProvider } from "@gorhom/portal";
import { FloatingPanelPortalHost, measureFloatingPanelPortalHost } from "./floating-panel-portal";

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:800px;height:600px";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    render: (next: React.ReactElement) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Floating panel host lifetime", () => {
  test("removing the newest host preserves the surviving host measurement", async () => {
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
    const view = await mount(<Content overlap={true} />);
    try {
      expect(await measureFloatingPanelPortalHost("workspace")).toMatchObject({
        width: 800,
        height: 600,
      });
      await view.render(<Content overlap={false} />);
      expect(await measureFloatingPanelPortalHost("workspace")).toMatchObject({
        width: 800,
        height: 600,
      });
    } finally {
      await view.unmount();
    }
  });
});

const rendered: string[] = [];

function record(id: string) {
  rendered.push(id);
}

describe("Portal hosts", () => {
  test("opening a portal renders its own host and no other", async () => {
    let setCardOpen: (open: boolean) => void = () => {};
    function Card() {
      const [open, setOpen] = useState(false);
      setCardOpen = setOpen;
      if (!open) return null;
      return (
        <Portal hostName="sidebar" name="card">
          <div data-testid="card">Workspace</div>
        </Portal>
      );
    }
    const view = await mount(
      <PortalProvider shouldAddRootHost={false}>
        <Profiler id="sidebar" onRender={record}>
          <PortalHost name="sidebar" />
        </Profiler>
        <Profiler id="workspace" onRender={record}>
          <PortalHost name="workspace" />
        </Profiler>
        <Card />
      </PortalProvider>,
    );
    try {
      rendered.length = 0;
      await act(async () => setCardOpen(true));

      expect(view.container.querySelector('[data-testid="card"]')?.textContent).toBe("Workspace");
      expect(rendered).toContain("sidebar");
      expect(rendered).not.toContain("workspace");

      rendered.length = 0;
      await act(async () => setCardOpen(false));

      expect(view.container.querySelector('[data-testid="card"]')).toBeNull();
      expect(rendered).not.toContain("workspace");
    } finally {
      await view.unmount();
    }
  });

  test("closing an earlier portal keeps a later portal mounted", async () => {
    let menuMounts = 0;
    function Menu() {
      useEffect(() => {
        menuMounts += 1;
      }, []);
      return <div data-testid="menu">Menu</div>;
    }
    function Content({ tooltip }: { tooltip: boolean }) {
      return (
        <PortalProvider shouldAddRootHost={false}>
          <PortalHost name="workspace" />
          {tooltip && (
            <Portal hostName="workspace" name="tooltip">
              <span data-testid="tooltip">Tooltip</span>
            </Portal>
          )}
          <Portal hostName="workspace" name="menu">
            <Menu />
          </Portal>
        </PortalProvider>
      );
    }
    const view = await mount(<Content tooltip={true} />);
    try {
      expect(view.container.querySelector('[data-testid="tooltip"]')).not.toBeNull();
      expect(menuMounts).toBe(1);

      await view.render(<Content tooltip={false} />);

      expect(view.container.querySelector('[data-testid="tooltip"]')).toBeNull();
      expect(view.container.querySelector('[data-testid="menu"]')).not.toBeNull();
      expect(menuMounts).toBe(1);
    } finally {
      await view.unmount();
    }
  });
});
