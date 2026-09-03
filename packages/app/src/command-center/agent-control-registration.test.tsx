/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandCenterProvider,
  useCommandCenterContributions,
  useCommandCenterShortcutRunner,
} from "./provider";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "./agent-control-registration";
import type { CommandCenterContributionSnapshot } from "./contributions";
import { buildCommandShortcutSettingsRows } from "./shortcut-settings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

// The real package drags untransformed react-native flow sources into vitest.
// Mock the one hook the registration uses; RouteFocusContext stands in for the
// navigator's per-screen focus state.
vi.mock("@react-navigation/native", async () => {
  const { createContext, useContext } = await import("react");
  const RouteFocusContext = createContext(true);
  return {
    RouteFocusContext,
    useIsFocused: () => useContext(RouteFocusContext),
  };
});

async function getRouteFocusContext(): Promise<React.Context<boolean>> {
  const module = (await import("@react-navigation/native")) as unknown as {
    RouteFocusContext: React.Context<boolean>;
  };
  return module.RouteFocusContext;
}

const SHORTCUT_ID = "models:codex:gpt-5.6-sol";

function buildControls(
  select: (provider: string, modelId: string) => void,
): AgentControlCommandCenterSource {
  return {
    serverId: "srv",
    ownerKey: "owner",
    provider: "codex",
    providerDefinitions: [],
    models: {
      providers: [
        {
          id: "codex",
          label: "Codex",
          modelSelection: {
            kind: "models",
            rows: [
              {
                favoriteKey: "codex:gpt-5.6-sol",
                provider: "codex",
                providerLabel: "Codex",
                modelId: "gpt-5.6-sol",
                modelLabel: "GPT-5.6 Sol",
              },
            ],
          },
        },
      ],
      selectedProvider: "codex",
      selectedModelId: null,
      select,
    },
    thinking: { options: [], selectedId: null, select: () => undefined },
    features: { list: [] },
  };
}

function Registrar({
  sourceId,
  controls,
}: {
  sourceId: string;
  controls: AgentControlCommandCenterSource;
}) {
  useAgentControlCommandCenterActions({ sourceId, enabled: true, controls });
  return null;
}

let probe: {
  snapshot: CommandCenterContributionSnapshot;
  run: (shortcutId: string) => boolean;
} | null = null;

function Probe() {
  probe = {
    snapshot: useCommandCenterContributions(),
    run: useCommandCenterShortcutRunner(),
  };
  return null;
}

function Harness({
  routeFocusContext,
  threadFocused,
  draftFocused,
  threadControls,
  draftControls,
}: {
  routeFocusContext: React.Context<boolean>;
  threadFocused: boolean;
  draftFocused: boolean;
  threadControls: AgentControlCommandCenterSource;
  draftControls: AgentControlCommandCenterSource;
}) {
  const RouteFocusContext = routeFocusContext;
  return (
    <CommandCenterProvider>
      <RouteFocusContext.Provider value={threadFocused}>
        <Registrar sourceId="agent:srv:agent-1" controls={threadControls} />
      </RouteFocusContext.Provider>
      <RouteFocusContext.Provider value={draftFocused}>
        <Registrar sourceId="new-workspace:draft-1" controls={draftControls} />
      </RouteFocusContext.Provider>
      <Probe />
    </CommandCenterProvider>
  );
}

function liveMatches(snapshot: CommandCenterContributionSnapshot) {
  return snapshot.contributions.filter((contribution) => contribution.shortcutId === SHORTCUT_ID);
}

describe("agent control command center registration", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    probe = null;
  });

  function render(element: React.ReactElement) {
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => root?.render(element));
  }

  it("keeps exactly one live registrar as focus moves between surfaces", async () => {
    const routeFocusContext = await getRouteFocusContext();
    const threadSelect = vi.fn();
    const draftSelect = vi.fn();
    const threadControls = buildControls(threadSelect);
    const draftControls = buildControls(draftSelect);

    render(
      <Harness
        routeFocusContext={routeFocusContext}
        threadFocused={true}
        draftFocused={false}
        threadControls={threadControls}
        draftControls={draftControls}
      />,
    );

    expect(liveMatches(probe!.snapshot)).toHaveLength(1);
    expect(probe!.run(SHORTCUT_ID)).toBe(true);
    expect(threadSelect).toHaveBeenCalledWith("codex", "gpt-5.6-sol");
    expect(draftSelect).not.toHaveBeenCalled();

    render(
      <Harness
        routeFocusContext={routeFocusContext}
        threadFocused={false}
        draftFocused={true}
        threadControls={threadControls}
        draftControls={draftControls}
      />,
    );

    expect(liveMatches(probe!.snapshot)).toHaveLength(1);
    expect(probe!.run(SHORTCUT_ID)).toBe(true);
    expect(draftSelect).toHaveBeenCalledWith("codex", "gpt-5.6-sol");
    expect(threadSelect).toHaveBeenCalledTimes(1);

    // Settings-row availability is catalog-based; the focus handoff must leave
    // exactly one catalog entry so the row stays bindable.
    const rows = buildCommandShortcutSettingsRows(probe!.snapshot.shortcutCatalog, {});
    expect(rows).toEqual([expect.objectContaining({ shortcutId: SHORTCUT_ID, available: true })]);
  });

  it("refuses ambiguous dispatch while both surfaces report focus", async () => {
    const routeFocusContext = await getRouteFocusContext();
    const threadSelect = vi.fn();
    const draftSelect = vi.fn();

    render(
      <Harness
        routeFocusContext={routeFocusContext}
        threadFocused={true}
        draftFocused={true}
        threadControls={buildControls(threadSelect)}
        draftControls={buildControls(draftSelect)}
      />,
    );

    expect(liveMatches(probe!.snapshot)).toHaveLength(2);
    expect(probe!.run(SHORTCUT_ID)).toBe(false);
    expect(threadSelect).not.toHaveBeenCalled();
    expect(draftSelect).not.toHaveBeenCalled();
  });
});
