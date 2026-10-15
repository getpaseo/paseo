/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useAgentProfilePicker } from "./use-agent-profile-picker";
import {
  INITIAL_USER_MODIFIED,
  resolveAgentForm,
  type AgentFormReducerState,
} from "@/provider-selection/resolve-agent-form";
import { requestWorkspaceDraftAgent } from "@/composer/draft/create-agent-request";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const { applyAgentConfig } = vi.hoisted(() => ({
  applyAgentConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("./use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    isSupported: true,
    profiles: [
      {
        id: "ordinary-profile",
        name: "Ordinary",
        provider: "codex",
        modeId: "plan",
        postApprovalModeId: "auto",
      },
      {
        id: "second-profile",
        name: "Second",
        provider: "codex",
      },
    ],
  }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));
vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ updatePreferences: async () => {} }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: Record<string, unknown> }) => unknown) =>
    selector({ sessions: { host: { client: { applyAgentConfig } } } }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error() {} }) }));

test.each([undefined, "paseo-workflow-router"])(
  "picker replaces draft launch provenance (%s) before create",
  async (initial) => {
    let state: AgentFormReducerState = {
      form: {
        provider: "codex",
        model: "",
        modeId: "",
        thinkingOptionId: "",
        launchProfileId: initial,
      },
      userModified: INITIAL_USER_MODIFIED,
      resolution: { status: "completed" },
    };
    const { result } = renderHook(() =>
      useAgentProfilePicker({
        serverId: "host",
        availableProviders: ["codex"],
        target: {
          kind: "draft",
          controls: {
            applyProfile: (profile) => {
              state = resolveAgentForm(state, {
                type: "APPLY_PROFILE_FROM_USER",
                ...profile,
                providerDef: undefined,
                providerModels: null,
              });
            },
          },
        },
      }),
    );
    act(() => result.current!.applyProfile("ordinary-profile"));
    const createAgent = vi.fn().mockResolvedValue({ id: "created" });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await requestWorkspaceDraftAgent({ createAgent, sendMessage } as unknown as DaemonClient, {
      workspaceId: "workspace",
      launchProfileId: state.form.launchProfileId,
      config: { provider: state.form.provider!, cwd: "/workspace" },
      text: "Implement",
      clientMessageId: "message",
    });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ launchProfileId: "ordinary-profile" }),
    );
    expect(createAgent.mock.calls[0]![0]).not.toHaveProperty("launchPostApprovalModeId");
  },
);

test("Tab applies the next compatible profile and wraps after the last one", () => {
  const applyProfile = vi.fn();
  const { result } = renderHook(() =>
    useAgentProfilePicker({
      serverId: "host",
      availableProviders: ["codex"],
      target: { kind: "draft", controls: { applyProfile } },
    }),
  );

  act(() => {
    expect(result.current?.applyNextProfile()).toBe(true);
    expect(result.current?.applyNextProfile()).toBe(true);
    expect(result.current?.applyNextProfile()).toBe(true);
  });
  expect(applyProfile.mock.calls.map(([profile]) => profile.launchProfileId)).toEqual([
    "ordinary-profile",
    "second-profile",
    "ordinary-profile",
  ]);

  act(() => result.current?.applyProfile("second-profile"));
  act(() => expect(result.current?.applyNextProfile()).toBe(true));
  expect(applyProfile.mock.lastCall?.[0].launchProfileId).toBe("ordinary-profile");
});

test("Tab leaves focus navigation available when no profile applies", () => {
  const applyProfile = vi.fn();
  const { result } = renderHook(() =>
    useAgentProfilePicker({
      serverId: "host",
      availableProviders: ["claude"],
      target: { kind: "draft", controls: { applyProfile } },
    }),
  );

  expect(result.current?.applyNextProfile()).toBe(false);
  expect(applyProfile).not.toHaveBeenCalled();
});

test("Tab applies a profile to the running agent only when its modes are ready", () => {
  applyAgentConfig.mockClear();
  const { result, rerender } = renderHook(
    ({ availableModeIds }: { availableModeIds: string[] | null }) =>
      useAgentProfilePicker({
        serverId: "host",
        availableProviders: ["codex"],
        target: { kind: "agent", agentId: "agent", availableModeIds },
      }),
    { initialProps: { availableModeIds: null as string[] | null } },
  );

  expect(result.current?.applyNextProfile()).toBe(false);
  expect(applyAgentConfig).not.toHaveBeenCalled();

  rerender({ availableModeIds: ["plan"] });
  act(() => expect(result.current?.applyNextProfile()).toBe(true));
  expect(applyAgentConfig).toHaveBeenCalledWith("agent", { modeId: "plan" });
});
