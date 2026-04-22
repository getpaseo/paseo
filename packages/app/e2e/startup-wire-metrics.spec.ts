import { Buffer } from "node:buffer";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

type WireDirection = "sent" | "received";
type WirePhase = "startup" | "workspace_clicks";

type ParsedWireMessage = {
  type: string | null;
  requestId: string | null;
  entryCount: number | null;
  hasMore: boolean | null;
  providerEntries: ProviderSnapshotWireEntry[] | null;
};

type WireFrameRecord = ParsedWireMessage & {
  phase: WirePhase;
  direction: WireDirection;
  bytes: number;
};

type ProviderSnapshotWireEntry = {
  provider: string;
  status: string | null;
  modelCount: number;
  modeCount: number;
  bytes: number;
};

type WebSocketFrameEvent = {
  requestId: string;
  response: {
    opcode: number;
    payloadData: string;
  };
};

type WireSummary = {
  totalFrames: number;
  totalBytes: number;
  byDirection: Record<WireDirection, { frames: number; bytes: number }>;
  byPhase: Record<
    WirePhase,
    {
      frames: number;
      bytes: number;
      byType: Array<{ type: string; frames: number; bytes: number }>;
      rpcCounts: Array<{ requestType: string; count: number }>;
      rpcs: Array<{ requestType: string; requestId: string; responseType: string | null }>;
    }
  >;
  fetchPages: Array<{
    phase: WirePhase;
    type: string;
    requestId: string | null;
    entries: number | null;
    hasMore: boolean | null;
    bytes: number;
  }>;
  clickedWorkspaces: Array<{ testId: string; frames: number; bytes: number }>;
  providerSnapshots: Array<{
    phase: WirePhase;
    type: string;
    requestId: string | null;
    totalModels: number;
    totalModes: number;
    bytes: number;
    providers: ProviderSnapshotWireEntry[];
  }>;
  providerSnapshotTotals: Array<{
    phase: WirePhase;
    provider: string;
    frames: number;
    bytes: number;
    maxModels: number;
    maxModes: number;
    statuses: string[];
  }>;
  fork: {
    sourceHome: string | null;
    targetHome: string | null;
    copiedFiles: number | null;
    copiedBytes: number | null;
  };
};

class WireMonitor {
  private phase: WirePhase = "startup";
  private session: CDPSession | null = null;
  readonly records: WireFrameRecord[] = [];

  async start(page: Page): Promise<void> {
    this.session = await page.context().newCDPSession(page);
    await this.session.send("Network.enable");
    this.session.on("Network.webSocketFrameSent", (event: WebSocketFrameEvent) => {
      this.record("sent", event);
    });
    this.session.on("Network.webSocketFrameReceived", (event: WebSocketFrameEvent) => {
      this.record("received", event);
    });
  }

  setPhase(phase: WirePhase): void {
    this.phase = phase;
  }

  hasCompletedStartupFetches(): boolean {
    return (
      this.records.some(
        (record) =>
          record.direction === "received" &&
          record.type === "fetch_agents_response" &&
          record.hasMore === false,
      ) &&
      this.records.some(
        (record) =>
          record.direction === "received" &&
          record.type === "fetch_workspaces_response" &&
          record.hasMore === false,
      )
    );
  }

  summarize(clickedWorkspaces: WireSummary["clickedWorkspaces"]): WireSummary {
    return {
      totalFrames: this.records.length,
      totalBytes: sumBytes(this.records),
      byDirection: {
        sent: summarizeDirection(this.records, "sent"),
        received: summarizeDirection(this.records, "received"),
      },
      byPhase: {
        startup: summarizePhase(this.records, "startup"),
        workspace_clicks: summarizePhase(this.records, "workspace_clicks"),
      },
      fetchPages: this.records
        .filter(
          (record) =>
            record.direction === "received" &&
            (record.type === "fetch_agents_response" ||
              record.type === "fetch_workspaces_response"),
        )
        .map((record) => ({
          phase: record.phase,
          type: record.type ?? "unknown",
          requestId: record.requestId,
          entries: record.entryCount,
          hasMore: record.hasMore,
          bytes: record.bytes,
        })),
      clickedWorkspaces,
      providerSnapshots: this.records
        .filter((record) => record.direction === "received" && record.providerEntries)
        .map((record) => ({
          phase: record.phase,
          type: record.type ?? "unknown",
          requestId: record.requestId,
          totalModels: sumProviderModels(record.providerEntries ?? []),
          totalModes: sumProviderModes(record.providerEntries ?? []),
          bytes: record.bytes,
          providers: record.providerEntries ?? [],
        })),
      providerSnapshotTotals: summarizeProviderSnapshots(this.records),
      fork: {
        sourceHome: process.env.E2E_FORK_SOURCE_PASEO_HOME ?? null,
        targetHome: process.env.E2E_FORK_TARGET_PASEO_HOME ?? null,
        copiedFiles: parseOptionalNumber(process.env.E2E_FORK_COPIED_FILES),
        copiedBytes: parseOptionalNumber(process.env.E2E_FORK_COPIED_BYTES),
      },
    };
  }

  private record(direction: WireDirection, event: WebSocketFrameEvent): void {
    if (event.response.opcode !== 1) {
      this.records.push({
        phase: this.phase,
        direction,
        bytes: Buffer.byteLength(event.response.payloadData),
        type: `opcode:${event.response.opcode}`,
        requestId: null,
        entryCount: null,
        hasMore: null,
        providerEntries: null,
      });
      return;
    }

    this.records.push({
      phase: this.phase,
      direction,
      bytes: Buffer.byteLength(event.response.payloadData, "utf8"),
      ...parseWireMessage(event.response.payloadData),
    });
  }
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWireMessage(payloadData: string): ParsedWireMessage {
  try {
    const parsed = JSON.parse(payloadData) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return emptyParsedWireMessage();
    }
    const envelope = parsed as {
      type?: unknown;
      message?: unknown;
    };
    const unwrapped =
      envelope.type === "session" && envelope.message && typeof envelope.message === "object"
        ? envelope.message
        : parsed;
    const message = unwrapped as {
      type?: unknown;
      requestId?: unknown;
      payload?: {
        requestId?: unknown;
        entries?: unknown;
        agents?: unknown;
        pageInfo?: { hasMore?: unknown };
      };
    };
    const entries = readMessageEntries(message.payload);
    const hasMore = readMessageHasMore(message.payload);
    const messageType = typeof message.type === "string" ? message.type : null;
    const providerEntries = isProviderSnapshotMessage(messageType)
      ? parseProviderSnapshotEntries(message.payload)
      : null;
    return {
      type: messageType,
      requestId: readMessageRequestId(message),
      entryCount: entries ? entries.length : null,
      hasMore,
      providerEntries,
    };
  } catch {
    return emptyParsedWireMessage();
  }
}

function readMessageRequestId(message: {
  requestId?: unknown;
  payload?: { requestId?: unknown };
}): string | null {
  if (typeof message.requestId === "string") {
    return message.requestId;
  }
  if (typeof message.payload?.requestId === "string") {
    return message.payload.requestId;
  }
  return null;
}

function isProviderSnapshotMessage(messageType: string | null): boolean {
  return (
    messageType === "get_providers_snapshot_response" || messageType === "providers_snapshot_update"
  );
}

function readMessageEntries(
  payload:
    | {
        entries?: unknown;
        agents?: unknown;
      }
    | undefined,
): unknown[] | null {
  if (Array.isArray(payload?.entries)) {
    return payload.entries;
  }
  if (Array.isArray(payload?.agents)) {
    return payload.agents;
  }
  return null;
}

function readMessageHasMore(
  payload: { pageInfo?: { hasMore?: unknown } } | undefined,
): boolean | null {
  return typeof payload?.pageInfo?.hasMore === "boolean" ? payload.pageInfo.hasMore : null;
}

function emptyParsedWireMessage(): ParsedWireMessage {
  return {
    type: null,
    requestId: null,
    entryCount: null,
    hasMore: null,
    providerEntries: null,
  };
}

function parseProviderSnapshotEntries(payload: unknown): ProviderSnapshotWireEntry[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return null;
  }

  const providerEntries: ProviderSnapshotWireEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const provider = (entry as { provider?: unknown }).provider;
    if (typeof provider !== "string") {
      continue;
    }
    const models = (entry as { models?: unknown }).models;
    const modes = (entry as { modes?: unknown }).modes;
    const status = (entry as { status?: unknown }).status;
    providerEntries.push({
      provider,
      status: typeof status === "string" ? status : null,
      modelCount: Array.isArray(models) ? models.length : 0,
      modeCount: Array.isArray(modes) ? modes.length : 0,
      bytes: Buffer.byteLength(JSON.stringify(entry), "utf8"),
    });
  }

  return providerEntries.length > 0 ? providerEntries : null;
}

function sumBytes(records: WireFrameRecord[]): number {
  return records.reduce((sum, record) => sum + record.bytes, 0);
}

function summarizeDirection(records: WireFrameRecord[], direction: WireDirection) {
  const selected = records.filter((record) => record.direction === direction);
  return {
    frames: selected.length,
    bytes: sumBytes(selected),
  };
}

function summarizePhase(records: WireFrameRecord[], phase: WirePhase) {
  const selected = records.filter((record) => record.phase === phase);
  return {
    frames: selected.length,
    bytes: sumBytes(selected),
    byType: summarizeByType(selected),
    rpcCounts: summarizeRpcCounts(selected),
    rpcs: summarizeRpcs(selected),
  };
}

function summarizeByType(records: WireFrameRecord[]): Array<{
  type: string;
  frames: number;
  bytes: number;
}> {
  const byType = new Map<string, { frames: number; bytes: number }>();
  for (const record of records) {
    const type = record.type ?? "unknown";
    const current = byType.get(type) ?? { frames: 0, bytes: 0 };
    current.frames += 1;
    current.bytes += record.bytes;
    byType.set(type, current);
  }
  return [...byType.entries()]
    .map(([type, value]) => ({ type, ...value }))
    .sort((left, right) => right.bytes - left.bytes);
}

function summarizeRpcs(records: WireFrameRecord[]): WireSummary["byPhase"][WirePhase]["rpcs"] {
  const responsesByRequestId = new Map<string, string>();
  for (const record of records) {
    if (record.direction !== "received" || !record.requestId) {
      continue;
    }
    responsesByRequestId.set(record.requestId, record.type ?? "unknown");
  }

  return records
    .filter((record) => record.direction === "sent" && record.requestId && record.type)
    .map((record) => ({
      requestType: record.type ?? "unknown",
      requestId: record.requestId ?? "",
      responseType: responsesByRequestId.get(record.requestId ?? "") ?? null,
    }));
}

function summarizeRpcCounts(
  records: WireFrameRecord[],
): Array<{ requestType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.direction !== "sent" || !record.type || !record.requestId) {
      continue;
    }
    counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([requestType, count]) => ({ requestType, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.requestType.localeCompare(right.requestType),
    );
}

function sumProviderModels(entries: ProviderSnapshotWireEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.modelCount, 0);
}

function sumProviderModes(entries: ProviderSnapshotWireEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.modeCount, 0);
}

function summarizeProviderSnapshots(
  records: WireFrameRecord[],
): WireSummary["providerSnapshotTotals"] {
  const byProvider = new Map<
    string,
    {
      phase: WirePhase;
      provider: string;
      frames: number;
      bytes: number;
      maxModels: number;
      maxModes: number;
      statuses: Set<string>;
    }
  >();

  for (const record of records) {
    if (record.direction !== "received" || !record.providerEntries) {
      continue;
    }
    for (const entry of record.providerEntries) {
      const key = `${record.phase}:${entry.provider}`;
      const current = byProvider.get(key) ?? {
        phase: record.phase,
        provider: entry.provider,
        frames: 0,
        bytes: 0,
        maxModels: 0,
        maxModes: 0,
        statuses: new Set<string>(),
      };
      current.frames += 1;
      current.bytes += entry.bytes;
      current.maxModels = Math.max(current.maxModels, entry.modelCount);
      current.maxModes = Math.max(current.maxModes, entry.modeCount);
      if (entry.status) {
        current.statuses.add(entry.status);
      }
      byProvider.set(key, current);
    }
  }

  return [...byProvider.values()]
    .map((entry) => ({
      phase: entry.phase,
      provider: entry.provider,
      frames: entry.frames,
      bytes: entry.bytes,
      maxModels: entry.maxModels,
      maxModes: entry.maxModes,
      statuses: [...entry.statuses].sort(),
    }))
    .sort((left, right) => right.bytes - left.bytes);
}

async function attachSummary(testInfo: TestInfo, summary: WireSummary): Promise<void> {
  await testInfo.attach("startup-wire-metrics.json", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
}

test.describe("ad hoc startup wire metrics", () => {
  test.skip(
    process.env.E2E_WIRE_METRICS !== "1",
    "Set E2E_WIRE_METRICS=1 to run this ad hoc measurement.",
  );

  test("measures startup hydration and workspace navigation websocket traffic", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    const monitor = new WireMonitor();
    await monitor.start(page);

    await gotoAppShell(page);
    await waitForSidebarHydration(page, 120_000);
    await expect.poll(() => monitor.hasCompletedStartupFetches(), { timeout: 120_000 }).toBe(true);
    await page.waitForTimeout(1_000);

    const workspaceTestIds = await page
      .locator('[data-testid^="sidebar-workspace-row-"]:visible')
      .evaluateAll((elements) =>
        elements
          .slice(0, 3)
          .map((element) => element.getAttribute("data-testid"))
          .filter((value): value is string => Boolean(value)),
      );

    monitor.setPhase("workspace_clicks");
    const clickedWorkspaces: WireSummary["clickedWorkspaces"] = [];
    for (const testId of workspaceTestIds) {
      const row = page.getByTestId(testId);
      if (!(await row.isVisible().catch(() => false))) {
        continue;
      }
      const beforeFrames = monitor.records.length;
      const beforeBytes = sumBytes(monitor.records);
      await row.click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      await page.waitForTimeout(1_000);
      clickedWorkspaces.push({
        testId,
        frames: monitor.records.length - beforeFrames,
        bytes: sumBytes(monitor.records) - beforeBytes,
      });
    }

    const summary = monitor.summarize(clickedWorkspaces);
    await attachSummary(testInfo, summary);
    console.log("PASEO_STARTUP_WIRE_METRICS_BEGIN");
    console.log(JSON.stringify(summary, null, 2));
    console.log("PASEO_STARTUP_WIRE_METRICS_END");

    expect(summary.byPhase.startup.byType.length).toBeGreaterThan(0);
    expect(clickedWorkspaces.length).toBeGreaterThan(0);
  });
});
