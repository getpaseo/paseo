import { expect, it } from "vitest";
import { FileEditorModel } from "../file-pane/editor/model";
import { hasLocalUpdateBlockers } from "./local-update-readiness";

it("blocks UI activation while file edits are unsaved, including write failures", async () => {
  const model = new FileEditorModel({
    file: {
      content: "original",
      hasBom: false,
      version: {
        status: "ready",
        cwd: "/tmp/editor-fixture",
        path: "file.txt",
        modifiedAt: "2026-10-14T00:00:00Z",
        size: 8,
      },
    },
    session: {
      write: async () => {
        throw new Error("disk full");
      },
    },
  });
  try {
    expect(hasLocalUpdateBlockers()).toBe(false);
    model.edit("keep these edits");
    expect(hasLocalUpdateBlockers()).toBe(true);
    await model.save();
    expect(model.getSnapshot().status).toBe("error");
    expect(hasLocalUpdateBlockers()).toBe(true);
  } finally {
    model.dispose();
  }
  expect(hasLocalUpdateBlockers()).toBe(false);
});

it("keeps activation blocked until an in-flight file write is durable", async () => {
  let finish!: (value: { status: "written"; modifiedAt: string; size: number }) => void;
  const model = new FileEditorModel({
    file: {
      content: "original",
      hasBom: false,
      version: {
        status: "ready",
        cwd: "/tmp/editor-fixture",
        path: "file.txt",
        modifiedAt: "2026-10-14T00:00:00Z",
        size: 8,
      },
    },
    session: {
      write: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  try {
    model.edit("saved change");
    const saving = model.save();
    expect(model.getSnapshot().status).toBe("saving");
    expect(hasLocalUpdateBlockers()).toBe(true);
    finish({ status: "written", modifiedAt: "2026-10-14T00:00:01Z", size: 12 });
    await saving;
    expect(hasLocalUpdateBlockers()).toBe(false);
    model.edit("unsaved change");
    model.receiveFileObservation({
      status: "missing",
      cwd: "/tmp/editor-fixture",
      path: "file.txt",
    });
    expect(model.getSnapshot().status).toBe("conflict");
    expect(hasLocalUpdateBlockers()).toBe(true);
  } finally {
    model.dispose();
  }
});
