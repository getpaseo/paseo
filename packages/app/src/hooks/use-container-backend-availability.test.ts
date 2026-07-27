// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  selectableContainerBackends,
  useContainerBackendAvailability,
  type AvailableBackendInfo,
} from "./use-container-backend-availability";

function backend(overrides: Partial<AvailableBackendInfo> = {}): AvailableBackendInfo {
  return {
    id: "devcontainer",
    label: "Dev Container",
    available: true,
    hasConfig: true,
    ...overrides,
  };
}

function createClient(byDirectory: Record<string, AvailableBackendInfo[]>): DaemonClient {
  return {
    checkContainerAvailability: vi.fn(async (cwd: string) => ({
      backends: byDirectory[cwd] ?? [],
    })),
  } as unknown as DaemonClient;
}

describe("selectableContainerBackends", () => {
  it("offers only backends that are installed and configured for the directory", () => {
    const selectable = selectableContainerBackends({
      backends: [
        backend({ id: "configured" }),
        backend({ id: "not-installed", available: false }),
        backend({ id: "no-config", hasConfig: false }),
      ],
    });

    expect(selectable.map((entry) => entry.id)).toEqual(["configured"]);
  });

  it("offers nothing when availability is unknown", () => {
    // Host is always implicit, so an empty result means there is no choice to
    // show the user at all.
    expect(selectableContainerBackends(null)).toEqual([]);
  });
});

describe("useContainerBackendAvailability", () => {
  it("keeps a selection the next directory still offers", async () => {
    const client = createClient({
      "/repo/app": [backend()],
      "/repo/other": [backend()],
    });
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string }) => useContainerBackendAvailability(client, cwd),
      { initialProps: { cwd: "/repo/app" } },
    );

    await waitFor(() => expect(result.current.containerAvailability).not.toBeNull());
    act(() => result.current.setContainerBackend("devcontainer"));
    rerender({ cwd: "/repo/other" });

    await waitFor(() =>
      expect(selectableContainerBackends(result.current.containerAvailability)).toHaveLength(1),
    );
    expect(result.current.containerBackend).toBe("devcontainer");
  });

  it("drops a selection the next directory cannot offer", async () => {
    // Otherwise the workspace would be created asking for a container the new
    // directory has no config for, with the picker hidden and no way to undo it.
    const client = createClient({
      "/repo/app": [backend()],
      "/repo/plain": [backend({ hasConfig: false })],
    });
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd: string }) => useContainerBackendAvailability(client, cwd),
      { initialProps: { cwd: "/repo/app" } },
    );

    await waitFor(() => expect(result.current.containerAvailability).not.toBeNull());
    act(() => result.current.setContainerBackend("devcontainer"));
    rerender({ cwd: "/repo/plain" });

    await waitFor(() => expect(result.current.containerBackend).toBeNull());
  });
});
