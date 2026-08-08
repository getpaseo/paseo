import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terminal as HeadlessTerminal, type IBufferCell, type IBufferLine } from "@xterm/headless";
import { expect, test } from "vitest";

import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";
import { renderTerminalSnapshotToAnsi } from "@getpaseo/protocol/terminal-snapshot";
import type { TerminalStreamEvent } from "@getpaseo/client/internal/terminal-stream-router";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const BYTE_DONE_MARKER = "__PASEO_BYTE_PACKAGE_LOCK_DONE__";
const BYTE_TEST_SIZE = { rows: 24, cols: 100 };

interface PackageLockTerminalCwd {
  path: string;
  gatePath: string;
}

interface CreatedTerminal {
  id: string;
}

test("byte-stream headless terminal matches daemon state after high-output attach and restore", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.96",
    clientType: "mobile",
  });
  const terminalCwd = await createPackageLockTerminalCwd();

  try {
    await client.connect();
    const terminal = await createPackageLockTerminal({
      client,
      cwd: terminalCwd.path,
      gatePath: terminalCwd.gatePath,
    });
    const liveHeadless = new ClientHeadlessTerminal(BYTE_TEST_SIZE);
    const stopLive = pipeTerminalStreamToHeadless({
      client,
      terminalId: terminal.id,
      headless: liveHeadless,
    });
    const initialSnapshot = waitForTerminalStreamEvent(client, terminal.id, "snapshot");

    await subscribeTerminal(client, terminal.id);
    await initialSnapshot;
    client.sendTerminalInput(terminal.id, { type: "resize", ...BYTE_TEST_SIZE });
    liveHeadless.resize(BYTE_TEST_SIZE);

    await startPackageLockOutput(terminalCwd.gatePath);
    const capturedViewport = await waitForCapturedViewport({
      client,
      terminalId: terminal.id,
      text: BYTE_DONE_MARKER,
      rows: BYTE_TEST_SIZE.rows,
    });
    const daemonSnapshot = await readTerminalSnapshot({
      port: daemon.port,
      terminalId: terminal.id,
    });
    await liveHeadless.flush();

    expect(liveHeadless.visibleLines()).toEqual(visibleTerminalLines(daemonSnapshot));
    expect(liveHeadless.cursor()).toEqual(daemonSnapshot.cursor);
    expect(liveHeadless.visibleLines()).toEqual(capturedViewport.lines);

    client.unsubscribeTerminal(terminal.id);
    stopLive();

    const restoreHeadless = new ClientHeadlessTerminal(BYTE_TEST_SIZE);
    const stopRestore = pipeTerminalStreamToHeadless({
      client,
      terminalId: terminal.id,
      headless: restoreHeadless,
    });
    const restoreFrame = waitForTerminalStreamEvent(client, terminal.id, "restore");

    await subscribeTerminal(client, terminal.id, {
      restore: { mode: "visible-snapshot", scrollbackLines: 200, size: BYTE_TEST_SIZE },
    });
    await restoreFrame;
    await restoreHeadless.flush();

    expect(restoreHeadless.visibleLines()).toEqual(capturedViewport.lines);
    expect(restoreHeadless.cursor()).toEqual(daemonSnapshot.cursor);
    stopRestore();
  } finally {
    await client.close();
    await daemon.close();
    await rm(terminalCwd.path, { recursive: true, force: true });
  }
}, 30_000);

class ClientHeadlessTerminal {
  private readonly terminal: HeadlessTerminal;
  private readonly decoder = new TextDecoder();
  private pendingWrite = Promise.resolve();

  constructor(input: { rows: number; cols: number }) {
    this.terminal = new HeadlessTerminal({
      rows: input.rows,
      cols: input.cols,
      scrollback: 10_000,
      allowProposedApi: true,
    });
  }

  resize(input: { rows: number; cols: number }): void {
    this.terminal.resize(input.cols, input.rows);
  }

  applyEvent(event: TerminalStreamEvent): void {
    if (event.type === "snapshot") {
      this.enqueueText(renderTerminalSnapshotToAnsi(event.state), { resetDecoder: true });
      return;
    }
    if (event.type === "restore") {
      this.enqueueText(this.decoder.decode(event.data, { stream: false }), { resetDecoder: true });
      return;
    }
    this.enqueueText(this.decoder.decode(event.data, { stream: true }));
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  visibleLines(): string[] {
    const baseY = this.terminal.buffer.active.baseY;
    const cell = this.terminal.buffer.active.getNullCell();
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      lines.push(bufferLineText(this.terminal.buffer.active.getLine(baseY + row), cell));
    }
    return lines;
  }

  cursor(): TerminalState["cursor"] {
    return {
      row: this.terminal.buffer.active.cursorY,
      col: this.terminal.buffer.active.cursorX,
    };
  }

  private enqueueText(text: string, options?: { resetDecoder?: boolean }): void {
    if (options?.resetDecoder) {
      this.decoder.decode();
      this.terminal.reset();
    }
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(text, () => resolve());
        }),
    );
  }
}

function pipeTerminalStreamToHeadless(input: {
  client: DaemonClient;
  terminalId: string;
  headless: ClientHeadlessTerminal;
}): () => void {
  return input.client.onTerminalStreamEvent((event) => {
    if (event.terminalId !== input.terminalId) {
      return;
    }
    input.headless.applyEvent(event);
  });
}

async function subscribeTerminal(
  client: DaemonClient,
  terminalId: string,
  options?: Parameters<DaemonClient["subscribeTerminal"]>[1],
): Promise<void> {
  const response = await client.subscribeTerminal(terminalId, options);
  if (response.error) {
    throw new Error(response.error);
  }
}

async function readTerminalSnapshot(input: {
  port: number;
  terminalId: string;
}): Promise<TerminalState> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${input.port}/ws`,
    appVersion: "0.1.96",
    clientType: "mobile",
  });
  try {
    await client.connect();
    const snapshot = waitForTerminalStreamEvent(client, input.terminalId, "snapshot");
    await subscribeTerminal(client, input.terminalId);
    const event = await snapshot;
    return event.state;
  } finally {
    await client.close();
  }
}

function waitForTerminalStreamEvent<TType extends TerminalStreamEvent["type"]>(
  client: DaemonClient,
  terminalId: string,
  type: TType,
): Promise<Extract<TerminalStreamEvent, { type: TType }>> {
  return client.waitForTerminalStreamEvent(
    (event) => event.terminalId === terminalId && event.type === type,
    10_000,
  ) as Promise<Extract<TerminalStreamEvent, { type: TType }>>;
}

async function createPackageLockTerminalCwd(): Promise<PackageLockTerminalCwd> {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-byte-package-lock-"));
  return {
    path: cwd,
    gatePath: path.join(cwd, "start-package-lock-output"),
  };
}

async function createPackageLockTerminal(input: {
  client: DaemonClient;
  cwd: string;
  gatePath: string;
}): Promise<CreatedTerminal> {
  const opened = await input.client.openProject(input.cwd);
  if (!opened.workspace) {
    throw new Error(opened.error ?? `Failed to open workspace for ${input.cwd}`);
  }

  const response = await input.client.createTerminal(input.cwd, "byte-package-lock", undefined, {
    command: process.execPath,
    args: [
      "-e",
      packageLockStreamScript(),
      repoPackageLockPath(),
      input.gatePath,
      BYTE_DONE_MARKER,
    ],
    workspaceId: opened.workspace.id,
  });
  if (response.error || !response.terminal) {
    throw new Error(response.error ?? "Terminal was not created");
  }
  return { id: response.terminal.id };
}

async function startPackageLockOutput(gatePath: string): Promise<void> {
  await writeFile(gatePath, "go");
}

async function waitForCapturedViewport(input: {
  client: DaemonClient;
  terminalId: string;
  text: string;
  rows: number;
}): Promise<{ lines: string[] }> {
  return waitForCondition(async () => {
    const capture = await input.client.captureTerminal(input.terminalId, {
      start: -input.rows,
      stripAnsi: true,
    });
    return capture.lines.join("\n").includes(input.text) ? { lines: capture.lines } : null;
  }, 15_000);
}

async function waitForCondition<T>(
  predicate: () => Promise<T | null> | T | null,
  timeoutMs: number,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for terminal byte parity`);
}

function visibleTerminalLines(state: TerminalState): string[] {
  return state.grid.map(terminalRowText);
}

function terminalRowText(row: TerminalState["grid"][number]): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

function bufferLineText(line: IBufferLine | undefined, reusableCell: IBufferCell): string {
  const cells: TerminalCell[] = [];
  for (let col = 0; col < BYTE_TEST_SIZE.cols; col += 1) {
    const cell = line?.getCell(col, reusableCell);
    cells.push({ char: cell?.getChars() || " " });
  }
  return terminalRowText(cells);
}

function packageLockStreamScript(): string {
  return `
const fs = require("node:fs");
const packageLockPath = process.argv[1];
const gatePath = process.argv[2];
const marker = process.argv[3];

function waitForGate() {
  if (!fs.existsSync(gatePath)) {
    setTimeout(waitForGate, 10);
    return;
  }
  process.stdout.write(fs.readFileSync(packageLockPath, "utf8"));
  process.stdout.write("\\n" + marker + "\\n");
}

waitForGate();
setInterval(() => {}, 1000);
`;
}

function repoPackageLockPath(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let current = start;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "package-lock.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not find package-lock.json from ${start}`);
}
