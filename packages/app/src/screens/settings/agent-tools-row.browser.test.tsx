import React, { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { SettingsCard } from "@/components/settings";
import { i18n } from "@/i18n/i18next";
import {
  DEFAULT_AGENT_TOOL_GROUPS,
  type AgentToolGroupId,
  type AgentToolGroupsState,
} from "./agent-tools-config";
import { AgentToolsRow } from "./agent-tools-row";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function Harness({
  initialEnabled = true,
  initialGroups = DEFAULT_AGENT_TOOL_GROUPS,
  supportsGroupControls = true,
}: {
  initialEnabled?: boolean;
  initialGroups?: AgentToolGroupsState;
  supportsGroupControls?: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [groups, setGroups] = useState<AgentToolGroupsState>(initialGroups);

  const handleGroupChange = useCallback((group: AgentToolGroupId, next: boolean) => {
    setGroups((current) => ({ ...current, [group]: next }));
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <SettingsCard>
        <AgentToolsRow
          enabled={enabled}
          groups={groups}
          supportsGroupControls={supportsGroupControls}
          onEnabledChange={setEnabled}
          onGroupChange={handleGroupChange}
        />
      </SettingsCard>
    </I18nextProvider>
  );
}

function mount(props?: React.ComponentProps<typeof Harness>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness {...props} />);
  });
}

function byTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function expandButton(): HTMLElement {
  const row = byTestId("host-page-tools-row-toggle");
  const button = row?.querySelector('[role="button"]');
  if (!(button instanceof HTMLElement)) {
    throw new Error("Expected expand button in host-page-tools-row-toggle");
  }
  return button;
}

describe("AgentToolsRow collapsible behavior", () => {
  it("starts collapsed, expands to show all four groups, and preserves selections when toggled off and on", () => {
    mount({
      initialEnabled: true,
      initialGroups: {
        orchestration: true,
        schedules: false,
        changeRequests: true,
        browser: true,
      },
    });

    const masterSwitch = byTestId("host-page-tools-master-switch");
    expect(masterSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("host-page-tool-group-orchestration")).toBeNull();

    // Expand the row
    act(() => {
      expandButton().click();
    });

    expect(byTestId("host-page-tool-group-orchestration")).not.toBeNull();
    expect(byTestId("host-page-tool-group-schedules")).not.toBeNull();
    expect(byTestId("host-page-tool-group-changeRequests")).not.toBeNull();
    expect(byTestId("host-page-browser-tools-card")).not.toBeNull();
    expect(document.body.textContent).toContain("Tools added by plugins also follow Enable tools");
    expect(document.body.textContent).not.toContain("MCP");

    const browserSwitch = byTestId("host-page-browser-tools-switch")!;
    const schedulesSwitch = byTestId("host-page-tool-group-schedules-switch")!;
    expect(browserSwitch.getAttribute("aria-checked")).toBe("true");
    expect(schedulesSwitch.getAttribute("aria-checked")).toBe("false");
    expect(browserSwitch.getAttribute("aria-disabled")).not.toBe("true");

    // Turn master switch off: stays expanded, disables group switches, preserves selections
    act(() => {
      masterSwitch?.click();
    });

    expect(masterSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(browserSwitch.getAttribute("aria-disabled")).toBe("true");
    expect(browserSwitch.getAttribute("aria-checked")).toBe("true");
    expect(schedulesSwitch.getAttribute("aria-disabled")).toBe("true");
    expect(schedulesSwitch.getAttribute("aria-checked")).toBe("false");

    // Turn master switch back on: group switches become interactive again with saved state
    act(() => {
      masterSwitch?.click();
    });

    expect(masterSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(browserSwitch.getAttribute("aria-disabled")).not.toBe("true");
    expect(browserSwitch.getAttribute("aria-checked")).toBe("true");
  });

  it("shows only Browser and an update hint on older daemons without daemonToolsConfig", () => {
    mount({ supportsGroupControls: false });

    act(() => {
      expandButton().click();
    });

    expect(byTestId("host-page-browser-tools-card")).not.toBeNull();
    expect(byTestId("host-page-tool-group-orchestration")).toBeNull();
    expect(byTestId("host-page-tool-group-schedules")).toBeNull();
    expect(byTestId("host-page-tool-group-changeRequests")).toBeNull();
    expect(document.body.textContent).toContain(
      "Update this host to configure individual tool groups",
    );
  });
});
