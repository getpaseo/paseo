import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchWorkspaceWorkflowAction } from "./launch";

const calls = vi.hoisted(() => ({ pending: vi.fn(), submitting: vi.fn(), navigate: vi.fn() }));
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
  serverId: "host",
  workspaceId: "workspace",
  cwd: "/repo",
  baseRef: "origin/paseo-local",
  branch: "feature",
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
  beforeEach(() => vi.clearAllMocks());

  it("uses the manual review choice without a profile or JEV routing", () => {
    launchWorkspaceWorkflowAction({
      ...context,
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
    expect(calls.submitting.mock.calls[0][0].text).toContain("origin/paseo-local");
    expect(calls.submitting.mock.calls[0][0].text).not.toContain("origin/main");
  });

  it.each(["create-pr", "commit-and-push"] as const)(
    "uses PR choice for %s without inheriting profile mode",
    (action) => {
      launchWorkspaceWorkflowAction({
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

  it("preserves the existing profile when no manual choice is configured", () => {
    launchWorkspaceWorkflowAction({
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

  it("launches local check repair with the PR model and a local-only prompt", () => {
    launchWorkspaceWorkflowAction({
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
    expect(prompt).toContain("origin/paseo-local");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("aucun commit, push, merge");
    expect(prompt).not.toContain("COMMIT_PUSH_SENTINEL");
  });

  it("refuses to launch check repair without a pull request or branch", () => {
    expect(() =>
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        prUrl: null,
        config: { prModel: { provider: "codex", model: "pr" } },
      }),
    ).toThrow();
    expect(() =>
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        branch: null,
        prUrl: "https://example.com/pr/8",
        config: { prModel: { provider: "codex", model: "pr" } },
      }),
    ).toThrow();
  });

  it.each(["origin/main", "origin/develop", "origin/paseo-local"])(
    "launches conflict resolution using the verified PR target regardless of workspace base %s",
    (baseRef) => {
      launchWorkspaceWorkflowAction({
        ...context,
        baseRef,
        action: "resolve-conflicts",
        prUrl: "https://example.com/pr/8",
        config: {
          prModel: { provider: "codex", model: "pr" },
          commitAndPushPrompt: "COMMIT_PUSH_SENTINEL",
        },
      });

      const request = calls.submitting.mock.calls[0][0];
      expect(request).toMatchObject({ provider: "codex", model: "pr", cwd: "/repo" });
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
});
