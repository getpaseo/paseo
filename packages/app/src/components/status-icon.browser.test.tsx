import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_PULSE_PERIOD_MS } from "@/components/status-ring/geometry";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { StatusIcon } from "./status-icon";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * StatusIcon is how Command Center rows and workspace tabs show an agent's state, so it is where a
 * running agent's breathing ring has to reach them.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mountIcon(statusBucket: SidebarStateBucket): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <StatusIcon statusBucket={statusBucket} size={16} backdrop="surface2">
        <View />
      </StatusIcon>,
    ),
  );
  mounted.push({ root, container });
  const icon = container.firstElementChild;
  if (!(icon instanceof HTMLElement)) {
    throw new Error("StatusIcon rendered nothing");
  }
  return icon;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function pulseDurations(icon: HTMLElement): number[] {
  return icon
    .getAnimations({ subtree: true })
    .map((animation) => animation.effect?.getTiming().duration)
    .filter((duration): duration is number => duration === STATUS_PULSE_PERIOD_MS);
}

describe("StatusIcon", () => {
  it("breathes a running agent's ring: the pulse and the colour cycle", () => {
    expect(pulseDurations(mountIcon("running"))).toEqual([
      STATUS_PULSE_PERIOD_MS,
      STATUS_PULSE_PERIOD_MS,
    ]);
  });

  it.each(["failed", "attention", "needs_input", "done"] as const)(
    "keeps a %s agent's mark still",
    (bucket) => {
      expect(mountIcon(bucket).getAnimations({ subtree: true })).toHaveLength(0);
    },
  );
});
