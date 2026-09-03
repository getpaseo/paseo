import { afterEach, describe, expect, it } from "vitest";
import {
  createFindSurfaceRegistry,
  type FindSurfaceRegistration,
  type FindSurfaceRegistryPorts,
} from "./surface-registry.web";

const mounted: HTMLElement[] = [];

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  return root;
}

function surface(
  key: string,
  root: HTMLElement,
  overrides: Partial<FindSurfaceRegistration> = {},
): FindSurfaceRegistration {
  return {
    key,
    getRoot: () => root,
    isInteractive: false,
    host: "main",
    isOpen: false,
    ...overrides,
  };
}

interface TestPorts extends FindSurfaceRegistryPorts {
  activeElement: Element | null;
  pointerDown: (target: Node) => void;
  listenerCount: number;
}

function testPorts(): TestPorts {
  const listeners = new Set<(target: Node | null) => void>();
  const ports: TestPorts = {
    activeElement: null,
    listenerCount: 0,
    getActiveElement: () => ports.activeElement,
    addPointerListener: (listener) => {
      listeners.add(listener);
      ports.listenerCount = listeners.size;
      return () => {
        listeners.delete(listener);
        ports.listenerCount = listeners.size;
      };
    },
    pointerDown: (target) => {
      for (const listener of listeners) {
        listener(target);
      }
    },
  };
  return ports;
}

afterEach(() => {
  for (const root of mounted.splice(0)) {
    root.remove();
  }
});

describe("createFindSurfaceRegistry", () => {
  it("resolves the surface whose root contains the focused element", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const explorerRoot = mountRoot();
    const mainRoot = mountRoot();
    const focused = document.createElement("input");
    explorerRoot.append(focused);

    registry.register(surface("explorer", explorerRoot, { host: "explorer", isInteractive: true }));
    registry.register(surface("main", mainRoot, { isInteractive: true }));
    ports.activeElement = focused;

    expect(registry.resolveActive()?.key).toBe("explorer");
  });

  it("falls back to the last pointerdown when focus sits on the document body", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const explorerRoot = mountRoot();
    const mainRoot = mountRoot();
    const clicked = document.createElement("span");
    explorerRoot.append(clicked);

    registry.register(surface("explorer", explorerRoot, { host: "explorer", isInteractive: true }));
    registry.register(surface("main", mainRoot, { isInteractive: true }));
    ports.activeElement = document.body;
    ports.pointerDown(clicked);

    expect(registry.resolveActive()?.key).toBe("explorer");
  });

  it("prefers the focused surface over the last pointerdown", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const explorerRoot = mountRoot();
    const mainRoot = mountRoot();
    const clicked = document.createElement("span");
    explorerRoot.append(clicked);
    const focused = document.createElement("input");
    mainRoot.append(focused);

    registry.register(surface("explorer", explorerRoot, { host: "explorer" }));
    registry.register(surface("main", mainRoot));
    ports.pointerDown(clicked);
    ports.activeElement = focused;

    expect(registry.resolveActive()?.key).toBe("main");
  });

  it("falls back to the interactive main-host surface when nothing is focused or clicked", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const explorerRoot = mountRoot();
    const mainRoot = mountRoot();

    registry.register(surface("explorer", explorerRoot, { host: "explorer", isInteractive: true }));
    registry.register(surface("main", mainRoot, { isInteractive: true }));

    expect(registry.resolveActive()?.key).toBe("main");
  });

  it("resolves nothing when no surface is interactive", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);

    registry.register(surface("main", mountRoot()));

    expect(registry.resolveActive()).toBeNull();
  });

  it("drops the pointer entry when its surface unregisters", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const explorerRoot = mountRoot();
    const mainRoot = mountRoot();
    const clicked = document.createElement("span");
    explorerRoot.append(clicked);

    const unregisterExplorer = registry.register(
      surface("explorer", explorerRoot, { host: "explorer", isInteractive: true }),
    );
    registry.register(surface("main", mainRoot, { isInteractive: true }));
    ports.pointerDown(clicked);
    unregisterExplorer();

    expect(registry.resolveActive()?.key).toBe("main");
  });

  // Clicking a pane that owns no find surface (an image preview, a Changes pane) moves
  // pane focus without hitting any registered root; Cmd+F must fall through to the
  // browser rather than open the bar in the pane the user clicked away from.
  it("ignores the pointer entry once its surface stops being interactive", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const transcriptRoot = mountRoot();
    const clicked = document.createElement("span");
    transcriptRoot.append(clicked);
    const transcript = surface("transcript", transcriptRoot, { isInteractive: true });

    registry.register(transcript);
    ports.activeElement = document.body;
    ports.pointerDown(clicked);
    expect(registry.resolveActive()?.key).toBe("transcript");

    transcript.isInteractive = false;

    expect(registry.resolveActive()).toBeNull();
  });

  it("keeps exactly one document listener and releases it with the last surface", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);

    const unregisterFirst = registry.register(surface("first", mountRoot()));
    const unregisterSecond = registry.register(surface("second", mountRoot()));
    expect(ports.listenerCount).toBe(1);

    unregisterFirst();
    expect(ports.listenerCount).toBe(1);

    unregisterSecond();
    expect(ports.listenerCount).toBe(0);
  });

  it("reports the open state of the surface that owns the shortcut", () => {
    const ports = testPorts();
    const registry = createFindSurfaceRegistry(ports);
    const mainRoot = mountRoot();
    const focused = document.createElement("input");
    mainRoot.append(focused);

    registry.register(surface("main", mainRoot, { isOpen: true }));
    ports.activeElement = focused;

    expect(registry.resolveActive()?.isOpen).toBe(true);
  });
});
