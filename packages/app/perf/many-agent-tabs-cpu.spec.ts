import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CDPSession, Page, WebSocket } from "@playwright/test";
import { expect, test } from "../e2e/support/fixtures";
import { openAgentRoute } from "../e2e/support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../e2e/support/helpers/seed-client";

/*
 * Measures what an idle app costs while many agent tabs are open, and while one agent that
 * is not on screen streams. Each test opens N agent tabs in one workspace, visits every tab
 * once, returns to the first and then samples renderer CPU, daemon CPU and WebSocket traffic
 * over a fixed idle window and a fixed streaming window.
 *
 *   PASEO_MANY_TABS_COUNTS=1,5,10,20  tab counts to measure
 *   PASEO_MANY_TABS_RUNS=3            repetitions per tab count
 *   PASEO_MANY_TABS_WINDOW_MS=60000   length of each window
 *   PASEO_MANY_TABS_OUT=/tmp/x.jsonl  append one JSON line per run
 *   PASEO_MANY_TABS_CPU_PROFILE=/tmp/p  write <p>-N<n>-<window>.cpuprofile for each run
 *   PASEO_MANY_TABS_RENDERS=1         count React commits and component renders
 *   PASEO_MANY_TABS_CHURN_MS=3000     during the streaming window, also start a short turn on
 *                                     one background agent this often (agent_update churn)
 */

const TAB_COUNTS = (process.env.PASEO_MANY_TABS_COUNTS ?? "1,5,10,20")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const RUNS = Number(process.env.PASEO_MANY_TABS_RUNS ?? 3);
const WINDOW_MS = Number(process.env.PASEO_MANY_TABS_WINDOW_MS ?? 60_000);
const SETTLE_MS = 10_000;
const BACKGROUND_IDLE_AGENTS = 10;
const OUT = process.env.PASEO_MANY_TABS_OUT;
const CPU_PROFILE = process.env.PASEO_MANY_TABS_CPU_PROFILE;
const COUNT_RENDERS = process.env.PASEO_MANY_TABS_RENDERS === "1";
const CHURN_MS = Number(process.env.PASEO_MANY_TABS_CHURN_MS ?? 3_000);
const CLOCK_TICKS_PER_SECOND = 100;

interface TabWorkspace {
  workspace: SeededWorkspace;
  agentIds: string[];
}

interface WindowSample {
  wallSeconds: number;
  rendererCpuSeconds: number;
  browserCpuSeconds: number;
  gpuCpuSeconds: number;
  taskSeconds: number;
  scriptSeconds: number;
  layoutSeconds: number;
  styleSeconds: number;
  daemonCpuSeconds: number;
  inbound: Record<string, number>;
  outbound: Record<string, number>;
  inboundBytes: number;
  outboundBytes: number;
  reactCommits?: number;
  reactRendersTop?: Array<[string, number]>;
  loadavg: string;
}

declare global {
  var __PASEO_MANY_TABS_COMMITS__: number | undefined;
  var __PASEO_MANY_TABS_RENDERS__: Record<string, number> | undefined;
}

test.describe.configure({ mode: "serial" });

test.describe("many agent tabs CPU", () => {
  const tabWorkspaces = new Map<number, TabWorkspace>();
  let background: SeededWorkspace;
  let streamerId: string;
  const backgroundIds: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    background = await seedWorkspace({ repoPrefix: "many-tabs-bg-", title: "Background" });
    for (let index = 0; index < BACKGROUND_IDLE_AGENTS; index += 1) {
      backgroundIds.push(await createIdleAgent(background, `Background ${index + 1}`));
    }
    streamerId = await createIdleAgent(background, "Streamer", "one-minute-stream");
    for (const count of TAB_COUNTS) {
      const workspace = await seedWorkspace({
        repoPrefix: `many-tabs-${count}-`,
        title: `Tabs ${count}`,
      });
      const agentIds: string[] = [];
      for (let index = 0; index < count; index += 1) {
        agentIds.push(await createIdleAgent(workspace, `Tab ${count}.${index + 1}`));
      }
      tabWorkspaces.set(count, { workspace, agentIds });
    }
  });

  test.afterAll(async () => {
    for (const { workspace } of tabWorkspaces.values()) await workspace.cleanup();
    await background?.cleanup();
  });

  for (const count of TAB_COUNTS) {
    for (let run = 1; run <= RUNS; run += 1) {
      test(`N=${count} run ${run}`, async ({ page, browser }) => {
        test.setTimeout(SETTLE_MS + WINDOW_MS * 2 + 240_000);
        const tabs = tabWorkspaces.get(count);
        if (!tabs) throw new Error(`No seeded workspace for N=${count}`);
        if (COUNT_RENDERS) await installCommitCounter(page);
        const traffic = recordTraffic(page);

        await openAgentRoute(page, {
          workspaceId: tabs.workspace.workspaceId,
          agentId: tabs.agentIds[0],
        });
        for (const agentId of [...tabs.agentIds.slice(1), tabs.agentIds[0]]) {
          const tab = page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true });
          await expect(tab.first()).toBeVisible({ timeout: 60_000 });
          await tab.first().click();
        }
        await expect(
          page.locator('[data-testid^="workspace-tab-agent_"]').filter({ visible: true }),
        ).toHaveCount(count, { timeout: 60_000 });
        await page.waitForTimeout(SETTLE_MS);

        const pageSession = await page.context().newCDPSession(page);
        await pageSession.send("Performance.enable", { timeDomain: "threadTicks" });
        const browserSession = await browser.newBrowserCDPSession();

        const idle = await measureWindow({
          page,
          pageSession,
          browserSession,
          traffic,
          profilePath: CPU_PROFILE ? `${CPU_PROFILE}-N${count}-r${run}-idle.cpuprofile` : null,
          during: () => page.waitForTimeout(WINDOW_MS),
        });
        const streaming = await measureWindow({
          page,
          pageSession,
          browserSession,
          traffic,
          profilePath: CPU_PROFILE ? `${CPU_PROFILE}-N${count}-r${run}-stream.cpuprofile` : null,
          during: async () => {
            await background.client.sendAgentMessage(streamerId, "stream");
            const churn = CHURN_MS > 0 ? startChurn(background, backgroundIds) : null;
            try {
              await page.waitForTimeout(WINDOW_MS);
            } finally {
              if (churn) clearInterval(churn);
            }
          },
        });
        await background.client.waitForFinish(streamerId, 120_000);
        for (const agentId of backgroundIds) await background.client.waitForFinish(agentId, 60_000);

        const result = { tabs: count, run, idle, streaming };
        console.log(`[perf] many-agent-tabs ${JSON.stringify(summarize(result))}`);
        if (OUT) appendFileSync(OUT, `${JSON.stringify(result)}\n`);
        await browserSession.detach();
        await pageSession.detach();
      });
    }
  }
});

function startChurn(
  workspace: SeededWorkspace,
  agentIds: string[],
): ReturnType<typeof setInterval> {
  let next = 0;
  const sendNext = () => {
    const agentId = agentIds[next % agentIds.length];
    next += 1;
    workspace.client.sendAgentMessage(agentId, "churn").catch(() => undefined);
  };
  return setInterval(sendNext, CHURN_MS);
}

async function createIdleAgent(
  workspace: SeededWorkspace,
  title: string,
  model = "e2e-fast-stream",
): Promise<string> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
    modeId: "load-test",
    model,
  });
  return agent.id;
}

interface TrafficCounters {
  inbound: Record<string, number>;
  outbound: Record<string, number>;
  inboundBytes: number;
  outboundBytes: number;
}

function recordTraffic(page: Page): { take(): TrafficCounters } {
  let counters: TrafficCounters = { inbound: {}, outbound: {}, inboundBytes: 0, outboundBytes: 0 };
  const classify = (payload: string | Buffer): string => {
    if (typeof payload !== "string") return "binary";
    try {
      const parsed = JSON.parse(payload) as {
        type?: string;
        message?: { type?: string; payload?: { event?: { type?: string } } };
      };
      const inner = parsed.message?.type;
      if (!inner) return parsed.type ?? "unknown";
      const event = parsed.message?.payload?.event?.type;
      return event ? `${inner}:${event}` : inner;
    } catch {
      return "unparsed";
    }
  };
  page.on("websocket", (socket: WebSocket) => {
    socket.on("framereceived", ({ payload }) => {
      const type = classify(payload);
      counters.inbound[type] = (counters.inbound[type] ?? 0) + 1;
      counters.inboundBytes += payload.length;
    });
    socket.on("framesent", ({ payload }) => {
      const type = classify(payload);
      counters.outbound[type] = (counters.outbound[type] ?? 0) + 1;
      counters.outboundBytes += payload.length;
    });
  });
  return {
    take() {
      const taken = counters;
      counters = { inbound: {}, outbound: {}, inboundBytes: 0, outboundBytes: 0 };
      return taken;
    },
  };
}

async function installCommitCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const PERFORMED_WORK = 1;
    interface Fiber {
      type: unknown;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    }
    const nameOf = (type: unknown): string | null => {
      if (typeof type === "function") {
        return (type as { displayName?: string }).displayName || type.name || null;
      }
      if (!type || typeof type !== "object") return null;
      const component = type as { displayName?: string; render?: unknown; type?: unknown };
      return component.displayName || nameOf(component.render) || nameOf(component.type);
    };
    let rendererCount = 0;
    Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map(),
        inject(renderer: unknown) {
          rendererCount += 1;
          this.renderers.set(rendererCount, renderer);
          return rendererCount;
        },
        checkDCE() {},
        onScheduleFiberRoot() {},
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          globalThis.__PASEO_MANY_TABS_COMMITS__ =
            (globalThis.__PASEO_MANY_TABS_COMMITS__ ?? 0) + 1;
          const renders = (globalThis.__PASEO_MANY_TABS_RENDERS__ ??= {});
          const pending: Fiber[] = [root.current];
          while (pending.length > 0) {
            const fiber = pending.pop()!;
            const name = typeof fiber.type === "string" ? null : nameOf(fiber.type);
            if (name && (fiber.flags & PERFORMED_WORK) !== 0) {
              renders[name] = (renders[name] ?? 0) + 1;
            }
            if (fiber.alternate && fiber.child === fiber.alternate.child) continue;
            for (let child = fiber.child; child; child = child.sibling) pending.push(child);
          }
        },
        onPostCommitFiberRoot() {},
        onCommitFiberUnmount() {},
      },
    });
  });
}

function daemonCpuSeconds(): number {
  const home = process.env.E2E_PASEO_HOME;
  if (!home) throw new Error("E2E_PASEO_HOME is not set");
  const marker = `PASEO_HOME=${home}\0`;
  let ticks = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (!environ.includes(marker)) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(fields[11]) + Number(fields[12]);
    } catch {
      // The process exited or belongs to another user.
    }
  }
  return ticks / CLOCK_TICKS_PER_SECOND;
}

async function processCpu(
  session: CDPSession,
): Promise<{ renderer: number; browser: number; gpu: number }> {
  const { processInfo } = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: Array<{ type: string; id: number; cpuTime: number }>;
  };
  const sum = (type: string) =>
    processInfo
      .filter((info) => info.type === type)
      .reduce((total, info) => total + info.cpuTime, 0);
  return { renderer: sum("renderer"), browser: sum("browser"), gpu: sum("GPU") };
}

async function performanceMetrics(session: CDPSession): Promise<Record<string, number>> {
  const { metrics } = (await session.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

async function measureWindow(input: {
  page: Page;
  pageSession: CDPSession;
  browserSession: CDPSession;
  traffic: { take(): TrafficCounters };
  profilePath: string | null;
  during: () => Promise<void>;
}): Promise<WindowSample> {
  const { page, pageSession, browserSession } = input;
  if (input.profilePath) {
    await pageSession.send("Profiler.enable");
    await pageSession.send("Profiler.setSamplingInterval", { interval: 1000 });
    await pageSession.send("Profiler.start");
  }
  if (COUNT_RENDERS) {
    await page.evaluate(() => {
      globalThis.__PASEO_MANY_TABS_COMMITS__ = 0;
      globalThis.__PASEO_MANY_TABS_RENDERS__ = {};
    });
  }
  input.traffic.take();
  const startedAt = Date.now();
  const cpuBefore = await processCpu(browserSession);
  const metricsBefore = await performanceMetrics(pageSession);
  const daemonBefore = daemonCpuSeconds();
  const loadBefore = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

  await input.during();

  const daemonAfter = daemonCpuSeconds();
  const metricsAfter = await performanceMetrics(pageSession);
  const cpuAfter = await processCpu(browserSession);
  const traffic = input.traffic.take();
  const wallSeconds = (Date.now() - startedAt) / 1000;
  const loadAfter = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
  if (input.profilePath) {
    const { profile } = await pageSession.send("Profiler.stop");
    writeFileSync(input.profilePath, JSON.stringify(profile));
    await pageSession.send("Profiler.disable");
  }
  const delta = (name: string) => (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0);
  const sample: WindowSample = {
    wallSeconds,
    rendererCpuSeconds: cpuAfter.renderer - cpuBefore.renderer,
    browserCpuSeconds: cpuAfter.browser - cpuBefore.browser,
    gpuCpuSeconds: cpuAfter.gpu - cpuBefore.gpu,
    taskSeconds: delta("TaskDuration"),
    scriptSeconds: delta("ScriptDuration"),
    layoutSeconds: delta("LayoutDuration"),
    styleSeconds: delta("RecalcStyleDuration"),
    daemonCpuSeconds: daemonAfter - daemonBefore,
    ...traffic,
    loadavg: `${loadBefore} -> ${loadAfter}`,
  };
  if (COUNT_RENDERS) {
    const renders = await page.evaluate(() => ({
      commits: globalThis.__PASEO_MANY_TABS_COMMITS__ ?? 0,
      renders: globalThis.__PASEO_MANY_TABS_RENDERS__ ?? {},
    }));
    sample.reactCommits = renders.commits;
    sample.reactRendersTop = Object.entries(renders.renders)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 25);
  }
  return sample;
}

function summarize(result: {
  tabs: number;
  run: number;
  idle: WindowSample;
  streaming: WindowSample;
}) {
  const brief = (sample: WindowSample) => ({
    rendererCpuS: round(sample.rendererCpuSeconds),
    taskS: round(sample.taskSeconds),
    scriptS: round(sample.scriptSeconds),
    daemonCpuS: round(sample.daemonCpuSeconds),
    inMsgs: Object.values(sample.inbound).reduce((total, value) => total + value, 0),
    outMsgs: Object.values(sample.outbound).reduce((total, value) => total + value, 0),
    commits: sample.reactCommits,
    loadavg: sample.loadavg,
  });
  return {
    tabs: result.tabs,
    run: result.run,
    idle: brief(result.idle),
    streaming: brief(result.streaming),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
