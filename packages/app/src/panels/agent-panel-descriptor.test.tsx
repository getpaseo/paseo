import { describe, expect, it } from "vitest";
import { buildAgentDescriptor, resolveAgentLabel } from "@/agent-presentation";
import { i18n } from "@/i18n/i18next";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";

function TestIcon() {
  return null;
}

describe("buildDraftPanelDescriptor", () => {
  it("uses the initial prompt title and running loader bucket during create", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "Build the dashboard",
      icon: TestIcon,
    });

    expect(descriptor).toMatchObject({
      label: "Build the dashboard",
      subtitle: "Creating agent",
      titleState: "ready",
      statusBucket: "running",
    });
  });

  it("falls back to the draft title for empty create prompts", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(descriptor.label).toBe("New Agent");
  });

  it("keeps ordinary draft tabs labeled as new agents", () => {
    const descriptor = buildDraftPanelDescriptor({ isCreating: false, icon: TestIcon });

    expect(descriptor).toMatchObject({
      label: "New Agent",
      subtitle: "New Agent",
      titleState: "ready",
      statusBucket: null,
    });
  });

  it("uses the active language for draft descriptor chrome", async () => {
    await i18n.changeLanguage("zh-CN");
    const idleDescriptor = buildDraftPanelDescriptor({
      isCreating: false,
      icon: TestIcon,
    });
    const creatingDescriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(idleDescriptor).toMatchObject({
      label: "新建 Agent",
      subtitle: "新建 Agent",
    });
    expect(creatingDescriptor).toMatchObject({
      label: "新建 Agent",
      subtitle: "正在创建 Agent",
    });
    await i18n.changeLanguage("en");
  });
});

describe("shared agent descriptor", () => {
  function describeAgent(overrides: Partial<Parameters<typeof buildAgentDescriptor>[0]> = {}) {
    return buildAgentDescriptor({
      provider: "codex",
      title: "  Review checkout retries  ",
      status: "idle",
      pendingPermissionCount: 0,
      requiresAttention: false,
      attentionReason: null,
      isTurnActive: false,
      icon: TestIcon,
      ...overrides,
    });
  }

  it("keeps the normalized title and provider identity together", () => {
    expect(describeAgent()).toMatchObject({
      label: "Review checkout retries",
      subtitle: "Codex agent",
      icon: TestIcon,
      titleState: "ready",
      statusBucket: "done",
    });
  });

  it.each([null, "", "   ", "New Agent", " new agent "])(
    "leaves an untitled agent loading: %s",
    (title) => {
      expect(resolveAgentLabel(title)).toBeNull();
      expect(describeAgent({ title })).toMatchObject({ label: "", titleState: "loading" });
    },
  );

  it("shows an active turn as running before the lifecycle update arrives", () => {
    expect(describeAgent({ isTurnActive: true }).statusBucket).toBe("running");
  });

  it("surfaces pending permissions even while the turn is running", () => {
    expect(describeAgent({ isTurnActive: true, pendingPermissionCount: 1 }).statusBucket).toBe(
      "needs_input",
    );
  });

  it.each([
    ["finished", "attention"],
    ["error", "failed"],
    ["permission", "needs_input"],
  ] as const)("preserves %s attention", (attentionReason, statusBucket) => {
    expect(describeAgent({ requiresAttention: true, attentionReason }).statusBucket).toBe(
      statusBucket,
    );
  });
});
