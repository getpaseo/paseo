import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchWorkspaceWorkflowAction } from "./launch";

const calls = vi.hoisted(() => ({
  pending: vi.fn(),
  submitting: vi.fn(),
  navigate: vi.fn(),
  features: vi.fn(),
}));
vi.mock("@/stores/create-flow-store", () => ({
  useCreateFlowStore: { getState: () => ({ setPending: calls.pending }) },
}));
vi.mock("@/stores/workspace-draft-submission-store", () => ({
  useWorkspaceDraftSubmissionStore: { getState: () => ({ setPending: calls.submitting }) },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: calls.navigate,
}));
vi.mock("@/stores/draft-keys", () => ({ generateDraftId: () => "draft" }));
vi.mock("@/agent-profiles", async () => import("@/agent-profiles/internal/materialize-profile"));

const context = {
  client: { listProviderFeatures: calls.features },
  serverId: "host",
  workspaceId: "workspace",
  cwd: "/repo",
  baseRef: "origin/main",
  branch: "feature",
  providerEntries: [
    {
      provider: "codex",
      enabled: true,
      status: "ready" as const,
      label: "Codex",
      description: "",
      defaultModeId: null,
      modes: [],
      models: [
        {
          provider: "codex",
          id: "pr",
          label: "PR",
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ],
    },
  ],
};
const profile = {
  id: "legacy",
  name: "Legacy",
  provider: "claude",
  model: "legacy-model",
  modeId: "plan",
  thinkingOptionId: "high",
  featureValues: { plan_mode: true },
};

describe("workspace workflow launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.features.mockResolvedValue({ provider: "codex", features: [], fetchedAt: "now" });
  });

  it("uses the manual review choice without a profile or JEV routing", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      client: null,
      action: "review",
      config: { reviewModel: { provider: "codex", model: "review", thinkingOptionId: "low" } },
    });
    expect(calls.submitting.mock.calls[0][0]).toMatchObject({
      provider: "codex",
      model: "review",
      thinkingOptionId: "low",
      featureValues: {},
    });
    expect(calls.submitting.mock.calls[0][0]).not.toHaveProperty("launchProfileId");
    expect(calls.submitting.mock.calls[0][0]).not.toHaveProperty("modelRouting");
    expect(calls.navigate.mock.calls[0][0].target.setup).toMatchObject({
      provider: "codex",
      model: "review",
      thinkingOptionId: "low",
    });
    expect(calls.submitting.mock.calls[0][0].text).toContain("origin/main");
  });

  it.each(["create-pr", "commit-and-push"] as const)(
    "uses PR choice for %s without inheriting profile mode",
    async (action) => {
      await launchWorkspaceWorkflowAction({
        ...context,
        action,
        profile,
        config: {
          prModel: { provider: "codex", model: "pr" },
          reviewModel: { provider: "claude", model: "review" },
        },
      });
      const request = calls.submitting.mock.calls[0][0];
      expect(request).toMatchObject({ provider: "codex", model: "pr", featureValues: {} });
      expect(request).not.toHaveProperty("modeId");
      expect(request).not.toHaveProperty("thinkingOptionId");
      expect(request).not.toHaveProperty("launchProfileId");
    },
  );

  it("uses the workspace main base without asking for extra confirmation", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      baseRef: "origin/main",
      action: "create-pr",
      config: { prModel: { provider: "codex", model: "pr" } },
    });

    const prompt = calls.submitting.mock.calls[0][0].text as string;
    expect(prompt).toContain("The target branch is origin/main.");
    expect(prompt).toContain(
      "Create the pull request against `main`, the workspace's configured base branch.",
    );
    expect(prompt).toContain(
      "Do not ask for extra confirmation solely because the target is `main`.",
    );
  });

  it("preserves the existing profile when no manual choice is configured", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      action: "review",
      profile,
      config: { reviewModel: null },
    });
    expect(calls.submitting.mock.calls[0][0]).toMatchObject({
      provider: "claude",
      model: "legacy-model",
      modeId: "plan",
      thinkingOptionId: "high",
      launchProfileId: "legacy",
      featureValues: { plan_mode: true },
    });
  });

  it("launches local check repair with the PR model and a local-only prompt", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      action: "repair-checks",
      prUrl: "https://example.com/pr/8",
      config: {
        prModel: { provider: "codex", model: "pr" },
        reviewModel: { provider: "claude", model: "review" },
        commitAndPushPrompt: "COMMIT_PUSH_SENTINEL",
      },
    });
    const request = calls.submitting.mock.calls[0][0];
    expect(request).toMatchObject({ provider: "codex", model: "pr", featureValues: {} });
    expect(request).not.toHaveProperty("modeId");
    expect(request).not.toHaveProperty("thinkingOptionId");
    expect(request).not.toHaveProperty("launchProfileId");
    const prompt = request.text as string;
    expect(prompt).toContain("https://example.com/pr/8");
    expect(prompt).toContain("feature");
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("aucun commit, push, merge");
    expect(prompt).not.toContain("COMMIT_PUSH_SENTINEL");
  });

  it("refuses to launch check repair without a pull request or branch", async () => {
    await expect(
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        prUrl: null,
        config: {
          prModel: { provider: "codex", model: "pr" },
          conflictModel: { provider: "codex", model: "pr" },
        },
      }),
    ).rejects.toThrow();
    await expect(
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        branch: null,
        prUrl: "https://example.com/pr/8",
        config: {
          prModel: { provider: "codex", model: "pr" },
          conflictModel: { provider: "codex", model: "pr" },
        },
      }),
    ).rejects.toThrow();
  });

  it.each(["origin/main", "origin/develop", "origin/paseo-local"])(
    "launches conflict resolution using the verified PR target regardless of workspace base %s",
    async (baseRef) => {
      await launchWorkspaceWorkflowAction({
        ...context,
        baseRef,
        action: "resolve-conflicts",
        prUrl: "https://example.com/pr/8",
        config: {
          conflictModel: { provider: "codex", model: "pr", thinkingOptionId: "high" },
          commitAndPushPrompt: "COMMIT_PUSH_SENTINEL",
        },
      });

      const request = calls.submitting.mock.calls[0][0];
      expect(request).toMatchObject({
        provider: "codex",
        model: "pr",
        thinkingOptionId: "high",
        modelRouting: "manual",
        cwd: "/repo",
      });
      const prompt = request.text as string;
      expect(prompt).toContain("https://example.com/pr/8");
      expect(prompt).toContain("Branche courante : feature");
      expect(prompt).toContain(`Current branch base: ${baseRef}`);
      expect(prompt).toContain("toujours ouverte");
      expect(prompt).toContain("dépôt du workspace");
      expect(prompt).toContain("branche source correspond à la branche courante");
      expect(prompt).toContain("Récupère sa branche cible actuelle depuis la PR");
      expect(prompt).toContain("Cette cible prévaut sur la base locale du workspace");
      expect(prompt).toContain(
        "Si la PR ou sa branche cible ne peut pas être vérifiée, arrête-toi et explique le blocage",
      );
      expect(prompt).toContain("Préserve tout travail préexistant");
      expect(prompt).toContain(
        "Lance les vérifications pertinentes. Si elles passent, crée un commit de résolution et pousse",
      );
      expect(prompt).toContain("fusionne-la localement");
      expect(prompt).toContain("push de cette branche");
      expect(prompt).toContain("Ne fais aucun force-push, rebase");
      expect(prompt).toContain("ni fusion distante de la PR");
      expect(prompt).toContain("Vérifie que le remote et la branche poussés sont ceux de la PR");
      expect(prompt).not.toContain("vérifie qu'elle est bien paseo-local");
      expect(prompt).not.toContain("diffère de paseo-local");
      expect(prompt).not.toContain("Si la branche cible réelle est main");
      expect(prompt).not.toContain("confirmation explicite");
      expect(prompt).not.toContain("COMMIT_PUSH_SENTINEL");
      expect(calls.navigate.mock.calls[0][0]).toMatchObject({
        target: { kind: "draft" },
        pin: true,
      });
    },
  );

  it.each(["create-pr", "commit-and-push", "repair-checks", "resolve-conflicts"] as const)(
    "enables the advertised Codex Fast tier for %s",
    async (action) => {
      calls.features.mockResolvedValue({
        provider: "codex",
        fetchedAt: "now",
        features: [
          {
            type: "select",
            id: "service_tier",
            label: "Speed",
            value: "default",
            options: [
              { id: "default", label: "Normal" },
              { id: "priority-v2", label: "Fast" },
            ],
          },
        ],
      });

      await launchWorkspaceWorkflowAction({
        ...context,
        action,
        prUrl: "https://example.com/pr/8",
        config: {
          prModel: { provider: "codex", model: "pr" },
          conflictModel: { provider: "codex", model: "pr" },
        },
      });

      expect(calls.submitting.mock.calls[0][0].featureValues).toEqual({
        service_tier: "priority-v2",
      });
      expect(calls.navigate.mock.calls[0][0].target.setup.featureValues).toEqual({
        service_tier: "priority-v2",
      });
    },
  );

  it("enables a fast_mode toggle while preserving legacy profile options", async () => {
    calls.features.mockResolvedValue({
      provider: "claude",
      fetchedAt: "now",
      features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }],
    });

    await launchWorkspaceWorkflowAction({
      ...context,
      action: "create-pr",
      profile,
      config: {},
    });

    expect(calls.features).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/repo",
      modeId: "plan",
      model: "legacy-model",
      thinkingOptionId: "high",
      featureValues: { plan_mode: true },
    });
    expect(calls.submitting.mock.calls[0][0]).toMatchObject({
      modeId: "plan",
      thinkingOptionId: "high",
      launchProfileId: "legacy",
      featureValues: { plan_mode: true, fast_mode: true },
    });
  });

  it("replaces an explicit normal speed and preserves unrelated direct-model options", async () => {
    calls.features.mockResolvedValue({
      provider: "codex",
      fetchedAt: "now",
      features: [
        {
          type: "select",
          id: "service_tier",
          label: "Speed",
          value: "default",
          options: [
            { id: "default", label: "Normal" },
            { id: "provider-fast-id", label: "Fast" },
          ],
        },
      ],
    });
    const directProfile = {
      ...profile,
      provider: "codex",
      featureValues: { service_tier: "default", plan_mode: true },
    };

    await launchWorkspaceWorkflowAction({
      ...context,
      action: "commit-and-push",
      profile: directProfile,
      config: {},
    });

    expect(calls.submitting.mock.calls[0][0].featureValues).toEqual({
      service_tier: "provider-fast-id",
      plan_mode: true,
    });
  });

  it("keeps existing options when the selected model has no fast feature", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      action: "create-pr",
      profile,
      config: {},
    });

    expect(calls.submitting.mock.calls[0][0].featureValues).toEqual({ plan_mode: true });
  });

  it("leaves review options unchanged and skips feature discovery", async () => {
    await launchWorkspaceWorkflowAction({
      ...context,
      action: "review",
      profile,
      config: {},
    });

    expect(calls.features).not.toHaveBeenCalled();
    expect(calls.submitting.mock.calls[0][0].featureValues).toEqual({ plan_mode: true });
  });

  it("does not launch when feature discovery fails", async () => {
    calls.features.mockResolvedValue({
      provider: "codex",
      fetchedAt: "now",
      error: "Feature discovery failed",
    });

    await expect(
      launchWorkspaceWorkflowAction({
        ...context,
        action: "create-pr",
        config: {
          prModel: { provider: "codex", model: "pr" },
          conflictModel: { provider: "codex", model: "pr" },
        },
      }),
    ).rejects.toThrow("Feature discovery failed");
    expect(calls.pending).not.toHaveBeenCalled();
    expect(calls.submitting).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled();
  });

  it("blocks a duplicate launch while feature discovery is pending", async () => {
    let resolveFeatures!: (value: { provider: string; features: []; fetchedAt: string }) => void;
    calls.features.mockReturnValue(
      new Promise((resolve) => {
        resolveFeatures = resolve;
      }),
    );
    const input = {
      ...context,
      action: "create-pr" as const,
      config: { prModel: { provider: "codex", model: "pr" } },
    };

    const first = launchWorkspaceWorkflowAction(input);
    await expect(launchWorkspaceWorkflowAction(input)).rejects.toThrow("already opening");
    resolveFeatures({ provider: "codex", features: [], fetchedAt: "now" });
    await first;

    expect(calls.features).toHaveBeenCalledTimes(1);
    expect(calls.navigate).toHaveBeenCalledTimes(1);
  });
});

it("never launches conflicts via a PR model or legacy profile", async () => {
  calls.submitting.mockClear();
  await expect(
    launchWorkspaceWorkflowAction({
      ...context,
      action: "resolve-conflicts",
      profile,
      config: { prModel: { provider: "codex", model: "pr" } },
    }),
  ).rejects.toThrow("Select a model");
  expect(calls.submitting).not.toHaveBeenCalled();
});
it.each([
  { provider: "missing", model: "pr" },
  { provider: "codex", model: "removed" },
  { provider: "codex", model: "pr", thinkingOptionId: "removed" },
])("refuses an unavailable conflict choice %s", async (conflictModel) => {
  calls.submitting.mockClear();
  await expect(
    launchWorkspaceWorkflowAction({
      ...context,
      action: "resolve-conflicts",
      config: { conflictModel },
    }),
  ).rejects.toThrow();
  expect(calls.submitting).not.toHaveBeenCalled();
});
