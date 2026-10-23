import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect } from "../fixtures";
import { seedWorkspace } from "./seed-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { openAgentRoute } from "./mock-agent";

export async function verifyRealHermesDelegation(page: Page, info: TestInfo, failure: boolean) {
  const ws = await seedWorkspace({ repoPrefix: "hermes-real-synthetic-" });
  const observer = await connectDaemonClient<
    Pick<
      DaemonClient,
      "connect" | "close" | "listProviderSubagents" | "fetchProviderSubagentTimeline"
    >
  >({ clientIdPrefix: "hermes-real" });
  const evidence: Record<string, unknown> = {
    kind: "real-model",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    failureInjection: failure ? "unavailable child model; real runtime failure" : false,
  };
  try {
    for (const name of ["one.txt", "two.txt", "three.txt"])
      writeFileSync(path.join(ws.repoPath, name), "synthetic QA only\n");
    const agent = await ws.client.createAgent({
      provider: "hermes",
      cwd: ws.repoPath,
      workspaceId: ws.workspaceId,
      title: "REAL MODEL QA: Count files",
    });
    const began = Date.now();
    await ws.client.sendAgentMessage(
      agent.id,
      "Use delegate_task once with goal: Count files. First use terminal to sleep for 40 seconds, then count the three synthetic .txt files in the current workspace and report only the count. Child toolsets terminal and file. Immediately after delegation, reply exactly 'Parent acknowledged; child continues.' Do not poll, wait, or execute the child task yourself. This is a safe real-model integration test.",
    );
    await ws.client.waitForFinish(agent.id, 180000);
    evidence.parentReplyElapsedMs = Date.now() - began;
    await expect
      .poll(async () => (await observer.listProviderSubagents(agent.id)).subagents.length, {
        timeout: 10000,
      })
      .toBeGreaterThan(0);
    let child = (await observer.listProviderSubagents(agent.id)).subagents[0]!;
    evidence.childAtParentReply = {
      title: child.title,
      description: child.description,
      status: child.status,
    };
    expect(child.description).toBe("Count files");
    await openAgentRoute(page, { workspaceId: ws.workspaceId, agentId: agent.id });
    await page.getByTestId("subagents-track-header").click();
    await page.getByTestId(`subagents-track-row-${child.id}`).click();
    await expect(page.getByText("Count files", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("real-child-before-reconnect.png") });
    await page.reload();
    await expect(page.getByText("Count files", { exact: true }).first()).toBeVisible();
    evidence.childAfterReconnect = (
      await observer.listProviderSubagents(agent.id)
    ).subagents[0]!.status;
    await expect
      .poll(async () => (await observer.listProviderSubagents(agent.id)).subagents[0]!.status, {
        timeout: 160000,
        intervals: [1000],
      })
      .not.toBe("running");
    child = (await observer.listProviderSubagents(agent.id)).subagents[0]!;
    evidence.terminalStatus = child.status;
    const timeline = await observer.fetchProviderSubagentTimeline(agent.id, child.id);
    evidence.publicTimeline = timeline.rows.map((row) => row.item);
    await page.screenshot({ path: info.outputPath("real-child-terminal.png") });
    if (!failure) expect(evidence.childAtParentReply).toMatchObject({ status: "running" });
    expect(child.status).toBe(failure ? "failed" : "completed");
  } catch (error) {
    evidence.error = String(error);
    await page.screenshot({ path: info.outputPath("real-failure.png") });
    throw error;
  } finally {
    writeFileSync(info.outputPath("real-model-outcome.json"), JSON.stringify(evidence, null, 2));
    await info.attach("real-model-outcome.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });

    await observer.close();
    await ws.cleanup();
  }
}
