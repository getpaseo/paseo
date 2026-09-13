import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../../packages/server/src/server/daemon-config-store";
import { installProfiles } from "./install";

test("install preserves an edit committed while its config read is in flight", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "workflow-install-"));
  try {
    const original = {
      id: "paseo-workflow-router",
      name: "Custom router",
      provider: "codex",
      model: "old",
      foreign: { keep: true },
    };
    const edited = { ...original, model: "user-edited-model" };
    const foreign = {
      id: "my-own-profile",
      name: "Mine",
      provider: "claude",
      extra: { keep: true },
    };
    const store = new DaemonConfigStore(
      home,
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
        agentProfiles: [foreign, original],
      }),
    );
    const config = {
      get: async () => {
        const snapshot = store.get();
        store.patch({ agentProfiles: [foreign, edited] });
        return { requestId: "read", config: snapshot };
      },
      patch: async (patch: Parameters<DaemonConfigStore["patch"]>[0]) => ({
        requestId: "patch",
        config: store.patch(patch),
      }),
    };
    // A second client may save after any earlier read by the installer.
    await config.get();
    await installProfiles(config);
    expect(store.get().agentProfiles?.find((profile) => profile.id === original.id)).toEqual(
      edited,
    );
    expect(store.get().agentProfiles?.slice(0, 2)).toEqual([foreign, edited]);
    expect(store.get().agentProfiles?.map((profile) => profile.id)).toEqual([
      "my-own-profile",
      "paseo-workflow-router",
      "paseo-workflow-planner",
      "paseo-workflow-plan-reviewer",
      "paseo-workflow-executor-standard",
      "paseo-workflow-executor-advanced",
      "paseo-workflow-final-review",
      "paseo-workflow-audit-economic",
      "paseo-workflow-audit-deep",
      "paseo-workflow-audit-security",
    ]);
    await installProfiles(config);
    expect(store.get().agentProfiles).toHaveLength(10);
    store.patch({
      agentProfiles: store
        .get()
        .agentProfiles?.filter((profile) => profile.id !== "paseo-workflow-planner"),
    });
    await installProfiles(config);
    expect(store.get().agentProfiles).toHaveLength(10);
    expect(store.get().agentProfiles?.slice(0, 2)).toEqual([foreign, edited]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
