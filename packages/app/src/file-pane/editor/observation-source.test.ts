import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, test } from "vitest";
import type { LiveFileObservation } from "../live-file/model";
import { createFileObservationSource, type LiveObservationSource } from "./observation-source";

class TestLiveObservationSource implements LiveObservationSource {
  observation: LiveFileObservation | null;

  constructor(observation: LiveFileObservation | null) {
    this.observation = observation;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  getObservation(): LiveFileObservation | null {
    return this.observation;
  }

  refresh(): void {}
}

function readyObservation(): LiveFileObservation {
  const file: FileReadResult = {
    bytes: new TextEncoder().encode("one"),
    mime: "text/plain",
    size: 3,
    path: "file.ts",
    kind: "text",
    modifiedAt: "2026-07-18T00:00:00.000Z",
    revision: "revision-1",
  };
  return {
    status: "ready",
    file,
    version: {
      status: "ready",
      cwd: "/workspace",
      path: "file.ts",
      size: file.size,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    },
  };
}

describe("createFileObservationSource", () => {
  test("returns the same editor observation until the live observation changes", () => {
    const liveFile = new TestLiveObservationSource(readyObservation());
    const source = createFileObservationSource(liveFile);

    const first = source.getObservation();
    const repeated = source.getObservation();

    expect(repeated).toBe(first);
    liveFile.observation = readyObservation();
    expect(source.getObservation()).not.toBe(first);
  });
});
