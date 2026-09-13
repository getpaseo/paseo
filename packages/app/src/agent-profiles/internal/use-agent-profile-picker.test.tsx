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
    ],
  }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));
vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ updatePreferences: async () => {} }),
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => null }));
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
    await requestWorkspaceDraftAgent({ createAgent } as unknown as DaemonClient, {
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
