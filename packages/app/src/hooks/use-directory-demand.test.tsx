/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useDirectoryDemand } from "./use-directory-demand";

function Probe({ serverId }: { serverId: string | null }) {
  useDirectoryDemand(serverId);
  return null;
}

describe("useDirectoryDemand", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  it("demands the host directory while mounted and releases it on unmount", () => {
    const release = vi.fn();
    const acquire = vi
      .spyOn(getHostRuntimeStore(), "acquireDirectoryDemand")
      .mockImplementation(() => release);
    const container = document.createElement("div");
    root = createRoot(container);

    act(() => root?.render(<Probe serverId="srv_a" />));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith("srv_a");
    expect(release).not.toHaveBeenCalled();

    act(() => root?.render(<Probe serverId={null} />));
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
