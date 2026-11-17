import { describe, expect, test } from "vitest";
import { WindowsLineageRecorder, type WindowsProcess } from "./windows-lineage.js";

function recorderWith(
  tables: Array<WindowsProcess[] | Promise<WindowsProcess[]>>,
): WindowsLineageRecorder {
  const queue = [...tables];
  return new WindowsLineageRecorder(
    async () => {
      const next = queue.shift();
      if (!next) throw new Error("no process table left");
      return next;
    },
    (error) => {
      throw error;
    },
  );
}

const PROVIDER = { pid: 100, ppid: 1, createdMs: 1_000 };
const SHELL = { pid: 200, ppid: 100, createdMs: 2_000 };
const SERVER = { pid: 300, ppid: 200, createdMs: 3_000 };

describe("WindowsLineageRecorder", () => {
  test("finds a command whose shell exited with the provider, from what it recorded", async () => {
    const recorder = recorderWith([
      [PROVIDER], // the record `track` starts
      [PROVIDER, SHELL, SERVER], // a later record while the command runs
      [SERVER], // at release: the provider and its shell are gone
    ]);
    recorder.track(PROVIDER.pid, 900);
    await recorder.record(); // joins the record `track` started
    await recorder.record();

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([SERVER.pid]);
  });

  test("walks from the exited provider to children it was never seen with", async () => {
    const recorder = recorderWith([
      [], // the provider exited before the first record
      [SHELL, SERVER], // at release
    ]);
    recorder.track(PROVIDER.pid, 900);

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([SHELL.pid, SERVER.pid]);
  });

  test("ignores a process that reuses a recorded PID, and its children", async () => {
    const reusedShellPid = { pid: SHELL.pid, ppid: 1, createdMs: 9_000 };
    const childOfReused = { pid: 400, ppid: SHELL.pid, createdMs: 9_500 };
    const recorder = recorderWith([[PROVIDER], [PROVIDER, SHELL], [reusedShellPid, childOfReused]]);
    recorder.track(PROVIDER.pid, 900);
    await recorder.record(); // joins the record `track` started
    await recorder.record();

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([]);
  });

  test("ignores the children of a process that reuses the exited provider's PID", async () => {
    const reusedProviderPid = { pid: PROVIDER.pid, ppid: 1, createdMs: 9_000 };
    const childOfReused = { pid: 400, ppid: PROVIDER.pid, createdMs: 9_500 };
    const recorder = recorderWith([[PROVIDER], [reusedProviderPid, childOfReused]]);
    recorder.track(PROVIDER.pid, 900);
    await recorder.record(); // joins the record `track` started

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([]);
  });

  test("ignores the children of a process that reuses the PID before any record", async () => {
    const reusedProviderPid = { pid: PROVIDER.pid, ppid: 1, createdMs: 9_000 };
    const childOfReused = { pid: 400, ppid: PROVIDER.pid, createdMs: 9_500 };
    const recorder = recorderWith([[], [reusedProviderPid, childOfReused]]);
    recorder.track(PROVIDER.pid, 900);

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([]);
  });

  test("does not take a reused PID for the provider when the first record ends after exit", async () => {
    const reusedProviderPid = { pid: PROVIDER.pid, ppid: 1, createdMs: 9_000 };
    const childOfReused = { pid: 400, ppid: PROVIDER.pid, createdMs: 9_500 };
    let finishQuery!: (table: WindowsProcess[]) => void;
    const firstQuery = new Promise<WindowsProcess[]>((resolve) => {
      finishQuery = resolve;
    });
    const recorder = recorderWith([firstQuery, [reusedProviderPid, childOfReused]]);
    recorder.track(PROVIDER.pid, 900);

    // The provider exits while the first record is still querying; the query then sees a
    // newer process under its PID.
    const released = recorder.release(PROVIDER.pid);
    finishQuery([reusedProviderPid, childOfReused]);

    await expect(released).resolves.toEqual([]);
  });

  test("keeps what a record still querying when the provider exits finds", async () => {
    let finishQuery!: (table: WindowsProcess[]) => void;
    const slowQuery = new Promise<WindowsProcess[]>((resolve) => {
      finishQuery = resolve;
    });
    const recorder = recorderWith([[PROVIDER], slowQuery, [SERVER]]);
    recorder.track(PROVIDER.pid, 900);
    await recorder.record(); // joins the record `track` started
    const recording = recorder.record();

    const released = recorder.release(PROVIDER.pid);
    finishQuery([PROVIDER, SHELL, SERVER]);
    await recording;

    await expect(released).resolves.toEqual([SERVER.pid]);
  });

  test("ignores a process naming the provider's PID as parent but started before it", async () => {
    const older = { pid: 500, ppid: PROVIDER.pid, createdMs: 500 };
    const recorder = recorderWith([[PROVIDER], [older]]);
    recorder.track(PROVIDER.pid, 900);

    await expect(recorder.release(PROVIDER.pid)).resolves.toEqual([]);
  });
});
