import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ContainerBackend = string | null;

export interface AvailableBackendInfo {
  id: string;
  label: string;
  available: boolean;
  hasConfig: boolean;
}

export interface ContainerAvailability {
  backends: AvailableBackendInfo[];
}

/**
 * The backends a user can actually pick for a directory: installed on the host
 * and configured for that directory. Host is always available on top of these,
 * so an empty result means there is no choice to offer.
 */
export function selectableContainerBackends(
  availability: ContainerAvailability | null,
): AvailableBackendInfo[] {
  return (availability?.backends ?? []).filter((backend) => backend.available && backend.hasConfig);
}

export function useContainerBackendAvailability(
  client: DaemonClient | null,
  sourceDirectory: string,
): {
  containerBackend: ContainerBackend;
  setContainerBackend: (value: ContainerBackend) => void;
  containerAvailability: ContainerAvailability | null;
} {
  const [containerBackend, setContainerBackend] = useState<ContainerBackend>(null);
  const [containerAvailability, setContainerAvailability] = useState<ContainerAvailability | null>(
    null,
  );

  useEffect(() => {
    if (!client || !sourceDirectory) {
      setContainerAvailability(null);
      setContainerBackend(null);
      return;
    }
    let cancelled = false;
    client
      .checkContainerAvailability(sourceDirectory)
      .then((result) => {
        if (cancelled) return;
        const availability = { backends: result.backends };
        setContainerAvailability(availability);
        // Default to Host (null). The user must explicitly pick a container
        // backend from the dropdown; availability is only fetched to populate
        // the dropdown options.
        //
        // A backend picked for a previous directory may not be offered for this
        // one — creating the workspace with it would ask for a container the
        // directory has no config for.
        const selectableIds = new Set(
          selectableContainerBackends(availability).map((backend) => backend.id),
        );
        setContainerBackend((current) => (current && !selectableIds.has(current) ? null : current));
        return undefined;
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[WorkspaceSetup] Failed to check container availability:", error);
        setContainerAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, sourceDirectory]);

  return { containerBackend, setContainerBackend, containerAvailability };
}
