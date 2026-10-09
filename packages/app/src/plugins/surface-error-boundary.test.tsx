/**
 * @vitest-environment jsdom
 */
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { SurfaceErrorBoundary } from "./surface-error-boundary";

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: object) => object) =>
      factory({ colors: { statusDanger: "red" }, spacing: [0, 4, 8, 12, 16] }),
  },
}));

let oldSurfaceCleanups = 0;
function FailingSurface() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(true);
    return () => {
      oldSurfaceCleanups += 1;
    };
  }, []);
  if (failed) throw new Error("old render exploded");
  return <Text>Old surface mounted</Text>;
}
function CorrectedSurface() {
  return <Text>Corrected surface</Text>;
}
const oldInstallation = {};
const correctedInstallation = {};

describe("SurfaceErrorBoundary", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLElement[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    for (const container of containers.splice(0)) container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    oldSurfaceCleanups = 0;
  });

  it("recovers a mounted failed route when its installation and surface are replaced", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <SurfaceErrorBoundary
          key="host/plugin/surface"
          installation={oldInstallation}
          Surface={FailingSurface}
        >
          <FailingSurface />
        </SurfaceErrorBoundary>,
      );
    });
    expect(container.textContent).toBe("Plugin failed: old render exploded");
    expect(oldSurfaceCleanups).toBe(1);

    await act(async () => {
      root.render(
        <SurfaceErrorBoundary
          key="host/plugin/surface"
          installation={correctedInstallation}
          Surface={CorrectedSurface}
        >
          <CorrectedSurface />
        </SurfaceErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("Corrected surface");
    expect(oldSurfaceCleanups).toBe(1);
  });
});
