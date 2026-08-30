import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostBadge } from "./host-badge";
import { useSessionStore } from "@/stores/session-store";
import type { HostBadgeModel } from "./appearance";

const SERVER_ID = "server-1";

const badge: HostBadgeModel = {
  serverId: SERVER_ID,
  label: "fedora",
  color: "none",
  showLabel: true,
};

/**
 * The badge reads the charge from the session store rather than from props, so these tests
 * seed the store the same way a `host_battery` push would.
 */
function seedBattery(hostBattery: { percent: number } | null | undefined): void {
  useSessionStore.setState((prev) => ({
    ...prev,
    sessions: {
      ...prev.sessions,
      [SERVER_ID]: {
        ...(prev.sessions[SERVER_ID] ?? ({} as never)),
        serverId: SERVER_ID,
        hostBattery,
      },
    },
  }));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(model: HostBadgeModel = badge): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<HostBadge badge={model} />));
  return container.textContent ?? "";
}

beforeEach(() => {
  useSessionStore.setState((prev) => ({ ...prev, sessions: {} }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("HostBadge battery", () => {
  it("follows the hostname with the charge", () => {
    seedBattery({ percent: 37 });
    expect(mount()).toMatch(/fedora\s*-\s*37\s*%/);
  });

  it("rounds the charge to whole percent", () => {
    seedBattery({ percent: 36.6 });
    expect(mount()).toMatch(/37\s*%/);
  });

  it("shows nothing extra for a host with no battery", () => {
    seedBattery(null);
    expect(mount().trim()).toBe("fedora");
  });

  it("shows nothing extra before the host has reported a reading", () => {
    seedBattery(undefined);
    expect(mount().trim()).toBe("fedora");
  });

  it("drops the separator when the host shows no name", () => {
    seedBattery({ percent: 37 });
    const rendered = mount({ ...badge, showLabel: false });
    expect(rendered).not.toContain("fedora");
    expect(rendered).not.toContain("-");
    expect(rendered).toMatch(/37\s*%/);
  });

  it("names the charge in the accessibility label", () => {
    seedBattery({ percent: 37 });
    mount();
    const labelled = container?.querySelector("[aria-label]");
    expect(labelled?.getAttribute("aria-label")).toMatch(/fedora.*37/);
  });
});
