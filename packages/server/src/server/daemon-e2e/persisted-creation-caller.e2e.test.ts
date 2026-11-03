import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

test.each(["agent", "workspace"] as const)(
  "%s creation recognizes an unopened persisted caller after restart",
  async (kind) => {
    const artifacts = path.resolve(".artifacts");
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, "persisted-caller-"));
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    let ctx: DaemonTestContext | undefined;
    try {
      ctx = await createDaemonTestContext({
        paseoHomeRoot: root,
        staticDir: cwd,
        cleanup: false,
        mcpEnabled: false,
      });
      const parent = await ctx.client.createAgent({ provider: "claude", cwd, background: true });
      await ctx.client.sendMessage(parent.id, "Reply DONE.");
      expect((await ctx.client.waitForFinish(parent.id, 5_000)).status).toBe("idle");
      await ctx.cleanup();
      ctx = undefined;
      ctx = await createDaemonTestContext({
        paseoHomeRoot: root,
        staticDir: cwd,
        cleanup: false,
        mcpEnabled: false,
      });
      expect(ctx.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();
      expect(
        (await ctx.client.fetchAgents({ filter: { includeBackground: true } })).entries,
      ).toContainEqual(
        expect.objectContaining({ agent: expect.objectContaining({ id: parent.id }) }),
      );

      if (kind === "agent") {
        const child = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          callerAgentId: parent.id,
        });
        expect(child.workspaceId).toBe(parent.workspaceId);
        expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
      } else {
        const result = await ctx.client.createWorkspace({
          source: { kind: "directory", path: cwd },
          callerAgentId: parent.id,
        });
        expect(result.error).toBeNull();
        expect(result.workspace?.background).toBe(true);
      }
      expect(ctx.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();
    } finally {
      await ctx?.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
