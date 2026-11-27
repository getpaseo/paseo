import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createDaemonTestContext } from "../test-utils/index.js";
import { githubWatchFixture } from "./test-utils/github-watch-fixture.js";

const subscribe = "subscribe_change_request";
const unsubscribe = "unsubscribe_change_request";
const waitForGitHub = { timeout: 240_000, interval: 1_000 };

function holdTurn() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function promptText(prompt: AgentPromptInput) {
  return typeof prompt === "string"
    ? prompt
    : prompt.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function description({ html_url, number }: { html_url: string; number: number }) {
  return `${new URL(html_url).pathname.split("/").slice(1, 3).join("/")} #${number}`;
}

test("GitHub PR watches batch with child messages and survive restart", async ({
  onTestFinished,
}) => {
  const artifacts = path.resolve(import.meta.dirname, "../../../../../.artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "change-request-watch-"));
  const [idleDir, busyDir, lateDir, childDir] = ["idle", "busy", "late", "child"].map((name) =>
    path.join(root, name),
  );
  const turns: { cwd: string; text: string; at: number }[] = [];
  const catalogs = new Map<string, PaseoToolCatalog>();
  const holdForDelivery = holdTurn();
  const holdForUnsubscribe = holdTurn();

  const provider = createTestAgentClient("claude", {
    onStartTurn(prompt, config) {
      turns.push({ cwd: config.cwd, text: promptText(prompt), at: Date.now() });
    },
    async beforeTurnComplete(prompt) {
      const text = promptText(prompt);
      if (text === "Hold this QA turn") await holdForDelivery.promise;
      if (text === "Hold while I unsubscribe") await holdForUnsubscribe.promise;
    },
  });

  // Use the real catalog that AgentManager passes to native-tool providers.
  const startDaemon = () =>
    createDaemonTestContext({
      paseoHomeRoot: root,
      staticDir: path.join(root, "static"),
      cleanup: false,
      mcpEnabled: true,
      resumeOnStartup: false,
      agentClients: {
        claude: {
          ...provider,
          capabilities: { ...provider.capabilities, supportsNativePaseoTools: true },
          createSession(config, launchContext) {
            if (launchContext?.paseoTools) catalogs.set(config.cwd, launchContext.paseoTools);
            return provider.createSession(config, launchContext);
          },
          resumeSession: provider.resumeSession.bind(provider),
          fetchCatalog: provider.fetchCatalog.bind(provider),
          isAvailable: provider.isAvailable?.bind(provider),
        },
      },
    });

  let context: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let github: Awaited<ReturnType<typeof githubWatchFixture>> | undefined;
  const connections = new Set<Client>();

  const updates = (cwd: string) =>
    turns.filter(
      (turn) => turn.cwd === cwd && turn.text.includes("Paseo change request update for"),
    );
  const busyTurns = (since = 0) =>
    turns
      .slice(since)
      .filter(({ cwd }) => cwd === busyDir)
      .map(({ text }) => text);

  async function connectMcp(port: number, agentId: string) {
    const mcp = new Client({ name: "change-request-watch-test", version: "1" });
    connections.add(mcp);
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId}`),
      ),
    );
    return mcp;
  }

  async function call(mcp: Client, name: string, url: string) {
    const result = await mcp.callTool({ name, arguments: { url } }, undefined, {
      timeout: 120_000,
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent;
  }

  async function backgroundWorkCount(
    client: Awaited<ReturnType<typeof startDaemon>>["client"],
    agentId: string,
  ) {
    const result = await client.fetchAgent({ agentId });
    expect(result?.agent.id).toBe(agentId);
    return result?.agent.backgroundWork?.count ?? 0;
  }

  onTestFinished(async () => {
    holdForDelivery.resolve();
    holdForUnsubscribe.resolve();
    const cleanup = await Promise.allSettled([
      ...Array.from(connections, (mcp) => mcp.close()),
      context?.cleanup(),
      github?.close(),
    ]);
    await rm(root, { recursive: true, force: true });
    for (const result of cleanup) {
      if (result.status === "rejected") throw result.reason;
    }
  });

  await Promise.all(
    [idleDir, busyDir, lateDir, childDir, path.join(root, "static")].map((dir) => mkdir(dir)),
  );
  context = await startDaemon();
  const { client, daemon } = context;
  const idle = await client.createAgent({
    provider: "claude",
    cwd: idleDir,
    modeId: "full-access",
  });
  const mcp = await connectMcp(daemon.port, idle.id);
  const { tools } = await mcp.listTools();
  expect(tools.map(({ name }) => name)).toEqual(expect.arrayContaining([subscribe, unsubscribe]));

  github = await githubWatchFixture(root);
  const fixture = github;
  const { primary: original, quiet } = await fixture.createPullRequests(12);
  const primary = await fixture.updateCheck(original, "green");
  console.info(`Tracking ${quiet.length + 1} private GitHub PRs`);
  await fixture.checkout(idleDir, primary.head.ref);
  const baselineComments = await fixture.seedComments(primary, 100);
  await expect
    .poll(async () => (await fixture.checkRun(primary))?.conclusion, waitForGitHub)
    .toBe("success");

  const workspace = await client.createWorkspace({ source: { kind: "directory", path: idleDir } });
  expect(workspace.workspace).toMatchObject({ workspaceDirectory: idleDir });
  await client.fetchWorkspaces({ subscribe: {} });
  expect((await client.checkoutPrStatus(idleDir)).status).toMatchObject({
    url: primary.html_url,
    headRefName: primary.head.ref,
  });
  const all = [primary, ...quiet];
  const before = await fixture.limits();
  const initial = await Promise.all(all.map(({ html_url }) => call(mcp, subscribe, html_url)));
  for (const [index, pr] of all.entries()) {
    expect(initial[index]).toMatchObject({
      url: pr.html_url,
      state: "open",
      headSha: pr.head.sha,
      subscribed: true,
    });
  }
  expect(initial[0]).toMatchObject({
    checksState: "passed",
    checks: expect.arrayContaining([
      expect.objectContaining({ name: "qa-check", state: "passed" }),
    ]),
    reviewDecision: null,
  });
  const afterFirst = await fixture.limits();

  const busy = await client.createAgent({
    provider: "claude",
    cwd: busyDir,
    modeId: "full-access",
  });
  const native = catalogs.get(busyDir);
  if (!native)
    throw new Error("The daemon did not give the fixture provider a native tool catalog");
  for (const pr of all) {
    const result = await native.executeTool(subscribe, { url: pr.html_url });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ url: pr.html_url, subscribed: true });
  }
  const afterShared = await fixture.limits();
  console.info(
    "GitHub authenticated budget before/after first and shared registrations",
    JSON.stringify([before, afterFirst, afterShared]),
  );
  expect(turns).toEqual([]);
  await verifyBackgroundWork(native);

  async function verifyBackgroundWork(nativeTools: PaseoToolCatalog) {
    const idleWork = await client.listAgentBackgroundWork(idle.id);
    const busyWork = await client.listAgentBackgroundWork(busy.id);
    const descriptions = all.map(description).sort();
    expect(idleWork.map((row) => row.description).sort()).toEqual(descriptions);
    expect(busyWork.map((row) => row.description).sort()).toEqual(descriptions);
    expect((await client.fetchAgent({ agentId: idle.id }))?.agent.status).toBe("idle");
    expect(await backgroundWorkCount(client, idle.id)).toBe(all.length);
    expect(await backgroundWorkCount(client, busy.id)).toBe(all.length);

    await call(mcp, subscribe, primary.html_url);
    expect(await client.listAgentBackgroundWork(idle.id)).toEqual(idleWork);
    const quietPr = quiet[0]!;
    const stopped = busyWork.find((row) => row.description === description(quietPr));
    if (!stopped) throw new Error("The quiet PR has no background work row");
    expect(stopped).toMatchObject({
      kind: "monitor",
      canStop: true,
      stopToken: expect.any(String),
    });
    await client.stopAgentBackgroundWork(busy.id, stopped);
    expect(
      (await nativeTools.executeTool(unsubscribe, { url: quietPr.html_url })).structuredContent,
    ).toMatchObject({ removed: false });
    expect(await backgroundWorkCount(client, busy.id)).toBe(all.length - 1);
    expect(await client.listAgentBackgroundWork(idle.id)).toEqual(idleWork);
    expect(
      (await nativeTools.executeTool(subscribe, { url: quietPr.html_url })).structuredContent,
    ).toMatchObject({ subscribed: true });
    await expect(client.stopAgentBackgroundWork(busy.id, stopped)).rejects.toThrow(
      "Background work is no longer available to stop",
    );
    expect(await backgroundWorkCount(client, busy.id)).toBe(all.length);
  }

  const childWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: childDir },
  });
  if (!childWorkspace.workspace) throw new Error("The child workspace was not created");
  const busyMcp = await connectMcp(daemon.port, busy.id);
  const child = await busyMcp.callTool({
    name: "create_agent",
    arguments: {
      title: "QA child",
      provider: "claude/haiku",
      settings: { modeId: "full-access" },
      workspaceId: childWorkspace.workspace.id,
      initialPrompt: "Reply with OK",
      notifyOnFinish: false,
    },
  });
  expect(child.isError, JSON.stringify(child.content)).not.toBe(true);
  const created = child.structuredContent;
  const childId =
    created && typeof created === "object" && "agentId" in created ? created.agentId : undefined;
  if (typeof childId !== "string") throw new Error("The daemon did not return the child agent ID");
  expect((await client.waitForFinish(childId)).status).toBe("idle");
  const childMcp = await connectMcp(daemon.port, childId);

  async function sendFromChild(prompt: string) {
    const result = await childMcp.callTool({
      name: "send_agent_prompt",
      arguments: { agentId: busy.id, prompt, notifyOnFinish: false },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ success: true, deliveryStatus: "queued" });
  }

  const url = primary.html_url;
  expect(await call(mcp, subscribe, `${url}?source=qa#conversation`)).toEqual(initial[0]);
  await fixture.switchToBase(idleDir);
  await client.sendMessage(busy.id, "Hold this QA turn");
  await client.waitForAgentUpsert(busy.id, (agent) => agent.status === "running");
  const failed = await fixture.updateCheck(primary, "red");
  await expect
    .poll(async () => (await fixture.checkRun(failed))?.conclusion, waitForGitHub)
    .toBe("failure");
  const failedCheck = await fixture.checkRun(failed);
  if (!failedCheck) throw new Error("GitHub did not return the failing check");
  expect(failedCheck.details_url).toMatch(/\/actions\/runs\/\d+\/job\/\d+$/);
  await expect
    .poll(() => call(mcp, subscribe, url), waitForGitHub)
    .toMatchObject({
      headSha: failed.head.sha,
      checksState: "failed",
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "qa-check",
          state: "failed",
          url: failedCheck.details_url,
        }),
      ]),
    });
  const firstObservationSeen = Date.now();

  const late = await client.createAgent({
    provider: "claude",
    cwd: lateDir,
    modeId: "full-access",
  });
  const lateMcp = await connectMcp(daemon.port, late.id);
  expect(await call(lateMcp, subscribe, url)).toMatchObject({
    headSha: failed.head.sha,
    checksState: "failed",
    subscribed: true,
  });
  const page101 = await fixture.comment(primary, "qa-page-comment-101");
  const review = await fixture.review(failed, "qa new review", "qa new inline comment");

  await expect
    .poll(
      () =>
        updates(idleDir)
          .map(({ text }) => text)
          .join("\n"),
      waitForGitHub,
    )
    .toContain(review.inline);
  const idleFailure = updates(idleDir).find(({ text }) => text.includes("Check failed"));
  expect(idleFailure?.text).toContain(`Check failed on ${failed.head.sha}: &quot;qa-check&quot;`);
  expect(idleFailure?.text).toContain(failedCheck.details_url);
  expect(idleFailure?.text).toContain(url);
  // The subscribe response observes the committed snapshot. The digest must not extend
  // its first window after the later writes, regardless of their GitHub propagation time.
  expect(idleFailure!.at - firstObservationSeen).toBeLessThan(35_000);

  await expect
    .poll(
      () =>
        updates(lateDir)
          .map(({ text }) => text)
          .join("\n"),
      waitForGitHub,
    )
    .toContain(review.inline);
  const lateUpdates = updates(lateDir)
    .map(({ text }) => text)
    .join("\n");
  expect(lateUpdates).toContain(page101);
  expect(lateUpdates).toContain(review.review);
  expect(lateUpdates).not.toContain("Check failed");
  const childReport = "QA child report for the failed build.";
  await sendFromChild(childReport);
  expect(busyTurns()).toEqual(["Hold this QA turn"]);

  const beforeFirstRelease = turns.length;
  holdForDelivery.resolve();
  await expect
    .poll(() => busyTurns(beforeFirstRelease).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const released = busyTurns(beforeFirstRelease);
  expect(released).toEqual([expect.stringContaining(childReport)]);
  const [nextTurn] = released;
  expect(nextTurn).toContain(review.inline);
  expect(nextTurn).toContain(page101);
  expect(nextTurn).toContain(`Check failed on ${failed.head.sha}`);
  const envelopes = nextTurn?.match(/<paseo-system [^>]+>\n[\s\S]*?\n<\/paseo-system>/g);
  const childEnvelope = envelopes?.find((envelope) => envelope.includes(childReport));
  expect(childEnvelope).toContain(`kind="agent-message" source-agent-id="${childId}"`);
  expect(childEnvelope).toContain('source-agent-title="QA child"');
  expect(childEnvelope).not.toContain(url);
  const prEnvelope = envelopes?.find((envelope) => envelope.includes(failedCheck.details_url));
  expect(prEnvelope).toContain('kind="change-request-update"');
  expect(prEnvelope).toContain(`source-url="${url}"`);
  expect(prEnvelope).not.toContain(childReport);
  expect((await client.waitForFinish(busy.id)).status).toBe("idle");
  await client.sendMessage(busy.id, "Hold while I unsubscribe");
  await client.waitForAgentUpsert(busy.id, (agent) => agent.status === "running");
  const discarded = await fixture.comment(primary, "QA comment while another subscriber is busy");
  await expect.poll(() => updates(idleDir).at(-1)?.text, waitForGitHub).toContain(discarded);
  await expect.poll(() => updates(lateDir).at(-1)?.text, waitForGitHub).toContain(discarded);
  const retainedChildReport = "QA child report that stays queued after unsubscribe.";
  await sendFromChild(retainedChildReport);
  const nativeRemoval = await native.executeTool(unsubscribe, { url });
  expect(nativeRemoval.structuredContent).toMatchObject({ url, removed: true });
  expect(await backgroundWorkCount(client, busy.id)).toBe(all.length - 1);
  expect(
    (await client.listAgentBackgroundWork(busy.id)).map((row) => row.description),
  ).not.toContain(description(primary));
  const beforeSecondRelease = turns.length;
  holdForUnsubscribe.resolve();
  await expect
    .poll(() => busyTurns(beforeSecondRelease).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(busyTurns(beforeSecondRelease)).toEqual([expect.stringContaining(retainedChildReport)]);
  expect(turns.some(({ cwd, text }) => cwd === busyDir && text.includes(discarded))).toBe(false);
  expect((await client.waitForFinish(busy.id)).status).toBe("idle");
  await client.archiveAgent(busy.id);
  await client.archiveAgent(late.id);
  await expect(client.listAgentBackgroundWork(late.id)).rejects.toThrow("Agent is archived");

  for (const { html_url } of quiet) {
    expect(await call(mcp, unsubscribe, html_url)).toMatchObject({ removed: true });
  }
  const [beforeRestart] = await client.listAgentBackgroundWork(idle.id);
  expect(beforeRestart).toMatchObject({ kind: "monitor", description: description(primary) });
  expect(await backgroundWorkCount(client, idle.id)).toBe(1);
  const deliveredBeforeRestart = turns.length;
  await Promise.all(Array.from(connections, (connection) => connection.close()));
  connections.clear();
  await context.cleanup();
  context = undefined;

  const green = await fixture.updateCheck(failed, "green");
  await expect
    .poll(async () => (await fixture.checkRun(green))?.conclusion, waitForGitHub)
    .toBe("success");
  context = await startDaemon();
  expect(await context.client.listAgentBackgroundWork(idle.id)).toEqual([
    {
      ...beforeRestart,
      stopToken: expect.any(String),
    },
  ]);
  expect(await backgroundWorkCount(context.client, idle.id)).toBe(1);
  await expect
    .poll(() => turns.slice(deliveredBeforeRestart).map(({ text }) => text), waitForGitHub)
    .toEqual([expect.stringContaining(`Checks passed on ${green.head.sha}.`)]);
  expect(turns.at(-1)).toMatchObject({ cwd: idleDir });
  expect(turns.at(-1)?.text).not.toContain(page101);
  expect(turns.at(-1)?.text).not.toContain(review.inline);

  const restored = await connectMcp(context.daemon.port, idle.id);
  await fixture.closePull(primary);
  await expect
    .poll(() => updates(idleDir).at(-1)?.text, waitForGitHub)
    .toContain("Change request closed.");
  expect(updates(idleDir).at(-1)?.text).toContain(url);
  expect(await backgroundWorkCount(context.client, idle.id)).toBe(0);
  expect(await call(restored, unsubscribe, url)).toMatchObject({ url, removed: false });
  expect(await call(restored, subscribe, url)).toMatchObject({
    url,
    state: "closed",
    subscribed: false,
  });
  expect(turns.filter(({ text }) => baselineComments.some((link) => text.includes(link)))).toEqual(
    [],
  );
  expect(
    updates(idleDir).every(({ text }) =>
      text.startsWith(`<paseo-system version="1" kind="change-request-update" source-url="${url}"`),
    ),
  ).toBe(true);
  expect(busyTurns()).toHaveLength(4);
  expect(updates(busyDir).some(({ text }) => text.includes(discarded))).toBe(false);
  expect(turns.filter(({ text }) => text.includes(page101))).toHaveLength(3);
  expect(turns.filter(({ text }) => text.includes("Check failed"))).toHaveLength(2);
  expect(turns.filter(({ text }) => text.includes("Change request closed."))).toHaveLength(1);
  expect(
    turns.filter(({ text }) => quiet.some((pr) => text.includes(`for ${pr.html_url}\n`))),
  ).toEqual([]);
  console.info(
    "Agent deliveries",
    JSON.stringify(turns.map(({ cwd, text, at }) => ({ recipient: path.basename(cwd), text, at }))),
  );
}, 1_200_000);
