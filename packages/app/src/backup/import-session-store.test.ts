import { afterEach, describe, expect, it } from "vitest";
import type { ParsedBackup } from "./bundle";
import { useImportSessionStore } from "./import-session-store";

const backup: ParsedBackup = {
  createdAt: "2026-10-28T00:00:00.000Z",
  device: {},
  hosts: [],
  unreadable: [],
};

afterEach(() => useImportSessionStore.getState().close());

describe("import session store", () => {
  it("keeps the results of the open session", () => {
    useImportSessionStore.getState().open(backup);
    const { key } = useImportSessionStore.getState().session!;

    useImportSessionStore.getState().setStep(key, { kind: "results", results: [], reenter: [] });

    expect(useImportSessionStore.getState().session?.step).toEqual({
      kind: "results",
      results: [],
      reenter: [],
    });
  });

  it("drops a step written for a session that a newer import replaced", () => {
    useImportSessionStore.getState().open(backup);
    const staleKey = useImportSessionStore.getState().session!.key;
    useImportSessionStore.getState().open(backup);

    useImportSessionStore.getState().setStep(staleKey, { kind: "applying" });

    expect(useImportSessionStore.getState().session?.step).toEqual({ kind: "choose" });
  });

  it("keeps the edits of the open session", () => {
    useImportSessionStore.getState().open(backup);
    const { key } = useImportSessionStore.getState().session!;

    useImportSessionStore
      .getState()
      .updateEdits(key, (edits) => ({ ...edits, device: ["appSettings"], targets: { srv: null } }));

    expect(useImportSessionStore.getState().session?.edits).toEqual({
      device: ["appSettings"],
      targets: { srv: null },
      choices: {},
    });
  });

  it("drops edits written for a session that a newer import replaced", () => {
    useImportSessionStore.getState().open(backup);
    const staleKey = useImportSessionStore.getState().session!.key;
    useImportSessionStore.getState().open(backup);

    useImportSessionStore.getState().updateEdits(staleKey, (edits) => ({ ...edits, device: [] }));

    expect(useImportSessionStore.getState().session?.edits).toEqual({ targets: {}, choices: {} });
  });
});
