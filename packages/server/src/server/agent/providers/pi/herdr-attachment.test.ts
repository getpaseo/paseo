import { describe, expect, test } from "vitest";

import {
  HERDR_ATTACHED_PI_RUNTIME,
  encodeHerdrAttachedPiHandle,
  parseHerdrAttachedPiHandle,
  parseHerdrAttachedPiMetadata,
  validateHerdrAttachedPiTarget,
} from "./herdr-attachment.js";

describe("Herdr attached Pi identity", () => {
  const attachment = {
    runtime: HERDR_ATTACHED_PI_RUNTIME,
    herdrSession: "fm-lab-session",
    herdrTarget: "firstmate",
    herdrAlias: "firstmate",
    herdrPaneId: "%7",
    nativeSessionId: "native-pi-session",
    nativeSessionFile: "/tmp/pi/native.jsonl",
    cwd: "/workspace/project",
  } as const;

  test("round-trips provider handles and persistence metadata", () => {
    const handle = encodeHerdrAttachedPiHandle(attachment);

    expect(parseHerdrAttachedPiHandle(handle)).toEqual(attachment);
    expect(
      parseHerdrAttachedPiMetadata({ ...attachment, lastSyncedNativeEntryId: "entry-2" }),
    ).toEqual({ ...attachment, lastSyncedNativeEntryId: "entry-2" });
  });

  test("keeps the provider handle stable when the history cursor advances", () => {
    expect(encodeHerdrAttachedPiHandle({ ...attachment, lastSyncedNativeEntryId: "entry-2" })).toBe(
      encodeHerdrAttachedPiHandle(attachment),
    );
  });

  test("accepts the same Pi target identity", () => {
    expect(
      validateHerdrAttachedPiTarget(attachment, {
        target: "firstmate",
        kind: "pi",
        status: "idle",
        cwd: "/workspace/project",
        paneId: "%7",
        nativeSessionId: "native-pi-session",
        nativeSessionFile: "/tmp/pi/native.jsonl",
        lastActivityAt: null,
      }),
    ).toEqual({ ok: true });
  });

  test("refuses a changed native Pi session", () => {
    expect(
      validateHerdrAttachedPiTarget(attachment, {
        target: "firstmate",
        kind: "pi",
        status: "idle",
        cwd: "/workspace/project",
        paneId: "%7",
        nativeSessionId: "replacement-session",
        nativeSessionFile: "/tmp/pi/native.jsonl",
        lastActivityAt: null,
      }),
    ).toEqual({ ok: false, reason: "Native Pi session changed for Herdr target firstmate" });
  });

  test("refuses a non-Pi target", () => {
    expect(
      validateHerdrAttachedPiTarget(attachment, {
        target: "firstmate",
        kind: "claude",
        status: "idle",
        cwd: "/workspace/project",
        paneId: "%7",
        nativeSessionId: "native-pi-session",
        nativeSessionFile: "/tmp/pi/native.jsonl",
        lastActivityAt: null,
      }),
    ).toEqual({ ok: false, reason: "Herdr target firstmate is not a Pi agent" });
  });
});
