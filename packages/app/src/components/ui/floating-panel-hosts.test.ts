import { describe, expect, it } from "vitest";
import {
  createFloatingPanelHosts,
  type FloatingPanelHostRect,
  type MeasurableFloatingPanelHost,
} from "./floating-panel-hosts";

function createHost(rect: FloatingPanelHostRect): MeasurableFloatingPanelHost {
  return {
    measureInWindow: (callback) => callback(rect.x, rect.y, rect.width, rect.height),
  };
}

const WORKSPACE_RECT: FloatingPanelHostRect = { x: 10, y: 20, width: 800, height: 600 };
const RETAINED_VIEWPORT: FloatingPanelHostRect = { x: 0, y: 0, width: 1200, height: 900 };

describe("floating panel hosts", () => {
  it("measures the newest host registered under the name", async () => {
    const hosts = createFloatingPanelHosts();
    hosts.register("workspace", createHost(WORKSPACE_RECT));
    hosts.register("workspace", createHost(RETAINED_VIEWPORT));

    expect(await hosts.measure("workspace")).toEqual(RETAINED_VIEWPORT);
  });

  it("keeps measuring a survivor after the newest host unregisters", async () => {
    const hosts = createFloatingPanelHosts();
    const unregisterSurvivor = hosts.register("workspace", createHost(WORKSPACE_RECT));
    const unregisterNewest = hosts.register("workspace", createHost(RETAINED_VIEWPORT));

    unregisterNewest();

    expect(await hosts.measure("workspace")).toEqual(WORKSPACE_RECT);
    unregisterSurvivor();
  });

  it("returns null once every host under the name is gone", async () => {
    const hosts = createFloatingPanelHosts();
    const unregisterFirst = hosts.register("workspace", createHost(WORKSPACE_RECT));
    const unregisterSecond = hosts.register("workspace", createHost(RETAINED_VIEWPORT));

    unregisterFirst();
    unregisterSecond();

    expect(await hosts.measure("workspace")).toBeNull();
  });

  it("skips hosts that are not laid out", async () => {
    const hosts = createFloatingPanelHosts();
    hosts.register("workspace", createHost(WORKSPACE_RECT));
    hosts.register("workspace", createHost({ x: 0, y: 0, width: 0, height: 0 }));

    expect(await hosts.measure("workspace")).toEqual(WORKSPACE_RECT);
  });

  it("ignores a repeated unregister of the same host", async () => {
    const hosts = createFloatingPanelHosts();
    const unregister = hosts.register("workspace", createHost(WORKSPACE_RECT));

    unregister();
    unregister();

    expect(await hosts.measure("workspace")).toBeNull();
  });
});
